import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { AppError } from '@ai-orchestrator/shared';
import type { BuildServerOptions } from './types.js';
import { TaskService } from './services/task-service.js';
import { FeatureService } from './services/feature-service.js';
import { ImportService } from './services/import-service.js';
import { RunService } from './services/run-service.js';
import { TaskScheduler } from './services/task-scheduler.js';
import { PlannerService } from './services/planner-service.js';
import { QualityConfigService } from './services/quality-config-service.js';
import { QualityRunner } from './services/quality-runner.js';
import { ScopeDiffService } from './services/scope-diff-service.js';
import { ReviewerService } from './services/reviewer-service.js';
import { SecurityCheckService } from './services/security-check-service.js';
import { RepairLoopService } from './services/repair-loop-service.js';
import { QualityGateService } from './services/quality-gate-service.js';
import { createExecutionManager } from './adapters/execution-manager.js';
import { healthRoutes } from './routes/health.js';
import { taskRoutes } from './routes/tasks.js';
import { featureRoutes } from './routes/features.js';
import { importRoutes } from './routes/import.js';
import { runRoutes } from './routes/runs.js';
import { schedulerRoutes } from './routes/scheduler.js';
import { planRoutes } from './routes/plans.js';
import { qualityRoutes } from './routes/quality.js';

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { db, logger = false } = options;

  const server = Fastify({
    logger,
  });

  // Register multipart plugin for file uploads
  await server.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB max file size
    },
  });

  // Centralized Error Handler
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      let statusCode: number;
      switch (error.code) {
        case 'TASK_NOT_FOUND':
        case 'FEATURE_NOT_FOUND':
        case 'RUN_NOT_FOUND':
        case 'FILE_NOT_FOUND':
        case 'PLAN_NOT_FOUND':
        case 'QUALITY_RECORD_NOT_FOUND':
        case 'REPAIR_LOOP_NOT_FOUND':
        case 'QUALITY_GATE_NOT_FOUND':
        case 'FEATURE_BRANCH_NOT_FOUND':
          statusCode = 404;
          break;
        case 'FEATURE_RELEASE_BLOCKED':
          statusCode = 422;
          break;
        case 'TASK_ALREADY_EXISTS':
        case 'FEATURE_ALREADY_EXISTS':
        case 'DUPLICATE_TASK_ID':
        case 'DUPLICATE_FEATURE_ID':
        case 'DUPLICATE_PLAN_ID':
        case 'CONCURRENCY_LIMIT_EXCEEDED':
        case 'AGENT_LOCK_HELD':
        case 'AGENT_BUSY':
        case 'SCHEDULER_LOCKED':
        case 'BRANCH_ALREADY_EXISTS':
        case 'REPO_DIRTY':
          statusCode = 409;
          break;
        case 'PLAN_SPAWN_ERROR':
        case 'PLAN_GENERATION_FAILED':
        case 'REVIEWER_SPAWN_ERROR':
        case 'REVIEWER_EXECUTION_FAILED':
        case 'DATABASE_NOT_CONFIGURED':
          statusCode = 500;
          break;
        case 'VALIDATION_ERROR':
        case 'INVALID_REVIEW_FINDINGS':
        case 'INVALID_REVIEW_SCHEMA':
        case 'CIRCULAR_DEPENDENCY_ERROR':
        case 'FOREIGN_KEY_VIOLATION':
        case 'SELF_DEPENDENCY_ERROR':
        case 'ILLEGAL_STATE_TRANSITION':
        case 'MAX_ATTEMPTS_EXCEEDED':
        case 'INVALID_RETRY_CONFIG':
        case 'IMPORT_VALIDATION_FAILED':
        case 'WORKBOOK_VALIDATION_ERROR':
        case 'INVALID_INPUT':
        case 'MISSING_SHEET':
        case 'UNSUPPORTED_FILE_TYPE':
        case 'EMPTY_WORKBOOK':
        case 'UNREGISTERED_REPOSITORY':
        case 'INVALID_WORKING_DIRECTORY':
        case 'INVALID_PAYLOAD':
        case 'INVALID_PLAN_SCHEMA':
        case 'PLAN_DEPENDENCY_CYCLE':
        case 'PLAN_MISSING_DEPENDENCY':
        case 'PLAN_NOT_APPROVED':
        case 'INVALID_PLAN_STATE_TRANSITION':
        case 'INVALID_QUALITY_COMMAND':
        case 'INVALID_COMMAND':
        case 'INVALID_QUALITY_CONFIG_FILE':
        case 'INVALID_PACKAGE_JSON':
        case 'PATH_NOT_FOUND':
        case 'NOT_A_DIRECTORY':
        case 'INVALID_BRANCH_NAME':
        case 'BASE_REF_NOT_FOUND':
          statusCode = 400;
          break;
        default:
          statusCode = 400;
      }

      return reply.status(statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          context: error.context ?? {},
        },
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          context: {
            issues: error.issues,
          },
        },
      });
    }

    const err = error as { message?: string; validation?: unknown; statusCode?: number };

    // Fastify schema validation errors
    if (err.validation) {
      return reply.status(400).send({
        error: {
          code: 'REQUEST_VALIDATION_ERROR',
          message: err.message ?? 'Invalid request payload',
          context: {
            validation: err.validation,
          },
        },
      });
    }

    // Generic unhandled error
    server.log.error(error);
    const message = err.message || 'An unexpected internal error occurred';
    return reply.status(err.statusCode ?? 500).send({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message,
        context: {},
      },
    });
  });

  // Instantiate services
  const taskService = new TaskService(db);
  const featureService = options.featureService ?? new FeatureService(db);
  const importService = new ImportService(db);

  const executionManager =
    options.executionManager ??
    createExecutionManager({ repositoryRegistry: options.repositoryRegistry });
  const runService = new RunService({
    db,
    executionManager,
    repositoryRegistry: options.repositoryRegistry,
    config: options.config,
  });

  const taskScheduler =
    options.taskScheduler ??
    new TaskScheduler({
      db,
      runService,
    });

  const plannerService =
    options.plannerService ??
    new PlannerService({
      db,
      repositoryRegistry: options.repositoryRegistry,
      config: options.config,
      taskScheduler,
    });

  const qualityConfigService =
    options.qualityConfigService ??
    new QualityConfigService({
      repositoryRegistry: options.repositoryRegistry,
      db,
    });

  const qualityRunner =
    options.qualityRunner ??
    new QualityRunner({
      db,
      qualityConfigService,
    });

  const scopeDiffService =
    options.scopeDiffService ??
    new ScopeDiffService({
      db,
      repositoryRegistry: options.repositoryRegistry,
    });

  const reviewerService =
    options.reviewerService ??
    new ReviewerService({
      db,
      repositoryRegistry: options.repositoryRegistry,
      scopeDiffService,
      config: options.config,
    });

  const securityCheckService =
    options.securityCheckService ??
    new SecurityCheckService({
      db,
      repositoryRegistry: options.repositoryRegistry,
      qualityCheckRepo: qualityRunner ? undefined : undefined,
    });

  const repairLoopService =
    options.repairLoopService ??
    new RepairLoopService({
      db,
      qualityRunner,
      reviewerService,
      config: options.config,
    });

  const qualityGateService =
    options.qualityGateService ??
    new QualityGateService({
      db,
      qualityRunner,
      scopeDiffService,
      reviewerService,
      securityCheckService,
      qualityConfigService,
    });

  // Register routes
  await server.register(healthRoutes);
  await server.register(taskRoutes, { taskService });
  await server.register(featureRoutes, { featureService });
  await server.register(importRoutes, { importService });
  await server.register(runRoutes, { runService });
  await server.register(schedulerRoutes, { scheduler: taskScheduler });
  await server.register(planRoutes, { plannerService });
  await server.register(qualityRoutes, {
    qualityConfigService,
    qualityRunner,
    scopeDiffService,
    reviewerService,
    securityCheckService,
    repairLoopService,
    qualityGateService,
  });

  return server;
}
