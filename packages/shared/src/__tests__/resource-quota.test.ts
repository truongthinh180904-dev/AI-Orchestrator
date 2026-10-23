import { describe, expect, it } from 'vitest';
import {
  ResourceQuotaConfigSchema,
  isQuotaOrRateLimitError,
} from '../resources/quota-types.js';

describe('Resource Quota Schemas and Utilities', () => {
  describe('ResourceQuotaConfigSchema', () => {
    it('provides sensible overnight defaults matching RUN.md and AGENTS.md', () => {
      const config = ResourceQuotaConfigSchema.parse({});
      expect(config.max_concurrency).toBe(1);
      expect(config.max_runs_per_window).toBe(60);
      expect(config.window_duration_ms).toBe(3_600_000);
      expect(config.cooldown_ms).toBe(0);
      expect(config.quota_backoff_ms).toBe(1_800_000);
      expect(config.quota_backoff_multiplier).toBe(2);
      expect(config.max_quota_backoff_ms).toBe(7_200_000);
      expect(config.max_consecutive_quota_hits).toBe(4);
      expect(config.auto_reset_quota_on_success).toBe(true);
    });

    it('rejects invalid inputs', () => {
      expect(() => ResourceQuotaConfigSchema.parse({ max_concurrency: 0 })).toThrow();
      expect(() => ResourceQuotaConfigSchema.parse({ max_concurrency: -1 })).toThrow();
      expect(() => ResourceQuotaConfigSchema.parse({ max_runs_per_window: 0 })).toThrow();
      expect(() => ResourceQuotaConfigSchema.parse({ window_duration_ms: 500 })).toThrow();
      expect(() => ResourceQuotaConfigSchema.parse({ cooldown_ms: -5 })).toThrow();
      expect(() => ResourceQuotaConfigSchema.parse({ quota_backoff_ms: -1 })).toThrow();
      expect(() => ResourceQuotaConfigSchema.parse({ max_consecutive_quota_hits: 0 })).toThrow();
    });

    it('accepts custom valid overrides', () => {
      const config = ResourceQuotaConfigSchema.parse({
        max_concurrency: 2,
        max_runs_per_window: 10,
        cooldown_ms: 180_000,
        quota_backoff_ms: 60_000,
        max_consecutive_quota_hits: 3,
      });
      expect(config.max_concurrency).toBe(2);
      expect(config.max_runs_per_window).toBe(10);
      expect(config.cooldown_ms).toBe(180_000);
      expect(config.quota_backoff_ms).toBe(60_000);
      expect(config.max_consecutive_quota_hits).toBe(3);
    });
  });

  describe('isQuotaOrRateLimitError', () => {
    it('detects string errors matching quota patterns', () => {
      expect(isQuotaOrRateLimitError('Error: 429 Too Many Requests')).toBe(true);
      expect(isQuotaOrRateLimitError('Rate limit exceeded. Please wait.')).toBe(true);
      expect(isQuotaOrRateLimitError('resource_exhausted: quota limit reached')).toBe(true);
      expect(isQuotaOrRateLimitError('Server overloaded, retry later')).toBe(true);
      expect(isQuotaOrRateLimitError('daily quota exhausted')).toBe(true);
      expect(isQuotaOrRateLimitError('SyntaxError: unexpected token')).toBe(false);
      expect(isQuotaOrRateLimitError('Process exited with code 1')).toBe(false);
    });

    it('detects Error objects with message or code', () => {
      const err1 = new Error('HTTP 429: Too Many Requests');
      expect(isQuotaOrRateLimitError(err1)).toBe(true);

      const err2 = new Error('Normal failure');
      (err2 as unknown as { code: string }).code = 'RESOURCE_EXHAUSTED';
      expect(isQuotaOrRateLimitError(err2)).toBe(true);

      const err3 = new Error('Database locked');
      expect(isQuotaOrRateLimitError(err3)).toBe(false);
    });

    it('detects objects with status 429 or statusCode 429', () => {
      expect(isQuotaOrRateLimitError({ status: 429 })).toBe(true);
      expect(isQuotaOrRateLimitError({ statusCode: 429 })).toBe(true);
      expect(isQuotaOrRateLimitError({ status: 500 })).toBe(false);
    });

    it('handles null and undefined safely', () => {
      expect(isQuotaOrRateLimitError(null)).toBe(false);
      expect(isQuotaOrRateLimitError(undefined)).toBe(false);
    });
  });
});
