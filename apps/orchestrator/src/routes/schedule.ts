import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ScheduleConfigSchema } from '@ai-orchestrator/shared';
import type { ExecutionScheduleManager } from '../services/execution-schedule-manager.js';

export interface ScheduleRoutesOptions {
  scheduleManager: ExecutionScheduleManager;
}

const QueryLimitSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const EvaluateInputSchema = z.object({
  timestamp: z.string().optional(),
});

export const scheduleRoutes: FastifyPluginAsync<ScheduleRoutesOptions> = async (
  server,
  options,
) => {
  const { scheduleManager } = options;

  // GET /system/schedule & GET /api/system/schedule
  const getScheduleStatusHandler = async () => {
    const data = scheduleManager.getStatus();
    return { data };
  };

  server.get('/system/schedule', getScheduleStatusHandler);
  server.get('/api/system/schedule', getScheduleStatusHandler);

  // PATCH /system/schedule & PATCH /api/system/schedule
  const updateScheduleHandler = async (request: FastifyRequest) => {
    const input = ScheduleConfigSchema.partial().parse(request.body ?? {});
    const updated = scheduleManager.updateConfig(input);
    return {
      data: {
        success: true,
        config: updated,
        status: scheduleManager.getStatus(),
      },
    };
  };

  server.patch('/system/schedule', updateScheduleHandler);
  server.patch('/api/system/schedule', updateScheduleHandler);
  server.put('/system/schedule', updateScheduleHandler);
  server.put('/api/system/schedule', updateScheduleHandler);

  // POST /system/schedule/evaluate & POST /api/system/schedule/evaluate
  const evaluateScheduleHandler = async (request: FastifyRequest) => {
    const parsed = EvaluateInputSchema.parse(request.body ?? {});
    const date = parsed.timestamp ? new Date(parsed.timestamp) : undefined;
    const result = scheduleManager.evaluate(date);
    return {
      data: result,
    };
  };

  server.post('/system/schedule/evaluate', evaluateScheduleHandler);
  server.post('/api/system/schedule/evaluate', evaluateScheduleHandler);

  // GET /system/schedule/events & GET /api/system/schedule/events
  const getEventsHandler = async (request: FastifyRequest) => {
    const { limit } = QueryLimitSchema.parse(request.query ?? {});
    const events = scheduleManager.getEvents(limit);
    return {
      data: {
        events,
        count: events.length,
      },
    };
  };

  server.get('/system/schedule/events', getEventsHandler);
  server.get('/api/system/schedule/events', getEventsHandler);
};
