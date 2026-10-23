import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { FeatureService } from '../services/feature-service.js';
import { FeatureQuerySchema, FeatureParamsSchema } from '../types.js';
import { DefineFeatureTasksInputSchema } from '@ai-orchestrator/shared';

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
};

