import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  PowerAssertionConfigSchema,
  LaunchdServiceConfigSchema,
  generateLaunchdPlist,
} from '@ai-orchestrator/shared';
import type { CaffeinateManager } from '../services/caffeinate-manager.js';

export interface PowerRoutesOptions {
  caffeinateManager: CaffeinateManager;
}

const AssertPowerInputSchema = PowerAssertionConfigSchema.partial();

export const powerRoutes: FastifyPluginAsync<PowerRoutesOptions> = async (
  server,
  options,
) => {
  const { caffeinateManager } = options;

  // GET /system/power & GET /api/system/power
  const getPowerStatusHandler = async () => {
    return { data: caffeinateManager.getStatus() };
  };

  server.get('/system/power', getPowerStatusHandler);
  server.get('/api/system/power', getPowerStatusHandler);

  // POST /system/power/assert & POST /api/system/power/assert
  const assertPowerHandler = async (request: FastifyRequest) => {
    const input = AssertPowerInputSchema.parse(request.body ?? {});
    const state = caffeinateManager.acquire(input);
    return {
      data: {
        success: true,
        state,
      },
    };
  };

  server.post('/system/power/assert', assertPowerHandler);
  server.post('/api/system/power/assert', assertPowerHandler);

  // POST /system/power/release & POST /api/system/power/release
  const releasePowerHandler = async () => {
    const state = caffeinateManager.release();
    return {
      data: {
        success: true,
        state,
      },
    };
  };

  server.post('/system/power/release', releasePowerHandler);
  server.post('/api/system/power/release', releasePowerHandler);

  // POST /system/launchd/generate-plist & POST /api/system/launchd/generate-plist
  const generatePlistHandler = async (request: FastifyRequest) => {
    const config = LaunchdServiceConfigSchema.parse(request.body ?? {});
    const plistXml = generateLaunchdPlist(config);
    return {
      data: {
        label: config.label,
        plistXml,
      },
    };
  };

  server.post('/system/launchd/generate-plist', generatePlistHandler);
  server.post('/api/system/launchd/generate-plist', generatePlistHandler);
};
