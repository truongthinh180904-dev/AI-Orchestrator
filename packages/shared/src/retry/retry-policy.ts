import { z } from 'zod';
import { AppError } from '../errors.js';
import { TaskStatusSchema, type TaskStatus } from '../models/task.js';

export const RetryStrategySchema = z.enum(['exponential', 'linear', 'fixed'], {
  message: "Retry strategy must be one of 'exponential', 'linear', or 'fixed'",
});

export type RetryStrategy = z.infer<typeof RetryStrategySchema>;

export const RetryPolicyOptionsSchema = z.object({
  max_attempts: z.number().int().min(1, 'max_attempts must be at least 1').default(3),
  strategy: RetryStrategySchema.default('exponential'),
  initial_delay_ms: z.number().int().min(0, 'initial_delay_ms must be non-negative').default(1000),
  max_delay_ms: z.number().int().min(0, 'max_delay_ms must be non-negative').default(30000),
  backoff_factor: z.number().min(1, 'backoff_factor must be at least 1').default(2),
  jitter: z.boolean().default(false),
  jitter_ratio: z.number().min(0).max(1, 'jitter_ratio must be between 0 and 1').default(0.1),
  retryable_statuses: z.array(TaskStatusSchema).default(['FAILED']),
});

export type RetryPolicyOptions = z.infer<typeof RetryPolicyOptionsSchema>;
export type RetryPolicyInput = z.input<typeof RetryPolicyOptionsSchema>;

export const RetryDecisionSchema = z.object({
  shouldRetry: z.boolean(),
  attempt: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  delayMs: z.number().int().min(0),
  strategy: RetryStrategySchema,
  nextRetryAt: z.string().optional(),
  reason: z.string(),
});

export type RetryDecision = z.infer<typeof RetryDecisionSchema>;

export interface TaskRetryCandidate {
  attempts: number;
  max_attempts?: number | null;
  status?: TaskStatus;
}

export interface RetryEvaluationContext {
  error?: unknown;
  status?: TaskStatus;
  fromDate?: Date;
}

export class RetryPolicy {
  public readonly options: RetryPolicyOptions;

  constructor(options?: RetryPolicyInput) {
    this.options = RetryPolicyOptionsSchema.parse(options ?? {});
    if (this.options.max_delay_ms < this.options.initial_delay_ms) {
      throw new AppError(
        'INVALID_RETRY_CONFIG',
        `max_delay_ms (${this.options.max_delay_ms}) must be greater than or equal to initial_delay_ms (${this.options.initial_delay_ms})`,
        { options: this.options },
      );
    }
  }

  /**
   * Tính toán thời gian trễ backoff (milliseconds) cho lần thử thứ `attempt`.
   * `attempt`: Số lần đã chạy xong và thất bại (1-indexed cho retry tiếp theo).
   *
   * Công thức:
   * - Exponential: initial_delay_ms * (backoff_factor ^ (attempt - 1))
   * - Linear: initial_delay_ms * attempt
   * - Fixed: initial_delay_ms
   * Capped tại `max_delay_ms`.
   * Bổ sung Jitter nếu cờ `jitter: true`.
   */
  computeBackoffDelay(attempt: number, customOptions?: Partial<RetryPolicyOptions>): number {
    const opts = { ...this.options, ...customOptions };
    const normalizedAttempt = Math.max(1, Math.floor(attempt));

    let baseDelay = opts.initial_delay_ms;

    switch (opts.strategy) {
      case 'exponential': {
        const factor = Math.pow(opts.backoff_factor, normalizedAttempt - 1);
        baseDelay = opts.initial_delay_ms * factor;
        break;
      }
      case 'linear': {
        baseDelay = opts.initial_delay_ms * normalizedAttempt;
        break;
      }
      case 'fixed': {
        baseDelay = opts.initial_delay_ms;
        break;
      }
    }

    // Giới hạn trần tại max_delay_ms
    let finalDelay = Math.min(baseDelay, opts.max_delay_ms);

    // Áp dụng jitter nếu cấu hình bật
    if (opts.jitter && finalDelay > 0) {
      const maxJitter = finalDelay * opts.jitter_ratio;
      // Dao động ngẫu nhiên trong khoảng [-maxJitter, +maxJitter]
      const delta = (Math.random() * 2 - 1) * maxJitter;
      finalDelay = Math.max(0, Math.min(opts.max_delay_ms, finalDelay + delta));
    }

    return Math.round(finalDelay);
  }

  /**
   * Đánh giá xem task có được phép retry tiếp hay không.
   *
   * Quy tắc cốt lõi ("Không retry vô hạn"):
   * - Nếu task.attempts >= max_attempts → shouldRetry = false (MAX_ATTEMPTS_EXCEEDED).
   * - Nếu task.attempts < max_attempts → shouldRetry = true (RETRY_ATTEMPT_ALLOWED).
   */
  evaluate(task: TaskRetryCandidate, context?: RetryEvaluationContext): RetryDecision {
    const maxAttempts = task.max_attempts ?? this.options.max_attempts;
    const currentAttempts = Math.max(0, task.attempts);

    // Kiểm tra trạng thái có thuộc diện retryable không
    const statusToCheck = context?.status ?? task.status;
    if (statusToCheck && !this.options.retryable_statuses.includes(statusToCheck)) {
      return {
        shouldRetry: false,
        attempt: currentAttempts,
        maxAttempts,
        delayMs: 0,
        strategy: this.options.strategy,
        reason: `STATUS_NOT_RETRYABLE: Status '${statusToCheck}' is not in retryable_statuses`,
      };
    }

    // Kiểm tra chạm ngưỡng tối đa (CHỐNG RETRY VÔ HẠN)
    if (currentAttempts >= maxAttempts) {
      return {
        shouldRetry: false,
        attempt: currentAttempts,
        maxAttempts,
        delayMs: 0,
        strategy: this.options.strategy,
        reason: 'MAX_ATTEMPTS_EXCEEDED',
      };
    }

    // Đủ điều kiện retry: tính toán backoff delay
    const delayMs = this.computeBackoffDelay(currentAttempts);
    const fromDate = context?.fromDate ?? new Date();
    const nextRetryAt = new Date(fromDate.getTime() + delayMs).toISOString();

    return {
      shouldRetry: true,
      attempt: currentAttempts,
      maxAttempts,
      delayMs,
      strategy: this.options.strategy,
      nextRetryAt,
      reason: 'RETRY_ATTEMPT_ALLOWED',
    };
  }

  /**
   * Kiểm tra nhanh boolean task có thể retry không.
   */
  canRetry(task: TaskRetryCandidate, context?: RetryEvaluationContext): boolean {
    return this.evaluate(task, context).shouldRetry;
  }

  /**
   * Khởi tạo RetryPolicy mặc định chuẩn cho toàn bộ hệ thống.
   */
  static defaultPolicy(): RetryPolicy {
    return new RetryPolicy();
  }
}
