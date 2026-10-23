import { z } from 'zod';
import { RunStatusSchema, type RunStatus } from '../models/run.js';

/**
 * High-level process liveness state:
 * - ALIVE: Process PID is active in OS and heartbeat is fresh (actively executing).
 * - UNRESPONSIVE: Process PID is active in OS but heartbeat has timed out (process hung / silent).
 * - DEAD: Process run status is RUNNING/PENDING, but PID does not exist in OS (crashed / killed abruptly).
 * - FINISHED: Process completed its execution lifecycle with recorded finished_at and terminal status.
 * - UNKNOWN: Insufficient data to determine liveness (e.g. invalid or missing PID on active run).
 */
export const PROCESS_LIVENESS_STATES = [
  'ALIVE',
  'UNRESPONSIVE',
  'DEAD',
  'FINISHED',
  'UNKNOWN',
] as const;

export const ProcessLivenessStateSchema = z.enum(PROCESS_LIVENESS_STATES);
export type ProcessLivenessState = z.infer<typeof ProcessLivenessStateSchema>;

/**
 * Detailed diagnostic state inspection of a process / run.
 */
export const ProcessStateInspectionSchema = z.object({
  runId: z.string(),
  taskId: z.string(),
  pid: z.number().int().nullable(),
  state: ProcessLivenessStateSchema,
  isAlive: z.boolean(),
  isFinished: z.boolean(),
  isHeartbeatFresh: z.boolean(),
  isUnresponsive: z.boolean(),
  isCrashed: z.boolean(),
  diagnosis: z.string(),
  lastHeartbeatAt: z.string().nullable(),
  heartbeatAgeMs: z.number().nullable(),
  recordedStatus: RunStatusSchema,
  exitCode: z.number().int().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
});

export type ProcessStateInspection = z.infer<typeof ProcessStateInspectionSchema>;

export const ProcessScanSummarySchema = z.object({
  scannedAt: z.string(),
  totalScanned: z.number().int(),
  aliveCount: z.number().int(),
  unresponsiveCount: z.number().int(),
  deadCount: z.number().int(),
  finishedCount: z.number().int(),
  reconciledCount: z.number().int().default(0),
  inspections: z.array(ProcessStateInspectionSchema),
});

export type ProcessScanSummary = z.infer<typeof ProcessScanSummarySchema>;

export const ProcessHeartbeatInputSchema = z.object({
  runId: z.string().min(1, 'runId is required'),
  timestamp: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ProcessHeartbeatInput = z.infer<typeof ProcessHeartbeatInputSchema>;

export const ProcessScanOptionsSchema = z.object({
  heartbeatTimeoutMs: z.number().int().positive().optional().default(30_000),
  autoReconcile: z.boolean().optional().default(false),
  autoTerminateUnresponsive: z.boolean().optional().default(false),
});

export type ProcessScanOptions = {
  heartbeatTimeoutMs?: number;
  autoReconcile?: boolean;
  autoTerminateUnresponsive?: boolean;
};

/**
 * Checks whether an OS process with the given PID is alive.
 * Uses process.kill(pid, 0) without actually sending a signal.
 * - Returns true if signal 0 succeeds (process exists) or throws EPERM (process exists under other user).
 * - Returns false if throws ESRCH (no such process) or if PID is invalid (<= 0, NaN, non-integer).
 */
export function isProcessAlive(pid: number | null | undefined): boolean {
  if (pid === null || pid === undefined) {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'EPERM') {
      // Process exists but current process lacks permission to signal it
      return true;
    }
    // ESRCH means process does not exist
    return false;
  }
}

export interface EvaluateProcessLivenessInput {
  run: {
    id: string;
    task_id: string;
    status: RunStatus;
    pid: number | null;
    started_at?: string | null;
    finished_at?: string | null;
    exit_code?: number | null;
    last_heartbeat_at?: string | null;
  };
  isHandleRunning?: boolean;
  heartbeatTimeoutMs?: number;
  now?: number;
  osProcessAliveChecker?: (pid: number) => boolean;
}

const TERMINAL_RUN_STATUSES = new Set<RunStatus>([
  'SUCCESS',
  'ERROR',
  'INVALID_OUTPUT',
  'TIMEOUT',
  'CANCELLED',
]);

/**
 * Evaluates the liveness of a process and strictly distinguishes:
 * - 'FINISHED' (Xong): Has finished_at or terminal status, cleanly completed.
 * - 'DEAD' (Chết): Marked active (RUNNING/PENDING) but PID is missing from OS without graceful exit.
 * - 'ALIVE': Active in OS and heartbeat is fresh.
 * - 'UNRESPONSIVE': Active in OS but heartbeat is stale.
 */
export function evaluateProcessLiveness(
  input: EvaluateProcessLivenessInput,
): ProcessStateInspection {
  const {
    run,
    heartbeatTimeoutMs = 30_000,
    now = Date.now(),
    osProcessAliveChecker = isProcessAlive,
  } = input;

  const runId = run.id;
  const taskId = run.task_id;
  const pid = run.pid ?? null;
  const recordedStatus = run.status;
  const exitCode = run.exit_code ?? null;
  const startedAt = run.started_at ?? null;
  const finishedAt = run.finished_at ?? null;
  const lastHeartbeatAt = run.last_heartbeat_at ?? null;

  // 1. Check if the run has completed (FINISHED / XONG)
  const isTerminalStatus = TERMINAL_RUN_STATUSES.has(recordedStatus);
  const isFinished = Boolean(finishedAt) || isTerminalStatus;

  if (isFinished) {
    return {
      runId,
      taskId,
      pid,
      state: 'FINISHED',
      isAlive: false,
      isFinished: true,
      isHeartbeatFresh: false,
      isUnresponsive: false,
      isCrashed: false,
      diagnosis: `Run ${runId} has finished execution with status ${recordedStatus}${exitCode !== null ? ` (exitCode: ${exitCode})` : ''}`,
      lastHeartbeatAt,
      heartbeatAgeMs: null,
      recordedStatus,
      exitCode,
      startedAt,
      finishedAt,
    };
  }

  // 2. Active run without a valid PID
  if (!pid || pid <= 0) {
    return {
      runId,
      taskId,
      pid,
      state: 'UNKNOWN',
      isAlive: false,
      isFinished: false,
      isHeartbeatFresh: false,
      isUnresponsive: false,
      isCrashed: false,
      diagnosis: `Run ${runId} is marked ${recordedStatus} but has no valid PID recorded`,
      lastHeartbeatAt,
      heartbeatAgeMs: null,
      recordedStatus,
      exitCode,
      startedAt,
      finishedAt,
    };
  }

  // 3. Check OS process liveness
  const pidAliveInOs = osProcessAliveChecker(pid);

  // If the process handle is in memory and reports not running, or OS reports dead
  if (!pidAliveInOs) {
    // DEAD / CHẾT: Run is RUNNING but process disappeared from OS!
    return {
      runId,
      taskId,
      pid,
      state: 'DEAD',
      isAlive: false,
      isFinished: false,
      isHeartbeatFresh: false,
      isUnresponsive: false,
      isCrashed: true,
      diagnosis: `Process PID ${pid} is dead/crashed unexpectedly while run status is ${recordedStatus} (PID disappeared from OS without clean finish)`,
      lastHeartbeatAt,
      heartbeatAgeMs: null,
      recordedStatus,
      exitCode,
      startedAt,
      finishedAt,
    };
  }

  // 4. PID is alive in OS -> calculate heartbeat freshness
  let heartbeatReferenceTime: number;
  if (lastHeartbeatAt) {
    heartbeatReferenceTime = new Date(lastHeartbeatAt).getTime();
  } else if (startedAt) {
    heartbeatReferenceTime = new Date(startedAt).getTime();
  } else {
    heartbeatReferenceTime = now;
  }

  const heartbeatAgeMs = Math.max(0, now - heartbeatReferenceTime);
  const isHeartbeatFresh = heartbeatAgeMs <= heartbeatTimeoutMs;

  if (!isHeartbeatFresh) {
    // UNRESPONSIVE / TREO: PID is still alive but no heartbeat for > heartbeatTimeoutMs
    return {
      runId,
      taskId,
      pid,
      state: 'UNRESPONSIVE',
      isAlive: true,
      isFinished: false,
      isHeartbeatFresh: false,
      isUnresponsive: true,
      isCrashed: false,
      diagnosis: `Process PID ${pid} is alive in OS but unresponsive: last heartbeat was ${heartbeatAgeMs}ms ago (exceeding threshold of ${heartbeatTimeoutMs}ms)`,
      lastHeartbeatAt,
      heartbeatAgeMs,
      recordedStatus,
      exitCode,
      startedAt,
      finishedAt,
    };
  }

  // ALIVE: Healthy and running
  return {
    runId,
    taskId,
    pid,
    state: 'ALIVE',
    isAlive: true,
    isFinished: false,
    isHeartbeatFresh: true,
    isUnresponsive: false,
    isCrashed: false,
    diagnosis: `Process PID ${pid} is alive and actively running (heartbeat age: ${heartbeatAgeMs}ms <= ${heartbeatTimeoutMs}ms)`,
    lastHeartbeatAt,
    heartbeatAgeMs,
    recordedStatus,
    exitCode,
    startedAt,
    finishedAt,
  };
}
