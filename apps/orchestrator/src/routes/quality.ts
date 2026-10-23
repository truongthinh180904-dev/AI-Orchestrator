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
  AppError,
} from '@ai-orchestrator/shared';
import type { QualityConfigService } from '../services/quality-config-service.js';
import type { QualityRunner } from '../services/quality-runner.js';
import type { ScopeDiffService } from '../services/scope-diff-service.js';

export interface QualityRoutesOptions {
  qualityConfigService: QualityConfigService;
  qualityRunner: QualityRunner;
  scopeDiffService?: ScopeDiffService;
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

export const qualityRoutes: FastifyPluginAsync<QualityRoutesOptions> = async (fastify, opts) => {
  const { qualityConfigService, qualityRunner, scopeDiffService } = opts;

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
};
