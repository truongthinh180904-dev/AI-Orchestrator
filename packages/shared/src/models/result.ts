import { z } from 'zod';
import { type RunStatus } from './run.js';

export const AgentResultStatusSchema = z.preprocess(
  (val) => (typeof val === 'string' ? val.trim().toUpperCase() : val),
  z.enum(['SUCCESS', 'ERROR', 'FAILED']),
);

export type AgentResultStatus = z.infer<typeof AgentResultStatusSchema>;

export const AgentResultPayloadSchema = z
  .object({
    type: z.string().optional(),
    status: AgentResultStatusSchema.optional(),
    success: z.boolean().optional(),
    message: z.string().optional(),
    summary: z.string().optional(),
    error: z.unknown().optional(),
    data: z.unknown().optional(),
    details: z.unknown().optional(),
    exit_code: z.number().int().optional(),
  })
  .passthrough()
  .refine((data) => data.status !== undefined || data.success !== undefined, {
    message:
      "Agent result payload must contain either 'status' ('SUCCESS', 'ERROR', 'FAILED') or 'success' (boolean)",
  });

export type AgentResultPayload = z.infer<typeof AgentResultPayloadSchema>;

export interface ResultEventLike {
  type: string;
  payload: unknown;
  seq?: number;
  ts?: string;
}

/**
 * Checks whether an agent result payload represents a successful outcome.
 */
export function isResultSuccess(payload: AgentResultPayload): boolean {
  if (payload.status === 'ERROR' || payload.status === 'FAILED') {
    return false;
  }
  if (payload.success === false) {
    return false;
  }
  if (payload.status === 'SUCCESS' || payload.success === true) {
    return true;
  }
  return false;
}

/**
 * Scans an array of stream events to locate result events.
 * Identifies events with type === 'result' or payloads having { type: 'result' } or { event: 'result' }.
 */
export function findResultEvents<T extends ResultEventLike>(events: T[]): T[] {
  return events.filter((e) => {
    if (e.type === 'result') {
      return true;
    }
    if (typeof e.payload === 'object' && e.payload !== null) {
      const p = e.payload as Record<string, unknown>;
      if (p.type === 'result' || p.event === 'result') {
        return true;
      }
    }
    return false;
  });
}

export interface ResolveRunStatusInput {
  exitCode: number | null;
  signal?: NodeJS.Signals | string | null;
  events: ResultEventLike[];
  isTimeout?: boolean;
  isCancelled?: boolean;
}

export interface RunResolutionResult {
  status: RunStatus;
  reason: string;
  resultEvent?: ResultEventLike | null;
  parsedResult?: AgentResultPayload | null;
}

/**
 * Resolves final run status based on process exit code and stream events:
 *
 * Rules:
 * - isCancelled: CANCELLED
 * - isTimeout: TIMEOUT
 * - exitCode !== 0 or killed by signal: ERROR
 * - exitCode === 0:
 *   - valid result event with SUCCESS / success: true -> SUCCESS
 *   - valid result event with ERROR / FAILED / success: false -> ERROR
 *   - no result event or malformed/invalid result payload -> INVALID_OUTPUT
 */
export function resolveRunStatus(input: ResolveRunStatusInput): RunResolutionResult {
  // 1. Process was cancelled by user
  if (input.isCancelled) {
    return {
      status: 'CANCELLED',
      reason: 'Process execution was cancelled by user or operator',
      resultEvent: null,
      parsedResult: null,
    };
  }

  // 2. Process timed out
  if (input.isTimeout) {
    return {
      status: 'TIMEOUT',
      reason: 'Process execution timed out',
      resultEvent: null,
      parsedResult: null,
    };
  }

  // 3. Process exited with non-zero exit code
  if (input.exitCode !== null && input.exitCode !== 0) {
    return {
      status: 'ERROR',
      reason: `Process exited with non-zero exit code: ${input.exitCode}`,
      resultEvent: null,
      parsedResult: null,
    };
  }

  // Process was terminated by signal without exit code
  if (input.exitCode === null && input.signal) {
    return {
      status: 'ERROR',
      reason: `Process was terminated abruptly by signal: ${input.signal}`,
      resultEvent: null,
      parsedResult: null,
    };
  }

  // 4. Process exited with code 0 (or null without signal):
  // Inspect events for the 'result' event
  const resultEvents = findResultEvents(input.events);
  if (resultEvents.length === 0) {
    return {
      status: 'INVALID_OUTPUT',
      reason: 'Process completed with exit code 0 but emitted no result event',
      resultEvent: null,
      parsedResult: null,
    };
  }

  // Take the final result event
  const lastResultEvent = resultEvents[resultEvents.length - 1]!;
  let rawPayload = lastResultEvent.payload;

  if (typeof rawPayload === 'string') {
    try {
      rawPayload = JSON.parse(rawPayload);
    } catch {
      // Keep string if not parseable JSON
    }
  }

  const parsed = AgentResultPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    const errorMsg = parsed.error.issues.map((i) => i.message).join('; ');
    return {
      status: 'INVALID_OUTPUT',
      reason: `Process completed with exit code 0 but result event payload was invalid: ${errorMsg}`,
      resultEvent: lastResultEvent,
      parsedResult: null,
    };
  }

  const agentResult = parsed.data;
  if (isResultSuccess(agentResult)) {
    return {
      status: 'SUCCESS',
      reason: 'Process completed successfully with valid success result event',
      resultEvent: lastResultEvent,
      parsedResult: agentResult,
    };
  } else {
    const failureMsg =
      agentResult.message ||
      agentResult.summary ||
      (typeof agentResult.error === 'string'
        ? agentResult.error
        : agentResult.error &&
            typeof agentResult.error === 'object' &&
            'message' in agentResult.error
          ? String((agentResult.error as { message: unknown }).message)
          : 'Agent reported error/failure in result event');

    return {
      status: 'ERROR',
      reason: `Process completed with exit code 0 but result event indicated error: ${failureMsg}`,
      resultEvent: lastResultEvent,
      parsedResult: agentResult,
    };
  }
}
