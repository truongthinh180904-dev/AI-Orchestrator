import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { PlannerService } from '../services/planner-service.js';
import {
  GeneratePlanInputSchema,
  PlanFilterSchema,
  type PlanTaskInput,
} from '@ai-orchestrator/shared';
import {
  PlanParamsSchema,
  ValidatePlanBodySchema,
  ApprovePlanBodySchema,
  RejectPlanBodySchema,
  ExecutePlanBodySchema,
  OrchestratePlanBodySchema,
  StepPlanBodySchema,
  UpdatePlanBodySchema,
} from '../types.js';

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

  // GET /plans/:id/review & GET /api/plans/:id/review
  const handleGetReview = async (request: FastifyRequest) => {
    const params = PlanParamsSchema.parse(request.params);
    const review = plannerService.getReviewSummary(params.id);
    return { data: review };
  };

  fastify.get('/plans/:id/review', handleGetReview);
  fastify.get('/api/plans/:id/review', handleGetReview);

  // POST /plans/:id/approve & POST /api/plans/:id/approve
  const handleApprove = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = PlanParamsSchema.parse(request.params);
    const body = ApprovePlanBodySchema.parse(request.body ?? {});
    const plan = plannerService.approvePlan(params.id, {
      approved_by: body.approved_by,
      comments: body.comments,
      edits: body.edits
        ? {
            title: body.edits.title,
            description: body.edits.description,
            tasks: body.edits.tasks as unknown as PlanTaskInput[] | undefined,
          }
        : undefined,
    });
    return reply.status(200).send({ data: plan });
  };

  fastify.post('/plans/:id/approve', handleApprove);
  fastify.post('/api/plans/:id/approve', handleApprove);

  // POST /plans/:id/reject & POST /api/plans/:id/reject
  const handleReject = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = PlanParamsSchema.parse(request.params);
    const body = RejectPlanBodySchema.parse(request.body);
    const plan = plannerService.rejectPlan(params.id, body);
    return reply.status(200).send({ data: plan });
  };

  fastify.post('/plans/:id/reject', handleReject);
  fastify.post('/api/plans/:id/reject', handleReject);

  // POST /plans/:id/submit & POST /api/plans/:id/submit
  const handleSubmit = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = PlanParamsSchema.parse(request.params);
    const plan = plannerService.submitForReview(params.id);
    return reply.status(200).send({ data: plan });
  };

  fastify.post('/plans/:id/submit', handleSubmit);
  fastify.post('/api/plans/:id/submit', handleSubmit);

  // PATCH & PUT /plans/:id & /api/plans/:id
  const handleEdit = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = PlanParamsSchema.parse(request.params);
    const body = UpdatePlanBodySchema.parse(request.body ?? {});
    const plan = plannerService.editPlan(params.id, {
      title: body.title,
      description: body.description,
      repository: body.repository,
      feature_id: body.feature_id,
      status: body.status,
      tasks: body.tasks as unknown as PlanTaskInput[] | undefined,
    });
    return reply.status(200).send({ data: plan });
  };

  fastify.patch('/plans/:id', handleEdit);
  fastify.patch('/api/plans/:id', handleEdit);
  fastify.put('/plans/:id', handleEdit);
  fastify.put('/api/plans/:id', handleEdit);

  // POST /plans/:id/execute & POST /api/plans/:id/execute
  // STRICT ENFORCEMENT: "Chưa duyệt → không thực thi"
  const handleExecute = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = PlanParamsSchema.parse(request.params);
    const body = ExecutePlanBodySchema.parse(request.body ?? {});
    if (body.orchestrate || body.autoStart) {
      const result = await plannerService.orchestratePlan(params.id, {
        dryRun: body.dryRun,
        autoVerify: body.autoVerify,
        autoRetry: body.autoRetry,
        timeoutMs: body.timeoutMs,
      });
      return reply.status(200).send({ data: result });
    }
    const result = plannerService.executePlan(params.id, body);
    return reply.status(200).send({ data: result });
  };

  fastify.post('/plans/:id/execute', handleExecute);
  fastify.post('/api/plans/:id/execute', handleExecute);

  // POST /plans/:id/orchestrate & POST /api/plans/:id/orchestrate
  const handleOrchestrate = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = PlanParamsSchema.parse(request.params);
    const body = OrchestratePlanBodySchema.parse(request.body ?? {});
    const result = await plannerService.orchestratePlan(params.id, body);
    return reply.status(200).send({ data: result });
  };

  fastify.post('/plans/:id/orchestrate', handleOrchestrate);
  fastify.post('/api/plans/:id/orchestrate', handleOrchestrate);

  // POST /plans/:id/step & POST /api/plans/:id/step
  const handleStep = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = PlanParamsSchema.parse(request.params);
    const body = StepPlanBodySchema.parse(request.body ?? {});
    const result = await plannerService.stepPlan(params.id, body);
    return reply.status(200).send({ data: result });
  };

  fastify.post('/plans/:id/step', handleStep);
  fastify.post('/api/plans/:id/step', handleStep);

  // POST /plans/:id/dispatch & POST /api/plans/:id/dispatch
  const handleDispatch = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = PlanParamsSchema.parse(request.params);
    const tasks = plannerService.materializePlanTasks(params.id);
    return reply.status(200).send({ data: { planId: params.id, tasks } });
  };

  fastify.post('/plans/:id/dispatch', handleDispatch);
  fastify.post('/api/plans/:id/dispatch', handleDispatch);

  // GET /plans/:id/execution & GET /api/plans/:id/execution & /plans/:id/status
  const handleGetExecution = async (request: FastifyRequest) => {
    const params = PlanParamsSchema.parse(request.params);
    const summary = plannerService.getPlanExecutionSummary(params.id);
    return { data: summary };
  };

  fastify.get('/plans/:id/execution', handleGetExecution);
  fastify.get('/api/plans/:id/execution', handleGetExecution);
  fastify.get('/plans/:id/status', handleGetExecution);
  fastify.get('/api/plans/:id/status', handleGetExecution);

  // DELETE /plans/:id & DELETE /api/plans/:id
  const handleDelete = async (request: FastifyRequest) => {
    const params = PlanParamsSchema.parse(request.params);
    plannerService.deletePlan(params.id);
    return { data: { success: true, id: params.id } };
  };

  fastify.delete('/plans/:id', handleDelete);
  fastify.delete('/api/plans/:id', handleDelete);
};
