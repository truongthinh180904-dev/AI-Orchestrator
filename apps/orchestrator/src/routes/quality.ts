import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  RepoQualityConfigInputSchema,
  QualityCommandInputSchema,
  QualityStageSchema,
  QualityCommandStatusSchema,
  type QualityCommandDefinition,
  normalizeQualityCommand,
  type ParsedConfig,
  CompareScopeInputSchema,
  ReviewDiffInputSchema,
  FindingSeveritySchema,
  AppError,
} from '@ai-orchestrator/shared';
import type { QualityConfigService } from '../services/quality-config-service.js';
import type { QualityRunner } from '../services/quality-runner.js';
import type { ScopeDiffService } from '../services/scope-diff-service.js';
import type { ReviewerService } from '../services/reviewer-service.js';
import type { SecurityCheckService } from '../services/security-check-service.js';
import type { RepairLoopService } from '../services/repair-loop-service.js';

export interface QualityRoutesOptions {
  qualityConfigService: QualityConfigService;
  qualityRunner: QualityRunner;
  scopeDiffService?: ScopeDiffService;
  reviewerService?: ReviewerService;
  securityCheckService?: SecurityCheckService;
  repairLoopService?: RepairLoopService;
}

const RepoParamsSchema = z.object({
  id: z.string().min(1, 'Repository ID or path is required'),
});

const TaskParamsSchema = z.object({
  id: z.string().min(1, 'Task ID is required'),
});

const RunParamsSchema = z.object({
  id: z.string().min(1, 'Run ID is required'),
});

const RecordParamsSchema = z.object({
  id: z.string().min(1, 'Record ID is required'),
});

const ResolveQualityBodySchema = z.object({
  repoId: z.string().optional(),
  repoPath: z.string().optional(),
  taskTestCommands: z.array(z.string()).optional(),
  overrides: RepoQualityConfigInputSchema.optional(),
  workbookConfig: z.record(z.string(), z.unknown()).optional(),
});

const RunQualityPipelineBodySchema = z.object({
  repoId: z.string().optional(),
  repoPath: z.string().optional(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  stopOnFirstFailure: z.boolean().optional(),
  commands: z.array(QualityCommandInputSchema).optional(),
});

const QualityRecordQuerySchema = z.object({
  taskId: z.string().optional(),
  runId: z.string().optional(),
  stage: QualityStageSchema.optional(),
  status: QualityCommandStatusSchema.optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const TaskScopeQuerySchema = z.object({
  baseRef: z.string().optional(),
  targetRef: z.string().optional(),
  includeUntracked: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined) return true;
      if (typeof val === 'boolean') return val;
      return val === 'true' || val === '1';
    }),
  runId: z.string().optional(),
});

const ValidateReviewBodySchema = z.object({
  output: z.string().min(1, 'Review output string is required'),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  reviewerType: z.string().optional(),
});

const TaskReviewBodySchema = z.object({
  runId: z.string().optional(),
  repoPath: z.string().optional(),
  baseRef: z.string().optional(),
  targetRef: z.string().optional(),
  customPrompt: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  command: z
    .object({
      exe: z.string().optional(),
      args: z.array(z.string()).optional(),
    })
    .optional(),
});

const FindingQuerySchema = z.object({
  taskId: z.string().optional(),
  runId: z.string().optional(),
  severity: FindingSeveritySchema.optional(),
  file: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const SecurityCheckBodySchema = z.object({
  repoPath: z.string().optional(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  scanner: z.enum(['auto', 'gitleaks', 'builtin', 'both']).optional(),
  auditLevel: z.enum(['info', 'low', 'moderate', 'high', 'critical']).optional(),
  diffContent: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const SecurityCheckQuerySchema = z.object({
  taskId: z.string().optional(),
  runId: z.string().optional(),
  passed: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined) return undefined;
      if (typeof val === 'boolean') return val;
      return val === 'true' || val === '1';
    }),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const AuditBodySchema = z.object({
  repoPath: z.string().optional(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  auditLevel: z.enum(['info', 'low', 'moderate', 'high', 'critical']).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const SecretScanBodySchema = z.object({
  repoPath: z.string().optional(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  scanner: z.enum(['auto', 'gitleaks', 'builtin', 'both']).optional(),
  diffContent: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const RepairLoopBodySchema = z.object({
  taskId: z.string().min(1, 'taskId is required'),
  runId: z.string().optional(),
  repoPath: z.string().optional(),
  maxIterations: z.number().int().positive().optional(),
  autoTransitionTask: z.boolean().optional(),
  customPrompt: z.string().optional(),
});

const TaskRepairBodySchema = z.object({
  runId: z.string().optional(),
  repoPath: z.string().optional(),
  maxIterations: z.number().int().positive().optional(),
  autoTransitionTask: z.boolean().optional(),
  customPrompt: z.string().optional(),
});

const LoopParamsSchema = z.object({
  id: z.string().min(1, 'Loop ID is required'),
});

export const qualityRoutes: FastifyPluginAsync<QualityRoutesOptions> = async (fastify, opts) => {
  const {
    qualityConfigService,
    qualityRunner,
    scopeDiffService,
    reviewerService,
    securityCheckService,
    repairLoopService,
  } = opts;

  // GET /repos/:id/quality-config & /api/repos/:id/quality-config
  const handleGetRepoQualityConfig = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const params = RepoParamsSchema.parse(request.params);
    const config = qualityConfigService.getConfigForRepo(params.id);
    return reply.send({ data: config });
  };

  fastify.get('/repos/:id/quality-config', handleGetRepoQualityConfig);
  fastify.get('/api/repos/:id/quality-config', handleGetRepoQualityConfig);

  // GET /tasks/:id/quality-config & /api/tasks/:id/quality-config
  const handleGetTaskQualityConfig = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const params = TaskParamsSchema.parse(request.params);
    const config = qualityConfigService.getConfigForTask(params.id);
    return reply.send({ data: config });
  };

  fastify.get('/tasks/:id/quality-config', handleGetTaskQualityConfig);
  fastify.get('/api/tasks/:id/quality-config', handleGetTaskQualityConfig);

  // POST /quality/resolve & /api/quality/resolve
  const handleResolveQualityConfig = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = ResolveQualityBodySchema.parse(request.body ?? {});
    const config = qualityConfigService.resolveConfig({
      repoId: body.repoId,
      repoPath: body.repoPath,
      taskTestCommands: body.taskTestCommands,
      overrides: body.overrides,
      workbookConfig: body.workbookConfig as unknown as ParsedConfig | undefined,
    });
    return reply.send({ data: config });
  };

  fastify.post('/quality/resolve', handleResolveQualityConfig);
  fastify.post('/api/quality/resolve', handleResolveQualityConfig);

  // PUT /repos/:id/quality-config & /api/repos/:id/quality-config
  const handleUpdateRepoQualityConfig = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const params = RepoParamsSchema.parse(request.params);
    const body = RepoQualityConfigInputSchema.parse(request.body);
    const config = qualityConfigService.saveRepoQualityConfig(params.id, body);
    return reply.send({ data: config });
  };

  fastify.put('/repos/:id/quality-config', handleUpdateRepoQualityConfig);
  fastify.put('/api/repos/:id/quality-config', handleUpdateRepoQualityConfig);

  // POST /quality/run & /api/quality/run
  const handleRunQualityPipeline = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const body = RunQualityPipelineBodySchema.parse(request.body ?? {});

    let result;
    if (body.commands && body.commands.length > 0) {
      const cwd = body.repoPath ?? (body.repoId ? qualityConfigService.resolveRepoPath(body.repoId).repoPath : process.cwd());
      const normalizedCommands = body.commands
        .map((cmd) =>
          normalizeQualityCommand('custom', cmd, {
            cwd,
          }),
        )
        .filter((cmd): cmd is QualityCommandDefinition => cmd !== null);
      result = await qualityRunner.runPipeline(normalizedCommands, {
        taskId: body.taskId,
        runId: body.runId,
        repoPath: cwd,
        stopOnFirstFailure: body.stopOnFirstFailure,
      });
    } else if (body.taskId) {
      result = await qualityRunner.runForTask(body.taskId, {
        runId: body.runId,
        stopOnFirstFailure: body.stopOnFirstFailure,
      });
    } else {
      const target = body.repoId ?? body.repoPath ?? '.';
      result = await qualityRunner.runForRepo(target, {
        taskId: body.taskId,
        runId: body.runId,
        stopOnFirstFailure: body.stopOnFirstFailure,
      });
    }

    return reply.send({ data: result });
  };

  fastify.post('/quality/run', handleRunQualityPipeline);
  fastify.post('/api/quality/run', handleRunQualityPipeline);

  // GET /quality/records & /api/quality/records
  const handleGetQualityRecords = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const query = QualityRecordQuerySchema.parse(request.query ?? {});
    const records = qualityRunner.findRecords({
      task_id: query.taskId,
      run_id: query.runId,
      stage: query.stage,
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });
    return reply.send({ data: records });
  };

  fastify.get('/quality/records', handleGetQualityRecords);
  fastify.get('/api/quality/records', handleGetQualityRecords);

  // GET /quality/records/:id & /api/quality/records/:id
  const handleGetQualityRecordById = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const params = RecordParamsSchema.parse(request.params);
    const record = qualityRunner.getRecord(params.id);
    if (!record) {
      throw new AppError('QUALITY_RECORD_NOT_FOUND', `Quality record not found: ${params.id}`, {
        id: params.id,
      });
    }
    return reply.send({ data: record });
  };

  fastify.get('/quality/records/:id', handleGetQualityRecordById);
  fastify.get('/api/quality/records/:id', handleGetQualityRecordById);

  // GET /tasks/:id/quality-records & /api/tasks/:id/quality-records
  const handleGetTaskQualityRecords = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const params = TaskParamsSchema.parse(request.params);
    const records = qualityRunner.getRecordsForTask(params.id);
    return reply.send({ data: records });
  };

  fastify.get('/tasks/:id/quality-records', handleGetTaskQualityRecords);
  fastify.get('/api/tasks/:id/quality-records', handleGetTaskQualityRecords);

  // GET /runs/:id/quality-records & /api/runs/:id/quality-records
  const handleGetRunQualityRecords = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const params = RunParamsSchema.parse(request.params);
    const records = qualityRunner.getRecordsForRun(params.id);
    return reply.send({ data: records });
  };

  fastify.get('/runs/:id/quality-records', handleGetRunQualityRecords);
  fastify.get('/api/runs/:id/quality-records', handleGetRunQualityRecords);

  // POST /quality/scope-diff & /api/quality/scope-diff
  const handleCompareScope = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!scopeDiffService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'Scope diff service is not configured');
    }
    const body = CompareScopeInputSchema.parse(request.body ?? {});
    const result = await scopeDiffService.compareScope(body);
    return reply.send({ data: result });
  };

  fastify.post('/quality/scope-diff', handleCompareScope);
  fastify.post('/api/quality/scope-diff', handleCompareScope);

  // GET /tasks/:id/scope-diff & /api/tasks/:id/scope-diff
  const handleGetTaskScopeDiff = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!scopeDiffService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'Scope diff service is not configured');
    }
    const params = TaskParamsSchema.parse(request.params);
    const query = TaskScopeQuerySchema.parse(request.query ?? {});
    const result = await scopeDiffService.checkTaskScope(params.id, query);
    return reply.send({ data: result });
  };

  fastify.get('/tasks/:id/scope-diff', handleGetTaskScopeDiff);
  fastify.get('/api/tasks/:id/scope-diff', handleGetTaskScopeDiff);

  // GET /tasks/:id/diff & /api/tasks/:id/diff
  const handleGetTaskDiff = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!scopeDiffService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'Scope diff service is not configured');
    }
    const params = TaskParamsSchema.parse(request.params);
    const query = TaskScopeQuerySchema.parse(request.query ?? {});
    const result = await scopeDiffService.getTaskDiff(params.id, query);
    return reply.send({ data: result });
  };

  fastify.get('/tasks/:id/diff', handleGetTaskDiff);
  fastify.get('/api/tasks/:id/diff', handleGetTaskDiff);

  // POST /quality/review & /api/quality/review
  const handleReviewDiff = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!reviewerService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'Reviewer service is not configured');
    }
    const body = ReviewDiffInputSchema.parse(request.body ?? {});
    const result = await reviewerService.reviewDiff(body);
    return reply.status(200).send({ data: result });
  };

  fastify.post('/quality/review', handleReviewDiff);
  fastify.post('/api/quality/review', handleReviewDiff);

  // POST /quality/review/validate & /api/quality/review/validate
  const handleValidateReview = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!reviewerService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'Reviewer service is not configured');
    }
    const body = ValidateReviewBodySchema.parse(request.body ?? {});
    const result = reviewerService.parseAndValidateReview(body.output, {
      taskId: body.taskId,
      runId: body.runId,
      reviewerType: body.reviewerType,
    });
    return reply.status(200).send({ data: result });
  };

  fastify.post('/quality/review/validate', handleValidateReview);
  fastify.post('/api/quality/review/validate', handleValidateReview);

  // POST /tasks/:id/review & /api/tasks/:id/review
  const handleReviewTask = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!reviewerService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'Reviewer service is not configured');
    }
    const params = TaskParamsSchema.parse(request.params);
    const body = TaskReviewBodySchema.parse(request.body ?? {});
    const result = await reviewerService.reviewTask(params.id, body);
    return reply.status(200).send({ data: result });
  };

  fastify.post('/tasks/:id/review', handleReviewTask);
  fastify.post('/api/tasks/:id/review', handleReviewTask);

  // GET /quality/findings & /api/quality/findings
  const handleGetFindings = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!reviewerService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'Reviewer service is not configured');
    }
    const query = FindingQuerySchema.parse(request.query ?? {});
    const findings = reviewerService.listFindings(query);
    const total = reviewerService.countFindings(query);
    return reply.send({ data: findings, meta: { total } });
  };

  fastify.get('/quality/findings', handleGetFindings);
  fastify.get('/api/quality/findings', handleGetFindings);

  // GET /tasks/:id/review-findings & /api/tasks/:id/review-findings
  const handleGetTaskFindings = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!reviewerService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'Reviewer service is not configured');
    }
    const params = TaskParamsSchema.parse(request.params);
    const findings = reviewerService.getFindingsForTask(params.id);
    return reply.send({ data: findings });
  };

  fastify.get('/tasks/:id/review-findings', handleGetTaskFindings);
  fastify.get('/api/tasks/:id/review-findings', handleGetTaskFindings);

  // GET /runs/:id/review-findings & /api/runs/:id/review-findings
  const handleGetRunFindings = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!reviewerService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'Reviewer service is not configured');
    }
    const params = RunParamsSchema.parse(request.params);
    const findings = reviewerService.getFindingsForRun(params.id);
    return reply.send({ data: findings });
  };

  fastify.get('/runs/:id/review-findings', handleGetRunFindings);
  fastify.get('/api/runs/:id/review-findings', handleGetRunFindings);

  // POST /quality/security-check & /api/quality/security-check
  const handleRunSecurityCheck = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (!securityCheckService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'SecurityCheckService is not configured');
    }
    const body = SecurityCheckBodySchema.parse(request.body ?? {});
    const result = await securityCheckService.runSecurityCheck({
      repoPath: body.repoPath,
      taskId: body.taskId,
      runId: body.runId,
      scanner: body.scanner,
      auditLevel: body.auditLevel,
      diffContent: body.diffContent,
      timeoutMs: body.timeoutMs,
    });
    return reply.status(200).send({ data: result });
  };

  fastify.post('/quality/security-check', handleRunSecurityCheck);
  fastify.post('/api/quality/security-check', handleRunSecurityCheck);

  // GET /quality/security-checks & /api/quality/security-checks
  const handleGetSecurityChecks = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (!securityCheckService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'SecurityCheckService is not configured');
    }
    const query = SecurityCheckQuerySchema.parse(request.query ?? {});
    const records = securityCheckService.getSecurityChecks({
      task_id: query.taskId,
      run_id: query.runId,
      passed: query.passed,
      limit: query.limit,
      offset: query.offset,
    });
    return reply.send({ data: records });
  };

  fastify.get('/quality/security-checks', handleGetSecurityChecks);
  fastify.get('/api/quality/security-checks', handleGetSecurityChecks);

  // GET /quality/security-checks/:id & /api/quality/security-checks/:id
  const handleGetSecurityCheckById = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (!securityCheckService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'SecurityCheckService is not configured');
    }
    const params = RecordParamsSchema.parse(request.params);
    const record = securityCheckService.getSecurityCheckById(params.id);
    if (!record) {
      throw new AppError('RECORD_NOT_FOUND', `Security check record with id ${params.id} not found`);
    }
    return reply.send({ data: record });
  };

  fastify.get('/quality/security-checks/:id', handleGetSecurityCheckById);
  fastify.get('/api/quality/security-checks/:id', handleGetSecurityCheckById);

  // GET /quality/security-checks/:id/secrets & /api/quality/security-checks/:id/secrets
  const handleGetSecurityCheckSecrets = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (!securityCheckService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'SecurityCheckService is not configured');
    }
    const params = RecordParamsSchema.parse(request.params);
    const findings = securityCheckService.getSecretFindings(params.id);
    return reply.send({ data: findings });
  };

  fastify.get('/quality/security-checks/:id/secrets', handleGetSecurityCheckSecrets);
  fastify.get('/api/quality/security-checks/:id/secrets', handleGetSecurityCheckSecrets);

  // GET /tasks/:id/security-checks & /api/tasks/:id/security-checks
  const handleGetTaskSecurityChecks = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (!securityCheckService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'SecurityCheckService is not configured');
    }
    const params = TaskParamsSchema.parse(request.params);
    const records = securityCheckService.getSecurityChecks({ task_id: params.id });
    return reply.send({ data: records });
  };

  fastify.get('/tasks/:id/security-checks', handleGetTaskSecurityChecks);
  fastify.get('/api/tasks/:id/security-checks', handleGetTaskSecurityChecks);

  // POST /tasks/:id/security-check & /api/tasks/:id/security-check
  const handleCheckTaskSecurity = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (!securityCheckService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'SecurityCheckService is not configured');
    }
    const params = TaskParamsSchema.parse(request.params);
    const body = SecurityCheckBodySchema.parse(request.body ?? {});
    const result = await securityCheckService.checkTask(params.id, body);
    return reply.status(200).send({ data: result });
  };

  fastify.post('/tasks/:id/security-check', handleCheckTaskSecurity);
  fastify.post('/api/tasks/:id/security-check', handleCheckTaskSecurity);

  // POST /quality/audit & /api/quality/audit
  const handleRunAudit = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!securityCheckService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'SecurityCheckService is not configured');
    }
    const body = AuditBodySchema.parse(request.body ?? {});
    const result = await securityCheckService.runAudit({
      repoPath: body.repoPath,
      taskId: body.taskId,
      runId: body.runId,
      auditLevel: body.auditLevel,
      timeoutMs: body.timeoutMs,
    });
    return reply.status(200).send({ data: result });
  };

  fastify.post('/quality/audit', handleRunAudit);
  fastify.post('/api/quality/audit', handleRunAudit);

  // POST /quality/secrets/scan & /api/quality/secrets/scan
  const handleRunSecretScan = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (!securityCheckService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'SecurityCheckService is not configured');
    }
    const body = SecretScanBodySchema.parse(request.body ?? {});
    const result = await securityCheckService.runSecretScan({
      repoPath: body.repoPath,
      taskId: body.taskId,
      runId: body.runId,
      scanner: body.scanner,
      diffContent: body.diffContent,
      timeoutMs: body.timeoutMs,
    });
    return reply.status(200).send({ data: result });
  };

  fastify.post('/quality/secrets/scan', handleRunSecretScan);
  fastify.post('/api/quality/secrets/scan', handleRunSecretScan);

  // POST /quality/repair-loop & /api/quality/repair-loop
  const handleRunRepairLoop = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!repairLoopService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'RepairLoopService is not configured');
    }
    const body = RepairLoopBodySchema.parse(request.body ?? {});
    const result = await repairLoopService.runRepairCycle({
      taskId: body.taskId,
      runId: body.runId,
      repoPath: body.repoPath,
      maxIterations: body.maxIterations,
      autoTransitionTask: body.autoTransitionTask,
      customPrompt: body.customPrompt,
    });
    return reply.status(200).send({ data: result });
  };

  fastify.post('/quality/repair-loop', handleRunRepairLoop);
  fastify.post('/api/quality/repair-loop', handleRunRepairLoop);

  // GET /quality/repair-loops/:id & /api/quality/repair-loops/:id
  const handleGetRepairLoopById = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (!repairLoopService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'RepairLoopService is not configured');
    }
    const params = LoopParamsSchema.parse(request.params);
    const loop = repairLoopService.getRepairLoop(params.id);
    if (!loop) {
      throw new AppError('REPAIR_LOOP_NOT_FOUND', `Repair loop '${params.id}' not found`, {
        loopId: params.id,
      });
    }
    return reply.status(200).send({ data: loop });
  };

  fastify.get('/quality/repair-loops/:id', handleGetRepairLoopById);
  fastify.get('/api/quality/repair-loops/:id', handleGetRepairLoopById);

  // GET /tasks/:id/repair-loops & /api/tasks/:id/repair-loops
  const handleGetTaskRepairLoops = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    if (!repairLoopService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'RepairLoopService is not configured');
    }
    const params = TaskParamsSchema.parse(request.params);
    const loops = repairLoopService.getLoopsForTask(params.id);
    return reply.status(200).send({ data: loops });
  };

  fastify.get('/tasks/:id/repair-loops', handleGetTaskRepairLoops);
  fastify.get('/api/tasks/:id/repair-loops', handleGetTaskRepairLoops);

  // POST /tasks/:id/repair & /api/tasks/:id/repair
  const handleTaskRepair = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!repairLoopService) {
      throw new AppError('SERVICE_UNAVAILABLE', 'RepairLoopService is not configured');
    }
    const params = TaskParamsSchema.parse(request.params);
    const body = TaskRepairBodySchema.parse(request.body ?? {});
    const result = await repairLoopService.runRepairCycle({
      taskId: params.id,
      runId: body.runId,
      repoPath: body.repoPath,
      maxIterations: body.maxIterations,
      autoTransitionTask: body.autoTransitionTask,
      customPrompt: body.customPrompt,
    });
    return reply.status(200).send({ data: result });
  };

  fastify.post('/tasks/:id/repair', handleTaskRepair);
  fastify.post('/api/tasks/:id/repair', handleTaskRepair);
};
