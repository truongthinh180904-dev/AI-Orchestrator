import { z } from 'zod';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { FeatureService } from '../services/feature-service.js';
import { FeatureQuerySchema, FeatureParamsSchema } from '../types.js';
import {
  DefineFeatureTasksInputSchema,
  CheckReleaseReadinessInputSchema,
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
};

