import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { RepoQualityConfigInputSchema, type ParsedConfig } from '@ai-orchestrator/shared';
import type { QualityConfigService } from '../services/quality-config-service.js';

export interface QualityRoutesOptions {
  qualityConfigService: QualityConfigService;
}

const RepoParamsSchema = z.object({
  id: z.string().min(1, 'Repository ID or path is required'),
});

const TaskParamsSchema = z.object({
  id: z.string().min(1, 'Task ID is required'),
});

const ResolveQualityBodySchema = z.object({
  repoId: z.string().optional(),
  repoPath: z.string().optional(),
  taskTestCommands: z.array(z.string()).optional(),
  overrides: RepoQualityConfigInputSchema.optional(),
  workbookConfig: z.record(z.string(), z.unknown()).optional(),
});

export const qualityRoutes: FastifyPluginAsync<QualityRoutesOptions> = async (fastify, opts) => {
  const { qualityConfigService } = opts;

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
};
