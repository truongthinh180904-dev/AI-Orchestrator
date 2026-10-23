import type Database from 'better-sqlite3';
import {
  type ResourceQuotaConfig,
  type ResourceQuotaConfigInput,
  ResourceQuotaConfigSchema,
  type ResourceQuotaStatus,
  type ResourceAcquisitionResult,
  type QuotaEventRecord,
  AppError,
  logger,
} from '@ai-orchestrator/shared';
import { QuotaEventRepository } from '@ai-orchestrator/db';

export interface ResourceQuotaManagerOptions {
  db?: Database.Database;
  config?: ResourceQuotaConfigInput;
  clock?: () => number;
}

export class ResourceQuotaManager {
  private config: ResourceQuotaConfig;
  private readonly db?: Database.Database;
  private readonly quotaEventRepo?: QuotaEventRepository;
  private readonly clock: () => number;

  private activeTasks: Map<string, { runId?: string; acquiredAt: number }> = new Map();
  private consecutiveQuotaHits = 0;
  private backoffUntilMs: number | null = null;
  private cooldownUntilMs: number | null = null;
  private circuitBreakerTripped = false;
  private windowRunTimestamps: number[] = [];

  constructor(options?: ResourceQuotaManagerOptions) {
    this.config = ResourceQuotaConfigSchema.parse(options?.config ?? {});
    this.clock = options?.clock ?? (() => Date.now());

    if (options?.db) {
      this.db = options.db;
      this.quotaEventRepo = new QuotaEventRepository(options.db);
    }
  }

  get currentConfig(): ResourceQuotaConfig {
    return { ...this.config };
  }

  get isCircuitBreakerTripped(): boolean {
    return this.circuitBreakerTripped;
  }

  get activeConcurrency(): number {
    return this.activeTasks.size;
  }

  /**
   * Updates configuration dynamically with validation.
   */
  updateConfig(updates: Partial<ResourceQuotaConfigInput>): ResourceQuotaConfig {
    const merged = { ...this.config, ...updates };
    this.config = ResourceQuotaConfigSchema.parse(merged);

    logger.info('Resource quota configuration updated', { config: this.config });

    if (this.quotaEventRepo) {
      try {
        this.quotaEventRepo.create({
          event_type: 'CONFIG_UPDATED',
          details: { config: this.config },
          created_at: new Date(this.clock()).toISOString(),
        });
      } catch {
        // non-critical
      }
    }

    return { ...this.config };
  }

  /**
   * Prunes expired timestamps from the rolling rate limit window.
   */
  private pruneWindow(now: number): void {
    const threshold = now - this.config.window_duration_ms;
    this.windowRunTimestamps = this.windowRunTimestamps.filter((ts) => ts > threshold);
  }

  /**
   * Evaluates whether a new task or coding process can be acquired right now.
   */
  canAcquire(context?: { taskId?: string }): ResourceAcquisitionResult {
    const now = this.clock();

    // 1. Circuit breaker check (too many consecutive quota hits)
    if (this.circuitBreakerTripped) {
      return {
        allowed: false,
        reason: 'CIRCUIT_BREAKER_TRIPPED',
        message: `Circuit breaker tripped after ${this.consecutiveQuotaHits} consecutive quota hits. Manual reset required.`,
        details: { consecutiveQuotaHits: this.consecutiveQuotaHits },
      };
    }

    // 2. Quota backoff check
    if (this.backoffUntilMs !== null && now < this.backoffUntilMs) {
      const retryAfterMs = this.backoffUntilMs - now;
      return {
        allowed: false,
        reason: 'QUOTA_BACKOFF_ACTIVE',
        retryAfterMs,
        message: `Quota rate limit backoff active. Remaining delay: ${retryAfterMs}ms.`,
        details: { backoffUntil: new Date(this.backoffUntilMs).toISOString(), retryAfterMs },
      };
    } else if (this.backoffUntilMs !== null && now >= this.backoffUntilMs) {
      // Backoff expired
      this.backoffUntilMs = null;
    }

    // 3. Cooldown check between runs
    if (this.cooldownUntilMs !== null && now < this.cooldownUntilMs) {
      const retryAfterMs = this.cooldownUntilMs - now;
      return {
        allowed: false,
        reason: 'COOLDOWN_ACTIVE',
        retryAfterMs,
        message: `Inter-run cooldown active. Remaining cooldown: ${retryAfterMs}ms.`,
        details: { cooldownUntil: new Date(this.cooldownUntilMs).toISOString(), retryAfterMs },
      };
    } else if (this.cooldownUntilMs !== null && now >= this.cooldownUntilMs) {
      // Cooldown expired
      this.cooldownUntilMs = null;
    }

    // 4. Concurrency limit check
    const taskId = context?.taskId;
    const isAlreadyActiveForTask = taskId ? this.activeTasks.has(taskId) : false;

    if (!isAlreadyActiveForTask && this.activeTasks.size >= this.config.max_concurrency) {
      const activeIds = Array.from(this.activeTasks.keys());
      return {
        allowed: false,
        reason: 'CONCURRENCY_LIMIT_REACHED',
        activeTaskId: activeIds[0],
        message: `Active concurrency (${this.activeTasks.size}) reached maximum limit (${this.config.max_concurrency}).`,
        details: {
          activeConcurrency: this.activeTasks.size,
          maxConcurrency: this.config.max_concurrency,
          activeTasks: activeIds,
        },
      };
    }

    // 5. Rolling window quota check
    this.pruneWindow(now);
    if (this.windowRunTimestamps.length >= this.config.max_runs_per_window) {
      const oldestTs = this.windowRunTimestamps[0] ?? now;
      const resetTime = oldestTs + this.config.window_duration_ms;
      const retryAfterMs = Math.max(0, resetTime - now);
      return {
        allowed: false,
        reason: 'WINDOW_QUOTA_EXCEEDED',
        retryAfterMs,
        message: `Hourly run quota reached (${this.windowRunTimestamps.length}/${this.config.max_runs_per_window}).`,
        details: {
          windowRuns: this.windowRunTimestamps.length,
          maxRunsPerWindow: this.config.max_runs_per_window,
          retryAfterMs,
        },
      };
    }

    return { allowed: true };
  }

  /**
   * Atomically acquires a concurrency and quota slot for a task.
   */
  acquireSlot(taskId: string, runId?: string): { acquired: boolean; taskId: string; acquiredAt: number } {
    const check = this.canAcquire({ taskId });
    if (!check.allowed) {
      throw new AppError('RESOURCE_LIMIT_EXCEEDED', check.message ?? 'Resource quota limit exceeded', {
        reason: check.reason,
        retryAfterMs: check.retryAfterMs,
        activeTaskId: check.activeTaskId,
        details: check.details,
      });
    }

    const now = this.clock();
    this.activeTasks.set(taskId, { runId, acquiredAt: now });
    this.windowRunTimestamps.push(now);

    logger.info(`Acquired resource slot for task '${taskId}'`, {
      taskId,
      runId,
      activeConcurrency: this.activeTasks.size,
    });

    if (this.quotaEventRepo) {
      try {
        this.quotaEventRepo.create({
          event_type: 'SLOT_ACQUIRED',
          task_id: taskId,
          run_id: runId ?? null,
          details: { activeConcurrency: this.activeTasks.size },
          created_at: new Date(now).toISOString(),
        });
      } catch {
        // non-critical
      }
    }

    return { acquired: true, taskId, acquiredAt: now };
  }

  /**
   * Releases an active slot and initiates inter-run cooldown if configured.
   */
  releaseSlot(taskId: string, runId?: string): void {
    const wasActive = this.activeTasks.delete(taskId);
    const now = this.clock();

    if (wasActive && this.config.cooldown_ms > 0) {
      this.cooldownUntilMs = now + this.config.cooldown_ms;
      logger.info(`Started cooldown of ${this.config.cooldown_ms}ms after task '${taskId}'`, {
        taskId,
        cooldownUntil: new Date(this.cooldownUntilMs).toISOString(),
      });
    }

    if (this.quotaEventRepo) {
      try {
        this.quotaEventRepo.create({
          event_type: 'SLOT_RELEASED',
          task_id: taskId,
          run_id: runId ?? null,
          details: {
            activeConcurrency: this.activeTasks.size,
            cooldownMs: this.config.cooldown_ms,
          },
          created_at: new Date(now).toISOString(),
        });
      } catch {
        // non-critical
      }
    }
  }

  /**
   * Records a quota hit / 429 rate limit event, triggering exponential backoff
   * and potentially the circuit breaker.
   */
  recordQuotaHit(options?: {
    taskId?: string;
    runId?: string;
    error?: unknown;
    customBackoffMs?: number;
  }): { backoffMs: number; consecutiveHits: number; circuitBreakerTripped: boolean } {
    const now = this.clock();
    this.consecutiveQuotaHits += 1;

    let delayMs = options?.customBackoffMs;
    if (delayMs === undefined) {
      const exponent = Math.max(0, this.consecutiveQuotaHits - 1);
      const factor = Math.pow(this.config.quota_backoff_multiplier, exponent);
      delayMs = Math.min(
        this.config.quota_backoff_ms * factor,
        this.config.max_quota_backoff_ms,
      );
    }

    this.backoffUntilMs = now + delayMs;

    if (this.consecutiveQuotaHits >= this.config.max_consecutive_quota_hits) {
      this.circuitBreakerTripped = true;
      logger.error(
        `Resource quota circuit breaker tripped after ${this.consecutiveQuotaHits} consecutive hits!`,
        {
          taskId: options?.taskId,
          consecutiveHits: this.consecutiveQuotaHits,
          maxHits: this.config.max_consecutive_quota_hits,
        },
      );
    } else {
      logger.warn(
        `Quota/Rate limit hit (${this.consecutiveQuotaHits}/${this.config.max_consecutive_quota_hits}), backing off for ${delayMs}ms`,
        {
          taskId: options?.taskId,
          backoffMs: delayMs,
          backoffUntil: new Date(this.backoffUntilMs).toISOString(),
        },
      );
    }

    if (this.quotaEventRepo) {
      try {
        this.quotaEventRepo.create({
          event_type: this.circuitBreakerTripped ? 'CIRCUIT_BREAKER_TRIPPED' : 'QUOTA_HIT',
          task_id: options?.taskId ?? null,
          run_id: options?.runId ?? null,
          backoff_ms: delayMs,
          consecutive_hits: this.consecutiveQuotaHits,
          details: {
            error: options?.error instanceof Error ? options.error.message : String(options?.error ?? ''),
            circuitBreakerTripped: this.circuitBreakerTripped,
          },
          created_at: new Date(now).toISOString(),
        });
      } catch {
        // non-critical
      }
    }

    return {
      backoffMs: delayMs,
      consecutiveHits: this.consecutiveQuotaHits,
      circuitBreakerTripped: this.circuitBreakerTripped,
    };
  }

  /**
   * Records a successful run, optionally resetting consecutive quota hits.
   */
  recordSuccess(taskId?: string, runId?: string): void {
    if (this.config.auto_reset_quota_on_success && this.consecutiveQuotaHits > 0) {
      logger.info(`Task success: auto-resetting consecutive quota hits from ${this.consecutiveQuotaHits} to 0`, {
        taskId,
        runId,
      });
      this.consecutiveQuotaHits = 0;
      this.backoffUntilMs = null;
    }
  }

  /**
   * Manually resets quota hits, backoff delays, and trips.
   */
  resetQuota(): void {
    const now = this.clock();
    this.consecutiveQuotaHits = 0;
    this.backoffUntilMs = null;
    this.circuitBreakerTripped = false;

    logger.info('Resource quota and circuit breaker reset manually');

    if (this.quotaEventRepo) {
      try {
        this.quotaEventRepo.create({
          event_type: 'QUOTA_RESET',
          details: { resetAt: new Date(now).toISOString() },
          created_at: new Date(now).toISOString(),
        });
      } catch {
        // non-critical
      }
    }
  }

  /**
   * Retrieves the current comprehensive real-time status of the Resource & Quota Manager.
   */
  getStatus(): ResourceQuotaStatus {
    const now = this.clock();
    this.pruneWindow(now);

    const backoffRemainingMs =
      this.backoffUntilMs !== null && this.backoffUntilMs > now ? this.backoffUntilMs - now : 0;
    const cooldownRemainingMs =
      this.cooldownUntilMs !== null && this.cooldownUntilMs > now ? this.cooldownUntilMs - now : 0;

    const oldestTs = this.windowRunTimestamps[0] ?? now;
    const windowResetAt = new Date(oldestTs + this.config.window_duration_ms).toISOString();

    const isThrottled =
      this.circuitBreakerTripped ||
      backoffRemainingMs > 0 ||
      cooldownRemainingMs > 0 ||
      this.windowRunTimestamps.length >= this.config.max_runs_per_window;

    return {
      activeConcurrency: this.activeTasks.size,
      maxConcurrency: this.config.max_concurrency,
      availableConcurrency: Math.max(0, this.config.max_concurrency - this.activeTasks.size),
      activeTasks: Array.from(this.activeTasks.keys()),
      consecutiveQuotaHits: this.consecutiveQuotaHits,
      maxQuotaHits: this.config.max_consecutive_quota_hits,
      isThrottled,
      isCircuitBreakerTripped: this.circuitBreakerTripped,
      backoffUntil: this.backoffUntilMs !== null ? new Date(this.backoffUntilMs).toISOString() : null,
      backoffRemainingMs,
      cooldownUntil: this.cooldownUntilMs !== null ? new Date(this.cooldownUntilMs).toISOString() : null,
      cooldownRemainingMs,
      windowRuns: this.windowRunTimestamps.length,
      maxRunsPerWindow: this.config.max_runs_per_window,
      windowRemainingQuota: Math.max(0, this.config.max_runs_per_window - this.windowRunTimestamps.length),
      windowResetAt,
      config: this.currentConfig,
    };
  }

  /**
   * Returns recent quota events if DB is available.
   */
  getEvents(limit = 50): QuotaEventRecord[] {
    if (!this.quotaEventRepo) return [];
    return this.quotaEventRepo.list({ limit });
  }
}
