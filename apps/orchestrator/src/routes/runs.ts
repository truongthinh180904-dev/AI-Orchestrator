import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { RunService } from '../services/run-service.js';
import {
  CreateRunApiSchema,
  StopRunApiSchema,
  RunFilterSchema,
  RunParamsSchema,
  RunStreamQuerySchema,
} from '../types.js';
import type { EventRecord, EventFilter } from '@ai-orchestrator/shared';

export interface RunRoutesOptions {
  runService: RunService;
}

export const runRoutes: FastifyPluginAsync<RunRoutesOptions> = async (fastify, opts) => {
  const { runService } = opts;

  // POST /runs — Start a new run execution
  const handleCreateRun = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = CreateRunApiSchema.parse(request.body ?? {});
    const result = await runService.startRun(body);

    return reply.status(201).send({
      data: {
        ...result.run,
        pid: result.execution.handle.pid ?? result.run.pid,
      },
    });
  };

  fastify.post('/runs', handleCreateRun);
  fastify.post('/api/runs', handleCreateRun);

  // GET /runs — List runs
  const handleListRuns = async (request: FastifyRequest) => {
    const query = RunFilterSchema.parse(request.query ?? {});
    const runs = runService.listRuns(query);
    return { data: runs };
  };

  fastify.get('/runs', handleListRuns);
  fastify.get('/api/runs', handleListRuns);

  // GET /runs/:id — Get details of a single run
  const handleGetRun = async (request: FastifyRequest) => {
    const params = RunParamsSchema.parse(request.params);
    const runInfo = runService.getRun(params.id);
    return { data: runInfo };
  };

  fastify.get('/runs/:id', handleGetRun);
  fastify.get('/api/runs/:id', handleGetRun);

  // GET /runs/:id/stream — Server-Sent Events (SSE) live event stream
  const handleRunStream = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = RunParamsSchema.parse(request.params);
    const query = RunStreamQuerySchema.parse(request.query ?? {});
    const runId = params.id;

    // Verify run exists (throws RUN_NOT_FOUND with 404 if not found)
    const initialRun = runService.getRun(runId);

    // Set SSE response headers
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders?.();

    const sendEvent = (event: EventRecord) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      const formatted = `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      reply.raw.write(formatted);
    };

    const headerLastId = request.headers['last-event-id'];
    const headerAfterSeq =
      typeof headerLastId === 'string' && headerLastId.trim().length > 0
        ? parseInt(headerLastId, 10)
        : undefined;
    const afterSeq =
      query.after_seq ?? (headerAfterSeq !== undefined && Number.isFinite(headerAfterSeq) ? headerAfterSeq : undefined);

    // Send historical events from DB
    const filter: EventFilter = {};
    if (afterSeq !== undefined) {
      filter.after_seq = afterSeq;
    }
    const historicalEvents = runService.getEvents(runId, filter);
    let highestSeq = afterSeq ?? 0;
    for (const event of historicalEvents) {
      sendEvent(event);
      if (event.seq > highestSeq) {
        highestSeq = event.seq;
      }
    }

    const managed = runService.getManagedExecution(runId);
    const isCurrentlyRunning = managed?.isRunning() ?? false;

    // If client does not want live events or run is already completed
    if (query.live === false || !isCurrentlyRunning || !managed?.recorder) {
      if (!reply.raw.writableEnded) {
        reply.raw.write(
          `event: done\ndata: ${JSON.stringify({ runId, status: initialRun.status })}\n\n`,
        );
        reply.raw.end();
      }
      return;
    }

    // Active run: setup heartbeat and live event listening
    const heartbeatTimer = setInterval(() => {
      if (!reply.raw.writableEnded && !reply.raw.destroyed) {
        reply.raw.write(': heartbeat\n\n');
      }
    }, 15_000);
    heartbeatTimer.unref?.();

    let isCleanedUp = false;
    let finishTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      clearInterval(heartbeatTimer);
      if (finishTimer) clearTimeout(finishTimer);
      if (managed.recorder) {
        managed.recorder.off('event', onLiveEvent);
        managed.recorder.off('finish', onExecutionFinish);
      }
    };

    const onLiveEvent = (event: EventRecord) => {
      if (event.seq > highestSeq) {
        highestSeq = event.seq;
        sendEvent(event);
      }
    };

    const onExecutionFinish = () => {
      finishTimer = setTimeout(() => {
        if (!reply.raw.writableEnded && !reply.raw.destroyed) {
          try {
            const remaining = runService.getEvents(runId, { after_seq: highestSeq });
            for (const ev of remaining) {
              sendEvent(ev);
              if (ev.seq > highestSeq) highestSeq = ev.seq;
            }
            const finalRun = runService.getRun(runId);
            reply.raw.write(
              `event: done\ndata: ${JSON.stringify({ runId, status: finalRun.status })}\n\n`,
            );
          } catch {
            // Ignore if run retrieval fails during teardown
          } finally {
            cleanup();
            reply.raw.end();
          }
        } else {
          cleanup();
        }
      }, 50);
    };

    managed.recorder.on('event', onLiveEvent);
    managed.recorder.once('finish', onExecutionFinish);

    request.raw.on('close', cleanup);
    reply.raw.on('close', cleanup);

    // Keep response lifecycle alive until stream is closed
    return new Promise<void>((resolve) => {
      reply.raw.on('finish', () => resolve());
      reply.raw.on('close', () => resolve());
    });
  };

  fastify.get('/runs/:id/stream', handleRunStream);
  fastify.get('/api/runs/:id/stream', handleRunStream);

  // POST /runs/:id/stop — Stop a running process
  const handleStopRun = async (request: FastifyRequest) => {
    const params = RunParamsSchema.parse(request.params);
    const body = StopRunApiSchema.parse(request.body ?? {});
    const result = await runService.stopRun(params.id, body);

    return {
      data: {
        stopped: result.stopped,
        run: result.run,
        message: result.message,
        ...result.run,
      },
    };
  };

  fastify.post('/runs/:id/stop', handleStopRun);
  fastify.post('/api/runs/:id/stop', handleStopRun);
};
