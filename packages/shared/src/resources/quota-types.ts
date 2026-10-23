import { z } from 'zod';

export const ResourceQuotaConfigSchema = z.object({
  /**
   * Concurrency limit: maximum number of concurrent agent/coding processes allowed.
   * Chốt quy tắc: "Tối đa 1 coding process tại một thời điểm".
   */
  max_concurrency: z.number().int().min(1, 'max_concurrency must be at least 1').default(1),

  /**
   * Maximum runs allowed in rolling window (e.g. 60 runs/hour).
   */
  max_runs_per_window: z.number().int().min(1, 'max_runs_per_window must be at least 1').default(60),

  /**
   * Duration of rolling quota window in milliseconds (default 1 hour = 3600000ms).
   */
  window_duration_ms: z.number().int().min(1000, 'window_duration_ms must be at least 1000ms').default(3_600_000),

  /**
   * Cooldown period between consecutive runs in milliseconds (e.g. 180s = 180000ms).
   */
  cooldown_ms: z.number().int().min(0, 'cooldown_ms must be non-negative').default(0),

  /**
   * Initial backoff when a quota / rate limit hit occurs (default 30 mins = 1800000ms).
   */
  quota_backoff_ms: z.number().int().min(0, 'quota_backoff_ms must be non-negative').default(1_800_000),

  /**
   * Exponential backoff multiplier for consecutive quota hits.
   */
  quota_backoff_multiplier: z.number().min(1, 'quota_backoff_multiplier must be at least 1').default(2),

  /**
   * Maximum backoff ceiling in milliseconds (default 2 hours = 7200000ms).
   */
  max_quota_backoff_ms: z.number().int().min(0, 'max_quota_backoff_ms must be non-negative').default(7_200_000),

  /**
   * Maximum consecutive quota hits before tripping the circuit breaker (halts all runs).
   */
  max_consecutive_quota_hits: z.number().int().min(1, 'max_consecutive_quota_hits must be at least 1').default(4),

  /**
   * Automatically reset consecutive quota hits to 0 upon a successful run.
   */
  auto_reset_quota_on_success: z.boolean().default(true),
});

export type ResourceQuotaConfig = z.infer<typeof ResourceQuotaConfigSchema>;
export type ResourceQuotaConfigInput = z.input<typeof ResourceQuotaConfigSchema>;

export const ResourceRejectReasonSchema = z.enum([
  'CONCURRENCY_LIMIT_REACHED',
  'COOLDOWN_ACTIVE',
  'QUOTA_BACKOFF_ACTIVE',
  'CIRCUIT_BREAKER_TRIPPED',
  'WINDOW_QUOTA_EXCEEDED',
  'RESOURCE_THROTTLED',
]);

export type ResourceRejectReason = z.infer<typeof ResourceRejectReasonSchema>;

export interface ResourceAcquisitionResult {
  allowed: boolean;
  reason?: ResourceRejectReason;
  retryAfterMs?: number;
  activeTaskId?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface ResourceQuotaStatus {
  activeConcurrency: number;
  maxConcurrency: number;
  availableConcurrency: number;
  activeTasks: string[];
  consecutiveQuotaHits: number;
  maxQuotaHits: number;
  isThrottled: boolean;
  isCircuitBreakerTripped: boolean;
  backoffUntil: string | null;
  backoffRemainingMs: number;
  cooldownUntil: string | null;
  cooldownRemainingMs: number;
  windowRuns: number;
  maxRunsPerWindow: number;
  windowRemainingQuota: number;
  windowResetAt: string;
  config: ResourceQuotaConfig;
}

export const QuotaEventTypeSchema = z.enum([
  'QUOTA_HIT',
  'BACKOFF_ENTERED',
  'COOLDOWN_STARTED',
  'CIRCUIT_BREAKER_TRIPPED',
  'QUOTA_RESET',
  'SLOT_ACQUIRED',
  'SLOT_RELEASED',
  'CONFIG_UPDATED',
]);

export type QuotaEventType = z.infer<typeof QuotaEventTypeSchema>;

export interface QuotaEventRecord {
  id: string;
  event_type: QuotaEventType;
  task_id?: string | null;
  run_id?: string | null;
  backoff_ms: number;
  consecutive_hits: number;
  details: Record<string, unknown>;
  created_at: string;
}

export interface CreateQuotaEventInput {
  id?: string;
  event_type: QuotaEventType;
  task_id?: string | null;
  run_id?: string | null;
  backoff_ms?: number;
  consecutive_hits?: number;
  details?: Record<string, unknown>;
  created_at?: string;
}

const QUOTA_ERROR_REGEX = /quota|rate.?limit|429|too many requests|resource.?exhausted|overloaded/i;

/**
 * Checks whether an unknown error or message matches known rate limit / quota exhaustion patterns.
 */
export function isQuotaOrRateLimitError(error: unknown): boolean {
  if (!error) return false;

  if (typeof error === 'string') {
    return QUOTA_ERROR_REGEX.test(error);
  }

  if (error instanceof Error) {
    if (QUOTA_ERROR_REGEX.test(error.message)) return true;
    if ('code' in error && typeof (error as Record<string, unknown>).code === 'string') {
      const code = String((error as Record<string, unknown>).code);
      if (QUOTA_ERROR_REGEX.test(code)) return true;
    }
  }

  if (typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === 'string' && QUOTA_ERROR_REGEX.test(obj.message)) return true;
    if (typeof obj.code === 'string' && QUOTA_ERROR_REGEX.test(obj.code)) return true;
    if (obj.status === 429 || obj.statusCode === 429) return true;
    if (typeof obj.reason === 'string' && QUOTA_ERROR_REGEX.test(obj.reason)) return true;
  }

  return false;
}
