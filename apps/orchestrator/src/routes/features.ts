import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { FeatureService } from '../services/feature-service.js';
import { FeatureQuerySchema, FeatureParamsSchema } from '../types.js';

export interface FeatureRoutesOptions {
  featureService: FeatureService;
}

export const featureRoutes: FastifyPluginAsync<FeatureRoutesOptions> = async (fastify, opts) => {
  const { featureService } = opts;

  // GET /features
  const handleList = async (request: FastifyRequest) => {
    const filter = FeatureQuerySchema.parse(request.query ?? {});
    const features = featureService.list(filter);
    return { data: features };
  };

  fastify.get('/features', handleList);
  fastify.get('/api/features', handleList);

  // GET /features/:id
  const handleGetById = async (request: FastifyRequest) => {
    const params = FeatureParamsSchema.parse(request.params);
    const feature = featureService.getById(params.id);
    return { data: feature };
  };

  fastify.get('/features/:id', handleGetById);
  fastify.get('/api/features/:id', handleGetById);
};
