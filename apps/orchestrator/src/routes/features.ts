import { z } from 'zod';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { FeatureService } from '../services/feature-service.js';
import { FeatureQuerySchema, FeatureParamsSchema } from '../types.js';
import {
  DefineFeatureTasksInputSchema,
  CheckReleaseReadinessInputSchema,
  CreateFeatureBranchInputSchema,
  CommitFeatureReleaseInputSchema,
  PushFeatureReleaseInputSchema,
  ConfirmRemoteBranchInputSchema,
  AppError,
} from '@ai-orchestrator/shared';


const ReleaseCheckQuerySchema = z.object({
  execute_integration_tests: z
    .string()
    .optional()
    .transform((val) => val === 'true'),
  save_report: z
    .string()
    .optional()
    .transform((val) => (val === undefined ? true : val === 'true')),
  repo_path: z.string().optional(),
});

const ReleaseCheckBodySchema = CheckReleaseReadinessInputSchema.extend({
  assert: z.boolean().default(false),
});

const RunIntegrationTestsBodySchema = z.object({
  repoPath: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  saveReport: z.boolean().default(true),
});

export interface FeatureRoutesOptions {
  featureService: FeatureService;
}

export const featureRoutes: FastifyPluginAsync<FeatureRoutesOptions> = async (fastify, opts) => {
  const { featureService } = opts;

  // GET /features & GET /api/features
  const handleList = async (request: FastifyRequest) => {
    const filter = FeatureQuerySchema.parse(request.query ?? {});
    const features = featureService.list(filter);
    return { data: features };
  };

  fastify.get('/features', handleList);
  fastify.get('/api/features', handleList);

  // GET /features/:id & GET /api/features/:id
  const handleGetById = async (request: FastifyRequest) => {
    const params = FeatureParamsSchema.parse(request.params);
    const feature = featureService.getById(params.id);
    return { data: feature };
  };

  fastify.get('/features/:id', handleGetById);
  fastify.get('/api/features/:id', handleGetById);

  // GET /features/:id/tasks & GET /api/features/:id/tasks
  const handleGetComponentTasks = async (request: FastifyRequest) => {
    const params = FeatureParamsSchema.parse(request.params);
    const manifest = featureService.getComponentTasks(params.id);
    return { data: manifest };
  };

  fastify.get('/features/:id/tasks', handleGetComponentTasks);
  fastify.get('/api/features/:id/tasks', handleGetComponentTasks);
  fastify.get('/features/:id/manifest', handleGetComponentTasks);
  fastify.get('/api/features/:id/manifest', handleGetComponentTasks);

  // POST /features/:id/tasks & PUT /features/:id/tasks
  const handleDefineFeatureTasks = async (request: FastifyRequest) => {
    const params = FeatureParamsSchema.parse(request.params);
    const body = DefineFeatureTasksInputSchema.parse(request.body ?? {});
    const manifest = featureService.defineFeatureTasks(params.id, body);
    return { data: manifest };
  };

  fastify.post('/features/:id/tasks', handleDefineFeatureTasks);
  fastify.post('/api/features/:id/tasks', handleDefineFeatureTasks);
  fastify.put('/features/:id/tasks', handleDefineFeatureTasks);
  fastify.put('/api/features/:id/tasks', handleDefineFeatureTasks);

  // GET /features/:id/release-check & GET /api/features/:id/release-check
  const handleGetReleaseCheck = async (request: FastifyRequest) => {
    const params = FeatureParamsSchema.parse(request.params);
    const query = ReleaseCheckQuerySchema.parse(request.query ?? {});
    const result = await featureService.checkReleaseReadiness(params.id, {
      execute_integration_tests: query.execute_integration_tests,
      save_report: query.save_report,
      repo_path: query.repo_path,
    });
    return { data: result };
  };

  fastify.get('/features/:id/release-check', handleGetReleaseCheck);
  fastify.get('/api/features/:id/release-check', handleGetReleaseCheck);

  // POST /features/:id/release-check & POST /api/features/:id/release-check
  const handlePostReleaseCheck = async (request: FastifyRequest) => {
    const params = FeatureParamsSchema.parse(request.params);
    const body = ReleaseCheckBodySchema.parse(request.body ?? {});
    if (body.assert) {
      const result = await featureService.assertCanRelease(params.id, body);
      return { data: result };
    }
    const result = await featureService.checkReleaseReadiness(params.id, body);
    return { data: result };
  };

  fastify.post('/features/:id/release-check', handlePostReleaseCheck);
  fastify.post('/api/features/:id/release-check', handlePostReleaseCheck);

  // POST /features/:id/integration-tests & POST /api/features/:id/integration-tests
  const handleRunIntegrationTests = async (request: FastifyRequest) => {
    const params = FeatureParamsSchema.parse(request.params);
    const body = RunIntegrationTestsBodySchema.parse(request.body ?? {});
    const records = await featureService.runIntegrationTests(params.id, body);
    const passed = records.length > 0 && records.every((r) => r.status === 'SUCCESS');
    return {
      data: {
        feature_id: params.id,
        records,
        passed,
      },
    };
  };

  fastify.post('/features/:id/integration-tests', handleRunIntegrationTests);
  fastify.post('/api/features/:id/integration-tests', handleRunIntegrationTests);

  // POST /features/:id/branch & POST /api/features/:id/branch (REL-003)
  const handleCreateFeatureBranch = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = FeatureParamsSchema.parse(request.params);
    const body = CreateFeatureBranchInputSchema.parse(request.body ?? {});
    const result = await featureService.createFeatureBranch(params.id, body);
    return reply.status(201).send({ data: result });
  };

  fastify.post('/features/:id/branch', handleCreateFeatureBranch);
  fastify.post('/api/features/:id/branch', handleCreateFeatureBranch);

  // GET /features/:id/branch & GET /api/features/:id/branch (REL-003)
  const handleGetFeatureBranch = async (request: FastifyRequest) => {
    const params = FeatureParamsSchema.parse(request.params);
    const query = request.query as { repo_path?: string } | undefined;
    const info = await featureService.getFeatureBranchInfo(params.id, query?.repo_path);
    if (!info) {
      throw new AppError(
        'FEATURE_BRANCH_NOT_FOUND',
        `No branch has been created yet for feature '${params.id}'`,
        { featureId: params.id },
      );
    }
    return { data: info };
  };

  fastify.get('/features/:id/branch', handleGetFeatureBranch);
  fastify.get('/api/features/:id/branch', handleGetFeatureBranch);

  // POST /features/:id/commit & POST /api/features/:id/commit (REL-004)
  const handleCommitFeatureRelease = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = FeatureParamsSchema.parse(request.params);
    const body = CommitFeatureReleaseInputSchema.parse(request.body ?? {});
    const result = await featureService.commitFeatureRelease(params.id, body);
    return reply.status(201).send({ data: result });
  };

  fastify.post('/features/:id/commit', handleCommitFeatureRelease);
  fastify.post('/api/features/:id/commit', handleCommitFeatureRelease);

  // GET /features/:id/release & GET /api/features/:id/release (REL-004)
  const handleGetFeatureRelease = async (request: FastifyRequest) => {
    const params = FeatureParamsSchema.parse(request.params);
    const release = featureService.getFeatureRelease(params.id);
    if (!release) {
      throw new AppError(
        'RELEASE_NOT_FOUND',
        `No release record found for feature '${params.id}'`,
        { featureId: params.id },
      );
    }
    return { data: release };
  };

  fastify.get('/features/:id/release', handleGetFeatureRelease);
  fastify.get('/api/features/:id/release', handleGetFeatureRelease);

  // POST /features/:id/push & POST /api/features/:id/push (REL-005)
  const handlePushFeatureRelease = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = FeatureParamsSchema.parse(request.params);
    const body = PushFeatureReleaseInputSchema.parse(request.body ?? {});
    const result = await featureService.pushFeatureRelease(params.id, body);
    return reply.status(200).send({ data: result });
  };

  fastify.post('/features/:id/push', handlePushFeatureRelease);
  fastify.post('/api/features/:id/push', handlePushFeatureRelease);

  // GET /features/:id/remote-status & GET /api/features/:id/remote-status (REL-005)
  const handleGetRemoteStatus = async (request: FastifyRequest) => {
    const params = FeatureParamsSchema.parse(request.params);
    const query = ConfirmRemoteBranchInputSchema.parse(request.query ?? {});
    const result = await featureService.confirmRemoteBranch(params.id, query);
    return { data: result };
  };

  fastify.get('/features/:id/remote-status', handleGetRemoteStatus);
  fastify.get('/api/features/:id/remote-status', handleGetRemoteStatus);
};


