import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  SystemResourceThresholdsSchema,
  type ResourceHealthStatus,
  type SystemResourceEventType,
} from '@ai-orchestrator/shared';
import type { SystemResourceMonitor } from '../services/system-resource-monitor.js';
import type { SystemResourceRepository } from '@ai-orchestrator/db';

export interface SystemResourceRoutesOptions {
  resourceMonitor: SystemResourceMonitor;
  resourceRepo?: SystemResourceRepository;
}

const QueryEventsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  status: z.enum(['OK', 'WARNING', 'CRITICAL']).optional(),
  eventType: z
    .enum([
      'SAMPLE',
      'RESOURCE_WARNING',
      'RESOURCE_CRITICAL',
      'RESOURCE_RECOVERED',
      'CONFIG_UPDATED',
    ])
    .optional(),
  since: z.string().optional(),
});

export const systemResourceRoutes: FastifyPluginAsync<SystemResourceRoutesOptions> = async (
  server,
  options,
) => {
  const { resourceMonitor, resourceRepo } = options;

  // GET /system/resources & GET /api/system/resources
  const getResourceStatusHandler = async () => {
    const snapshot = resourceMonitor.getLatestSnapshot();
    const thresholds = resourceMonitor.currentThresholds;
    const canAcquireResult = resourceMonitor.canAcquire();

    return {
      data: {
        status: snapshot.status,
        canAcquire: canAcquireResult.allowed,
        snapshot,
        thresholds,
      },
    };
  };

  server.get('/system/resources', getResourceStatusHandler);
  server.get('/api/system/resources', getResourceStatusHandler);

  // GET /system/resources/snapshot & GET /api/system/resources/snapshot
  const forceSampleHandler = async () => {
    const snapshot = resourceMonitor.evaluate();
    const thresholds = resourceMonitor.currentThresholds;
    const canAcquireResult = resourceMonitor.canAcquire();

    return {
      data: {
        status: snapshot.status,
        canAcquire: canAcquireResult.allowed,
        snapshot,
        thresholds,
      },
    };
  };

  server.get('/system/resources/snapshot', forceSampleHandler);
  server.get('/api/system/resources/snapshot', forceSampleHandler);

  // PATCH /system/resources/thresholds & PATCH /api/system/resources/thresholds
  const updateThresholdsHandler = async (request: FastifyRequest) => {
    const input = SystemResourceThresholdsSchema.partial().parse(request.body ?? {});
    const updated = resourceMonitor.updateThresholds(input);
    const snapshot = resourceMonitor.evaluate();

    return {
      data: {
        success: true,
        thresholds: updated,
        snapshot,
      },
    };
  };

  server.patch('/system/resources/thresholds', updateThresholdsHandler);
  server.patch('/api/system/resources/thresholds', updateThresholdsHandler);

  // POST /system/resources/sample & POST /api/system/resources/sample
  const recordSampleHandler = async () => {
    const record = resourceMonitor.recordSnapshot('SAMPLE');
    return {
      data: {
        success: true,
        record,
      },
    };
  };

  server.post('/system/resources/sample', recordSampleHandler);
  server.post('/api/system/resources/sample', recordSampleHandler);

  // GET /system/resources/events & GET /api/system/resources/events
  const getEventsHandler = async (request: FastifyRequest) => {
    const query = QueryEventsSchema.parse(request.query ?? {});
    if (!resourceRepo) {
      return { data: { events: [], total: 0 } };
    }

    const events = resourceRepo.findAll({
      limit: query.limit,
      status: query.status as ResourceHealthStatus | undefined,
      eventType: query.eventType as SystemResourceEventType | undefined,
      since: query.since,
    });

    return {
      data: {
        events,
        total: events.length,
      },
    };
  };

  server.get('/system/resources/events', getEventsHandler);
  server.get('/api/system/resources/events', getEventsHandler);
};
