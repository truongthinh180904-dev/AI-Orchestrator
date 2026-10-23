import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ResourceQuotaConfigSchema } from '@ai-orchestrator/shared';
import type { ResourceQuotaManager } from '../services/resource-quota-manager.js';

export interface QuotaRoutesOptions {
  quotaManager: ResourceQuotaManager;
}

const QueryLimitSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const quotaRoutes: FastifyPluginAsync<QuotaRoutesOptions> = async (server, options) => {
  const { quotaManager } = options;

  // GET /system/quota & GET /api/system/quota
  const getQuotaStatusHandler = async () => {
    const data = quotaManager.getStatus();
    return { data };
  };

  server.get('/system/quota', getQuotaStatusHandler);
  server.get('/api/system/quota', getQuotaStatusHandler);

  // POST /system/quota/reset & POST /api/system/quota/reset
  const resetQuotaHandler = async () => {
    quotaManager.resetQuota();
    const data = quotaManager.getStatus();
    return {
      data: {
        success: true,
        message: 'Resource quota and circuit breaker reset successfully',
        status: data,
      },
    };
  };

  server.post('/system/quota/reset', resetQuotaHandler);
  server.post('/api/system/quota/reset', resetQuotaHandler);

  // PATCH /system/quota/config & PATCH /api/system/quota/config
  const updateConfigHandler = async (request: FastifyRequest) => {
    const input = ResourceQuotaConfigSchema.partial().parse(request.body ?? {});
    const updated = quotaManager.updateConfig(input);
    return {
      data: {
        success: true,
        config: updated,
        status: quotaManager.getStatus(),
      },
    };
  };

  server.patch('/system/quota/config', updateConfigHandler);
  server.patch('/api/system/quota/config', updateConfigHandler);

  // GET /system/quota/events & GET /api/system/quota/events
  const getEventsHandler = async (request: FastifyRequest) => {
    const { limit } = QueryLimitSchema.parse(request.query ?? {});
    const events = quotaManager.getEvents(limit);
    return {
      data: {
        events,
        count: events.length,
      },
    };
  };

  server.get('/system/quota/events', getEventsHandler);
  server.get('/api/system/quota/events', getEventsHandler);
};
