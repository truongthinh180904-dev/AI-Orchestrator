import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  SoakTestConfigSchema,
  SoakFaultTypeSchema,
  AppError,
} from '@ai-orchestrator/shared';
import type { SoakTestRunner } from '../services/soak-test-runner.js';
import type { SoakTestRepository } from '@ai-orchestrator/db';

export interface SoakTestRoutesOptions {
  soakTestRunner: SoakTestRunner;
  soakTestRepo: SoakTestRepository;
}

const SimulateFaultBodySchema = z.object({
  fault_type: SoakFaultTypeSchema,
  step: z.number().optional().default(1),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  metric: z.enum(['cpu', 'memory', 'disk']).optional().default('cpu'),
});

export const soakTestRoutes: FastifyPluginAsync<SoakTestRoutesOptions> = async (
  server,
  options,
) => {
  const { soakTestRunner, soakTestRepo } = options;

  // 1. POST /system/soak-test/run & POST /api/system/soak-test/run
  const runSoakTestHandler = async (request: FastifyRequest) => {
    const config = SoakTestConfigSchema.partial().parse(request.body ?? {});
    const result = await soakTestRunner.run(config);
    return { data: result };
  };

  server.post('/system/soak-test/run', runSoakTestHandler);
  server.post('/api/system/soak-test/run', runSoakTestHandler);

  // 2. GET /system/soak-test/status & GET /api/system/soak-test/status
  const getSoakTestStatusHandler = async () => {
    const latest = soakTestRepo.getLatest();
    const integrity = soakTestRunner.checkDataIntegrity();
    return {
      data: {
        latest,
        integrity,
      },
    };
  };

  server.get('/system/soak-test/status', getSoakTestStatusHandler);
  server.get('/api/system/soak-test/status', getSoakTestStatusHandler);

  // 3. GET /system/soak-test/runs & GET /api/system/soak-test/runs
  const listSoakTestRunsHandler = async (request: FastifyRequest) => {
    const query = (request.query as { limit?: string; status?: string }) ?? {};
    const limit = query.limit ? parseInt(query.limit, 10) : undefined;
    const runs = soakTestRepo.findAll({
      status: query.status,
      limit,
    });
    return { data: runs };
  };

  server.get('/system/soak-test/runs', listSoakTestRunsHandler);
  server.get('/api/system/soak-test/runs', listSoakTestRunsHandler);

  // 4. GET /system/soak-test/integrity & GET /api/system/soak-test/integrity
  const getIntegrityHandler = async () => {
    const integrity = soakTestRunner.checkDataIntegrity();
    return { data: integrity };
  };

  server.get('/system/soak-test/integrity', getIntegrityHandler);
  server.get('/api/system/soak-test/integrity', getIntegrityHandler);

  // 5. POST /system/soak-test/simulate-fault & POST /api/system/soak-test/simulate-fault
  const simulateFaultHandler = async (request: FastifyRequest) => {
    const body = SimulateFaultBodySchema.parse(request.body ?? {});
    let event;

    switch (body.fault_type) {
      case 'RATE_LIMIT':
        event = await soakTestRunner.simulateRateLimit(body.step, body.taskId, body.runId);
        break;
      case 'PROCESS_CRASH':
        event = await soakTestRunner.simulateProcessCrash(body.step, body.taskId);
        break;
      case 'UNRESPONSIVE_PROCESS':
        event = await soakTestRunner.simulateUnresponsiveProcess(body.step, body.runId);
        break;
      case 'RESOURCE_SPIKE':
        event = await soakTestRunner.simulateResourceSpike(body.step, body.metric);
        break;
      case 'SERVICE_RESTART':
        event = await soakTestRunner.simulateServiceRestart(body.step);
        break;
      default:
        throw new AppError('INVALID_FAULT_TYPE', `Unknown fault type: ${String(body.fault_type)}`);
    }

    return { data: event };
  };

  server.post('/system/soak-test/simulate-fault', simulateFaultHandler);
  server.post('/api/system/soak-test/simulate-fault', simulateFaultHandler);
};
