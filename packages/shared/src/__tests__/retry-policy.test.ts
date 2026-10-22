import { describe, expect, it } from 'vitest';
import { RetryPolicy, RetryPolicyOptionsSchema } from '../index.js';

describe('RetryPolicy Unit Tests (ORC-004)', () => {
  describe('Options & Initialization', () => {
    it('sử dụng giá trị mặc định chuẩn: max_attempts=3, strategy=exponential, initial_delay_ms=1000, max_delay_ms=30000, factor=2', () => {
      const policy = new RetryPolicy();
      expect(policy.options.max_attempts).toBe(3);
      expect(policy.options.strategy).toBe('exponential');
      expect(policy.options.initial_delay_ms).toBe(1000);
      expect(policy.options.max_delay_ms).toBe(30000);
      expect(policy.options.backoff_factor).toBe(2);
      expect(policy.options.jitter).toBe(false);
      expect(policy.options.retryable_statuses).toEqual(['FAILED']);
    });

    it('từ chối cấu hình không hợp lệ: max_delay_ms < initial_delay_ms', () => {
      expect(() => {
        new RetryPolicy({ initial_delay_ms: 5000, max_delay_ms: 1000 });
      }).toThrowError(
        expect.objectContaining({
          code: 'INVALID_RETRY_CONFIG',
        }),
      );
    });

    it('validate schema bằng Zod chuẩn', () => {
      const parsed = RetryPolicyOptionsSchema.parse({
        max_attempts: 5,
        strategy: 'linear',
        initial_delay_ms: 500,
        max_delay_ms: 10000,
      });
      expect(parsed.max_attempts).toBe(5);
      expect(parsed.strategy).toBe('linear');
      expect(parsed.initial_delay_ms).toBe(500);
    });
  });

  describe('Nghiệm thu: Không retry vô hạn & Quyết định Retry', () => {
    it('khi task.attempts < max_attempts: cho phép retry (shouldRetry = true)', () => {
      const policy = new RetryPolicy({ max_attempts: 3 });

      const candidate1 = { attempts: 0, max_attempts: 3, status: 'FAILED' as const };
      const decision1 = policy.evaluate(candidate1);
      expect(decision1.shouldRetry).toBe(true);
      expect(decision1.reason).toBe('RETRY_ATTEMPT_ALLOWED');
      expect(decision1.maxAttempts).toBe(3);
      expect(decision1.nextRetryAt).toBeTruthy();

      const candidate2 = { attempts: 1, max_attempts: 3, status: 'FAILED' as const };
      const decision2 = policy.evaluate(candidate2);
      expect(decision2.shouldRetry).toBe(true);
      expect(decision2.attempt).toBe(1);

      const candidate3 = { attempts: 2, max_attempts: 3, status: 'FAILED' as const };
      const decision3 = policy.evaluate(candidate3);
      expect(decision3.shouldRetry).toBe(true);
    });

    it('Nghiệm thu ROADMAP: Không retry vô hạn — khi attempts >= max_attempts, CHẶN retry tuyệt đối (shouldRetry = false)', () => {
      const policy = new RetryPolicy({ max_attempts: 3 });

      // Đã thử đủ 3 lần
      const candidateAtLimit = { attempts: 3, max_attempts: 3, status: 'FAILED' as const };
      const decisionAtLimit = policy.evaluate(candidateAtLimit);
      expect(decisionAtLimit.shouldRetry).toBe(false);
      expect(decisionAtLimit.reason).toBe('MAX_ATTEMPTS_EXCEEDED');
      expect(decisionAtLimit.delayMs).toBe(0);
      expect(policy.canRetry(candidateAtLimit)).toBe(false);

      // Đã vượt quá 3 lần (vd: 4, 10, 100)
      const candidateExceeded = { attempts: 4, max_attempts: 3, status: 'FAILED' as const };
      const decisionExceeded = policy.evaluate(candidateExceeded);
      expect(decisionExceeded.shouldRetry).toBe(false);
      expect(decisionExceeded.reason).toBe('MAX_ATTEMPTS_EXCEEDED');
      expect(policy.canRetry(candidateExceeded)).toBe(false);
    });

    it('tôn trọng max_attempts được ghi đè riêng trên từng task', () => {
      const policy = new RetryPolicy({ max_attempts: 3 });

      // Task này chỉ cho phép tối đa 1 lần thử
      const strictTask = { attempts: 1, max_attempts: 1, status: 'FAILED' as const };
      expect(policy.canRetry(strictTask)).toBe(false);

      // Task này cho phép tới 5 lần thử
      const tolerantTask = { attempts: 3, max_attempts: 5, status: 'FAILED' as const };
      expect(policy.canRetry(tolerantTask)).toBe(true);
    });

    it('từ chối retry nếu trạng thái task không nằm trong retryable_statuses', () => {
      const policy = new RetryPolicy({ max_attempts: 3, retryable_statuses: ['FAILED'] });

      const doneTask = { attempts: 1, max_attempts: 3, status: 'DONE' as const };
      const decisionDone = policy.evaluate(doneTask);
      expect(decisionDone.shouldRetry).toBe(false);
      expect(decisionDone.reason).toContain('STATUS_NOT_RETRYABLE');

      const cancelledTask = { attempts: 1, max_attempts: 3, status: 'CANCELLED' as const };
      expect(policy.canRetry(cancelledTask)).toBe(false);
    });
  });

  describe('Tính toán Backoff Delay (Exponential, Linear, Fixed & Cap)', () => {
    it('Exponential Backoff: tính toán đúng 1000ms -> 2000ms -> 4000ms -> 8000ms', () => {
      const policy = new RetryPolicy({
        strategy: 'exponential',
        initial_delay_ms: 1000,
        backoff_factor: 2,
        max_delay_ms: 10000,
        jitter: false,
      });

      // Lần thất bại 1: delay cho attempt 2 = 1000 * 2^0 = 1000ms
      expect(policy.computeBackoffDelay(1)).toBe(1000);
      // Lần thất bại 2: delay cho attempt 3 = 1000 * 2^1 = 2000ms
      expect(policy.computeBackoffDelay(2)).toBe(2000);
      // Lần thất bại 3: delay cho attempt 4 = 1000 * 2^2 = 4000ms
      expect(policy.computeBackoffDelay(3)).toBe(4000);
      // Lần thất bại 4: delay cho attempt 5 = 1000 * 2^3 = 8000ms
      expect(policy.computeBackoffDelay(4)).toBe(8000);
      // Lần thất bại 5: 1000 * 2^4 = 16000ms -> Capped tại max_delay_ms = 10000ms
      expect(policy.computeBackoffDelay(5)).toBe(10000);
    });

    it('Linear Backoff: tính toán đúng 500ms -> 1000ms -> 1500ms -> capped', () => {
      const policy = new RetryPolicy({
        strategy: 'linear',
        initial_delay_ms: 500,
        max_delay_ms: 2000,
        jitter: false,
      });

      expect(policy.computeBackoffDelay(1)).toBe(500);
      expect(policy.computeBackoffDelay(2)).toBe(1000);
      expect(policy.computeBackoffDelay(3)).toBe(1500);
      expect(policy.computeBackoffDelay(4)).toBe(2000);
      expect(policy.computeBackoffDelay(5)).toBe(2000); // capped
    });

    it('Fixed Backoff: luôn giữ nguyên initial_delay_ms', () => {
      const policy = new RetryPolicy({
        strategy: 'fixed',
        initial_delay_ms: 1500,
        jitter: false,
      });

      expect(policy.computeBackoffDelay(1)).toBe(1500);
      expect(policy.computeBackoffDelay(2)).toBe(1500);
      expect(policy.computeBackoffDelay(5)).toBe(1500);
    });

    it('Jitter: biến thiên độ trễ trong khoảng jitter_ratio an toàn', () => {
      const policy = new RetryPolicy({
        strategy: 'fixed',
        initial_delay_ms: 1000,
        jitter: true,
        jitter_ratio: 0.2, // +/- 20% tức trong khoảng [800, 1200]
      });

      for (let i = 0; i < 20; i++) {
        const delay = policy.computeBackoffDelay(1);
        expect(delay).toBeGreaterThanOrEqual(800);
        expect(delay).toBeLessThanOrEqual(1200);
      }
    });

    it('tính toán nextRetryAt chính xác dựa trên fromDate', () => {
      const policy = new RetryPolicy({
        strategy: 'fixed',
        initial_delay_ms: 2500,
        jitter: false,
      });

      const fixedDate = new Date('2026-10-23T10:00:00.000Z');
      const decision = policy.evaluate(
        { attempts: 1, max_attempts: 3, status: 'FAILED' },
        { fromDate: fixedDate },
      );

      expect(decision.delayMs).toBe(2500);
      expect(decision.nextRetryAt).toBe('2026-10-23T10:00:02.500Z');
    });
  });
});
