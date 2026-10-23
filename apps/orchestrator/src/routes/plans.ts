import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { PlannerService } from '../services/planner-service.js';
import {
  GeneratePlanInputSchema,
  PlanFilterSchema,
} from '@ai-orchestrator/shared';
import { PlanParamsSchema, ValidatePlanBodySchema } from '../types.js';

export interface PlanRoutesOptions {
  plannerService: PlannerService;
}

export const planRoutes: FastifyPluginAsync<PlanRoutesOptions> = async (fastify, opts) => {
  const { plannerService } = opts;

  // POST /plans/generate & POST /api/plans/generate
  const handleGenerate = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = GeneratePlanInputSchema.parse(request.body);
    const plan = await plannerService.generatePlan(input);
    return reply.status(201).send({ data: plan });
  };

  fastify.post('/plans/generate', handleGenerate);
  fastify.post('/api/plans/generate', handleGenerate);

  // POST /plans/validate & POST /api/plans/validate
  const handleValidate = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = ValidatePlanBodySchema.parse(request.body);
    const plan = plannerService.parseAndValidatePlan(body.rawOutput, {
      repository: body.repository,
      feature_id: body.feature_id,
    });
    return reply.status(200).send({ data: plan });
  };

  fastify.post('/plans/validate', handleValidate);
  fastify.post('/api/plans/validate', handleValidate);

  // GET /plans & GET /api/plans
  const handleList = async (request: FastifyRequest) => {
    const filter = PlanFilterSchema.parse(request.query ?? {});
    const plans = plannerService.listPlans(filter);
    return { data: plans };
  };

  fastify.get('/plans', handleList);
  fastify.get('/api/plans', handleList);

  // GET /plans/:id & GET /api/plans/:id
  const handleGetById = async (request: FastifyRequest) => {
    const params = PlanParamsSchema.parse(request.params);
    const plan = plannerService.getPlan(params.id);
    return { data: plan };
  };

  fastify.get('/plans/:id', handleGetById);
  fastify.get('/api/plans/:id', handleGetById);

  // DELETE /plans/:id & DELETE /api/plans/:id
  const handleDelete = async (request: FastifyRequest) => {
    const params = PlanParamsSchema.parse(request.params);
    plannerService.deletePlan(params.id);
    return { data: { success: true, id: params.id } };
  };

  fastify.delete('/plans/:id', handleDelete);
  fastify.delete('/api/plans/:id', handleDelete);
};
