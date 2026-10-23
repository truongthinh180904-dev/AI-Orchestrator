import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { TaskService } from '../services/task-service.js';
import {
  TaskQuerySchema,
  TaskParamsSchema,
  TaskPatchBodySchema,
  TaskTransitionBodySchema,
  TaskRetryBodySchema,
  TaskReadyQuerySchema,
  TaskResolveReadyBodySchema,
  CreateCheckpointBodySchema,
  CheckpointQuerySchema,
} from '../types.js';
import { AppError, RecordTaskCommitInputSchema } from '@ai-orchestrator/shared';

export interface TaskRoutesOptions {
  taskService: TaskService;
}

export const taskRoutes: FastifyPluginAsync<TaskRoutesOptions> = async (fastify, opts) => {
  const { taskService } = opts;

  // GET /tasks
  const handleList = async (request: FastifyRequest) => {
    const query = TaskQuerySchema.parse(request.query ?? {});
    const { search, ...filter } = query;
    const tasks = taskService.list(filter, search);
    return { data: tasks };
  };

  fastify.get('/tasks', handleList);
  fastify.get('/api/tasks', handleList);

  // GET /tasks/ready & GET /api/tasks/ready (ORC-002: Danh sách task READY)
  const handleGetReady = async (request: FastifyRequest) => {
    const query = TaskReadyQuerySchema.parse(request.query ?? {});
    const { autoTransition, limit, ...filter } = query;
    const readyTasks = taskService.getReadyTasks(filter, { autoTransition, limit });
    return { data: readyTasks };
  };

  fastify.get('/tasks/ready', handleGetReady);
  fastify.get('/api/tasks/ready', handleGetReady);

  // POST /tasks/resolve-ready & POST /api/tasks/resolve-ready (ORC-002: Resolve and auto-transition to READY)
  const handleResolveReady = async (request: FastifyRequest) => {
    const body = TaskResolveReadyBodySchema.parse(request.body ?? request.query ?? {});
    const readyTasks = taskService.resolveReady(body);
    return { data: readyTasks };
  };

  fastify.post('/tasks/resolve-ready', handleResolveReady);
  fastify.post('/api/tasks/resolve-ready', handleResolveReady);

  // GET /tasks/:id
  const handleGetById = async (request: FastifyRequest) => {
    const params = TaskParamsSchema.parse(request.params);
    const task = taskService.getById(params.id);
    return { data: task };
  };

  fastify.get('/tasks/:id', handleGetById);
  fastify.get('/api/tasks/:id', handleGetById);

  // GET /tasks/:id/dependency-status (ORC-002: Tình trạng dependencies của 1 task)
  const handleDependencyStatus = async (request: FastifyRequest) => {
    const params = TaskParamsSchema.parse(request.params);
    const status = taskService.getDependencyStatus(params.id);
    return { data: status };
  };

  fastify.get('/tasks/:id/dependency-status', handleDependencyStatus);
  fastify.get('/api/tasks/:id/dependency-status', handleDependencyStatus);

  // PATCH /tasks/:id
  const handlePatchById = async (request: FastifyRequest) => {
    const params = TaskParamsSchema.parse(request.params);
    const body = TaskPatchBodySchema.parse(request.body ?? {});
    const { id: _ignoredId, ...updateData } = body;
    const updated = taskService.update(params.id, updateData);
    return { data: updated };
  };

  fastify.patch('/tasks/:id', handlePatchById);
  fastify.patch('/api/tasks/:id', handlePatchById);

  // PATCH /tasks (body containing id)
  const handlePatchRoot = async (request: FastifyRequest) => {
    const body = TaskPatchBodySchema.parse(request.body ?? {});
    if (!body.id) {
      throw new AppError(
        'INVALID_INPUT',
        'Task ID must be provided in URL parameter or request body id property',
      );
    }
    const { id, ...updateData } = body;
    const updated = taskService.update(id, updateData);
    return { data: updated };
  };

  fastify.patch('/tasks', handlePatchRoot);
  fastify.patch('/api/tasks', handlePatchRoot);

  // POST /tasks/:id/transition (ORC-001: Task State Machine transition)
  const handleTransition = async (request: FastifyRequest) => {
    const params = TaskParamsSchema.parse(request.params);
    const body = TaskTransitionBodySchema.parse(request.body ?? {});
    const updated = taskService.transition(params.id, body.status, {
      reason: body.reason,
      runId: body.runId,
      incrementAttempt: body.incrementAttempt,
      force: body.force,
    });
    return { data: updated };
  };

  fastify.post('/tasks/:id/transition', handleTransition);
  fastify.post('/api/tasks/:id/transition', handleTransition);

  // POST /tasks/:id/retry (ORC-004: Retry task with policy checks)
  const handleRetry = async (request: FastifyRequest) => {
    const params = TaskParamsSchema.parse(request.params);
    const body = TaskRetryBodySchema.parse(request.body ?? {});
    const result = taskService.retry(params.id, {
      reason: body.reason,
      runId: body.runId,
      force: body.force,
    });
    return { data: result };
  };

  fastify.post('/tasks/:id/retry', handleRetry);
  fastify.post('/api/tasks/:id/retry', handleRetry);

  // GET /tasks/:id/allowed-transitions (ORC-001: Query allowed next states)
  const handleAllowedTransitions = async (request: FastifyRequest) => {
    const params = TaskParamsSchema.parse(request.params);
    const task = taskService.getById(params.id);
    const allowed = taskService.getAllowedTransitions(params.id);
    return {
      data: {
        taskId: task.id,
        currentStatus: task.status,
        allowedTransitions: allowed,
      },
    };
  };

  fastify.get('/tasks/:id/allowed-transitions', handleAllowedTransitions);
  fastify.get('/api/tasks/:id/allowed-transitions', handleAllowedTransitions);

  // GET /tasks/:id/history (ORC-005: Task Run & Attempt History)
  const handleTaskHistory = async (request: FastifyRequest) => {
    const params = TaskParamsSchema.parse(request.params);
    const history = taskService.getHistory(params.id);
    return { data: history };
  };

  fastify.get('/tasks/:id/history', handleTaskHistory);
  fastify.get('/api/tasks/:id/history', handleTaskHistory);

  // GET /tasks/:id/checkpoints (ORC-005: Task Checkpoints)
  const handleTaskCheckpoints = async (request: FastifyRequest) => {
    const params = TaskParamsSchema.parse(request.params);
    const query = CheckpointQuerySchema.parse(request.query ?? {});
    const checkpoints = taskService.getCheckpoints(params.id, {
      run_id: query.run_id ?? query.runId,
      attempt: query.attempt,
      step: query.step,
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });
    return { data: checkpoints };
  };

  fastify.get('/tasks/:id/checkpoints', handleTaskCheckpoints);
  fastify.get('/api/tasks/:id/checkpoints', handleTaskCheckpoints);

  // POST /tasks/:id/checkpoints (ORC-005: Create Checkpoint)
  const handleCreateTaskCheckpoint = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = TaskParamsSchema.parse(request.params);
    const body = CreateCheckpointBodySchema.parse(request.body ?? {});
    const checkpoint = taskService.createCheckpoint({
      task_id: params.id,
      run_id: body.run_id ?? body.runId,
      attempt: body.attempt,
      step: body.step,
      status: body.status,
      data: body.data,
    });
    return reply.status(201).send({ data: checkpoint });
  };

  fastify.post('/tasks/:id/checkpoints', handleCreateTaskCheckpoint);
  fastify.post('/api/tasks/:id/checkpoints', handleCreateTaskCheckpoint);

  // GET /tasks/:id/checkpoints/latest (ORC-005: Latest Checkpoint)
  const handleLatestCheckpoint = async (request: FastifyRequest) => {
    const params = TaskParamsSchema.parse(request.params);
    const checkpoint = taskService.getLatestCheckpoint(params.id);
    return { data: checkpoint };
  };

  fastify.get('/tasks/:id/checkpoints/latest', handleLatestCheckpoint);
  fastify.get('/api/tasks/:id/checkpoints/latest', handleLatestCheckpoint);

  // POST /tasks/:id/commit & POST /api/tasks/:id/commit (REL-004)
  const handleTaskCommit = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = TaskParamsSchema.parse(request.params);
    const body = RecordTaskCommitInputSchema.parse(request.body ?? {});
    const result = await taskService.recordTaskCommit(params.id, body);
    return reply.status(201).send({ data: result });
  };

  fastify.post('/tasks/:id/commit', handleTaskCommit);
  fastify.post('/api/tasks/:id/commit', handleTaskCommit);
};
