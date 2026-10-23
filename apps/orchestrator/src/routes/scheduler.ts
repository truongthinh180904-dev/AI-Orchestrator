import type { FastifyPluginAsync } from 'fastify';
import {
  ScheduleNextOptionsSchema,
  type ScheduleNextOptions,
  RecoveryOptionsSchema,
} from '@ai-orchestrator/shared';
import type { TaskScheduler } from '../services/task-scheduler.js';

export interface SchedulerRoutesOptions {
  scheduler: TaskScheduler;
}

export const schedulerRoutes: FastifyPluginAsync<SchedulerRoutesOptions> = async (
  server,
  options,
) => {
  const { scheduler } = options;

  // POST /scheduler/next & POST /api/scheduler/next
  const handleScheduleNext = async (request: { body?: unknown }) => {
    const parsed = ScheduleNextOptionsSchema.safeParse(request.body ?? {});
    const opts: ScheduleNextOptions = parsed.success ? parsed.data : {};
    const result = await scheduler.step(opts);
    return { data: result };
  };

  server.post('/scheduler/next', handleScheduleNext);
  server.post('/api/scheduler/next', handleScheduleNext);

  // GET /scheduler/status & GET /api/scheduler/status
  const handleGetStatus = async () => {
    return { data: scheduler.getStatus() };
  };

  server.get('/scheduler/status', handleGetStatus);
  server.get('/api/scheduler/status', handleGetStatus);

  // POST /scheduler/start & POST /api/scheduler/start
  const handleStart = async (request: { body?: unknown }) => {
    const parsed = ScheduleNextOptionsSchema.safeParse(request.body ?? {});
    const opts: ScheduleNextOptions = parsed.success ? parsed.data : {};
    // Trigger loop in background without blocking API response
    void scheduler.runUntilEmpty(opts);
    return { data: { started: true, isRunning: scheduler.isRunning } };
  };

  server.post('/scheduler/start', handleStart);
  server.post('/api/scheduler/start', handleStart);

  // POST /scheduler/stop & POST /api/scheduler/stop
  const handleStop = async () => {
    await scheduler.stop(true);
    return { data: { stopped: true, isRunning: scheduler.isRunning } };
  };

  server.post('/scheduler/stop', handleStop);
  server.post('/api/scheduler/stop', handleStop);

  // POST /scheduler/pause & POST /api/scheduler/pause
  const handlePause = async () => {
    scheduler.pause();
    return { data: { paused: true, isPaused: scheduler.isPaused } };
  };

  server.post('/scheduler/pause', handlePause);
  server.post('/api/scheduler/pause', handlePause);

  // POST /scheduler/resume & POST /api/scheduler/resume
  const handleResume = async () => {
    scheduler.resume();
    return { data: { resumed: true, isPaused: scheduler.isPaused } };
  };

  server.post('/scheduler/resume', handleResume);
  server.post('/api/scheduler/resume', handleResume);

  // POST /scheduler/release-lock & POST /api/scheduler/release-lock
  const handleReleaseLock = async () => {
    scheduler.releaseLock();
    return { data: { released: true, status: scheduler.getStatus() } };
  };

  server.post('/scheduler/release-lock', handleReleaseLock);
  server.post('/api/scheduler/release-lock', handleReleaseLock);

  // POST /scheduler/recover & POST /api/scheduler/recover & POST /system/recovery
  const handleRecover = async (request: { body?: unknown }) => {
    const parsed = RecoveryOptionsSchema.safeParse(request.body ?? {});
    const opts = parsed.success ? parsed.data : undefined;
    const result = scheduler.recover(opts);
    return { data: result };
  };

  server.post('/scheduler/recover', handleRecover);
  server.post('/api/scheduler/recover', handleRecover);
  server.post('/system/recovery', handleRecover);

  // GET /scheduler/recovery/status & GET /api/scheduler/recovery/status & GET /system/recovery
  const handleRecoveryStatus = async () => {
    return { data: scheduler.getRecoveryStatus() };
  };

  server.get('/scheduler/recovery/status', handleRecoveryStatus);
  server.get('/api/scheduler/recovery/status', handleRecoveryStatus);
  server.get('/system/recovery', handleRecoveryStatus);
};
