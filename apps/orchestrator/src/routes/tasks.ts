import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { TaskService } from '../services/task-service.js';
import {
  TaskQuerySchema,
  TaskParamsSchema,
  TaskPatchBodySchema,
} from '../types.js';
import { AppError } from '@ai-orchestrator/shared';

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

  // GET /tasks/:id
  const handleGetById = async (request: FastifyRequest) => {
    const params = TaskParamsSchema.parse(request.params);
    const task = taskService.getById(params.id);
    return { data: task };
  };

  fastify.get('/tasks/:id', handleGetById);
  fastify.get('/api/tasks/:id', handleGetById);

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
      throw new AppError('INVALID_INPUT', 'Task ID must be provided in URL parameter or request body id property');
    }
    const { id, ...updateData } = body;
    const updated = taskService.update(id, updateData);
    return { data: updated };
  };

  fastify.patch('/tasks', handlePatchRoot);
  fastify.patch('/api/tasks', handlePatchRoot);
};
