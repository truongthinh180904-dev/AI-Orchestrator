import { describe, expect, it } from 'vitest';
import {
  AgentResultPayloadSchema,
  isResultSuccess,
  findResultEvents,
  resolveRunStatus,
} from '../models/result.js';

describe('AGY-004: Result Model & Run Status Resolver', () => {
  describe('AgentResultPayloadSchema validation', () => {
    it('validates a standard success payload', () => {
      const parsed = AgentResultPayloadSchema.safeParse({
        type: 'result',
        status: 'SUCCESS',
        summary: 'All steps executed',
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status).toBe('SUCCESS');
        expect(parsed.data.summary).toBe('All steps executed');
      }
    });

    it('normalizes lowercase status to uppercase', () => {
      const parsed = AgentResultPayloadSchema.safeParse({
        status: 'success',
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status).toBe('SUCCESS');
      }
    });

    it('validates error and failed payloads', () => {
      const errParsed = AgentResultPayloadSchema.safeParse({
        status: 'ERROR',
        message: 'Compilation error',
      });
      expect(errParsed.success).toBe(true);
      if (errParsed.success) {
        expect(errParsed.data.status).toBe('ERROR');
      }

      const failParsed = AgentResultPayloadSchema.safeParse({
        status: 'FAILED',
        error: { code: 'FAIL', details: 'assertion failed' },
      });
      expect(failParsed.success).toBe(true);
      if (failParsed.success) {
        expect(failParsed.data.status).toBe('FAILED');
      }
    });

    it('validates boolean success property', () => {
      const trueParsed = AgentResultPayloadSchema.safeParse({
        success: true,
      });
      expect(trueParsed.success).toBe(true);

      const falseParsed = AgentResultPayloadSchema.safeParse({
        success: false,
        message: 'Something went wrong',
      });
      expect(falseParsed.success).toBe(true);
    });

    it('rejects payloads without status or success', () => {
      const parsed = AgentResultPayloadSchema.safeParse({
        type: 'result',
        summary: 'No status or success provided',
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects invalid status values', () => {
      const parsed = AgentResultPayloadSchema.safeParse({
        status: 'UNKNOWN_STATUS',
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects non-object payloads', () => {
      expect(AgentResultPayloadSchema.safeParse('result').success).toBe(false);
      expect(AgentResultPayloadSchema.safeParse(null).success).toBe(false);
      expect(AgentResultPayloadSchema.safeParse(123).success).toBe(false);
    });
  });

  describe('isResultSuccess()', () => {
    it('identifies successful payloads', () => {
      expect(isResultSuccess({ status: 'SUCCESS' })).toBe(true);
      expect(isResultSuccess({ success: true })).toBe(true);
      expect(isResultSuccess({ status: 'SUCCESS', success: true })).toBe(true);
    });

    it('identifies failure payloads', () => {
      expect(isResultSuccess({ status: 'ERROR' })).toBe(false);
      expect(isResultSuccess({ status: 'FAILED' })).toBe(false);
      expect(isResultSuccess({ success: false })).toBe(false);
      expect(isResultSuccess({ status: 'ERROR', success: false })).toBe(false);
    });
  });

  describe('findResultEvents()', () => {
    it('finds events with type === "result"', () => {
      const events = [
        { type: 'process_start', payload: {} },
        { type: 'stdout', payload: { text: 'hello' } },
        { type: 'result', payload: { status: 'SUCCESS' } },
      ];
      const results = findResultEvents(events);
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe('result');
    });

    it('finds events where payload contains type: "result" or event: "result"', () => {
      const events = [
        { type: 'json', payload: { type: 'result', status: 'SUCCESS' } },
        { type: 'custom', payload: { event: 'result', success: true } },
      ];
      const results = findResultEvents(events);
      expect(results).toHaveLength(2);
    });
  });

  describe('resolveRunStatus() — Core Requirements', () => {
    // ------------------------------------------------------------------------
    // TRƯỜNG HỢP 1: SUCCESS
    // exit 0 + có event result hợp lệ báo SUCCESS
    // ------------------------------------------------------------------------
    describe('Trường hợp 1: SUCCESS', () => {
      it('resolves to SUCCESS when exit code is 0 and event result has status SUCCESS', () => {
        const resolution = resolveRunStatus({
          exitCode: 0,
          events: [
            { type: 'process_start', payload: { pid: 100 } },
            { type: 'stdout', payload: { text: 'Step 1 complete' } },
            { type: 'result', payload: { type: 'result', status: 'SUCCESS', summary: 'All good' } },
            { type: 'process_exit', payload: { exitCode: 0 } },
          ],
        });

        expect(resolution.status).toBe('SUCCESS');
        expect(resolution.resultEvent).toBeDefined();
        expect(resolution.parsedResult?.status).toBe('SUCCESS');
        expect(resolution.parsedResult?.summary).toBe('All good');
      });

      it('resolves to SUCCESS when exit code is 0 and event result has success: true', () => {
        const resolution = resolveRunStatus({
          exitCode: 0,
          events: [{ type: 'result', payload: { success: true, data: { items: 5 } } }],
        });

        expect(resolution.status).toBe('SUCCESS');
        expect(resolution.parsedResult?.success).toBe(true);
      });

      it('resolves to SUCCESS with case-insensitive status: "success"', () => {
        const resolution = resolveRunStatus({
          exitCode: 0,
          events: [{ type: 'result', payload: { status: 'success' } }],
        });

        expect(resolution.status).toBe('SUCCESS');
        expect(resolution.parsedResult?.status).toBe('SUCCESS');
      });

      it('parses JSON string payload if stored as serialized string', () => {
        const resolution = resolveRunStatus({
          exitCode: 0,
          events: [
            {
              type: 'result',
              payload: JSON.stringify({ status: 'SUCCESS', summary: 'Parsed from JSON string' }),
            },
          ],
        });

        expect(resolution.status).toBe('SUCCESS');
        expect(resolution.parsedResult?.summary).toBe('Parsed from JSON string');
      });
    });

    // ------------------------------------------------------------------------
    // TRƯỜNG HỢP 2: ERROR
    // exit ≠ 0 hoặc event result báo lỗi
    // ------------------------------------------------------------------------
    describe('Trường hợp 2: ERROR', () => {
      it('resolves to ERROR when exit code is non-zero (without result event)', () => {
        const resolution = resolveRunStatus({
          exitCode: 1,
          events: [
            { type: 'process_start', payload: { pid: 101 } },
            { type: 'stderr', payload: { text: 'Fatal error: command not found' } },
            { type: 'process_exit', payload: { exitCode: 1 } },
          ],
        });

        expect(resolution.status).toBe('ERROR');
        expect(resolution.reason).toContain('non-zero exit code: 1');
      });

      it('resolves to ERROR when exit code is non-zero even if result event reported SUCCESS', () => {
        const resolution = resolveRunStatus({
          exitCode: 137,
          events: [{ type: 'result', payload: { status: 'SUCCESS' } }],
        });

        expect(resolution.status).toBe('ERROR');
        expect(resolution.reason).toContain('non-zero exit code: 137');
      });

      it('resolves to ERROR when exit code is 0 but event result reports status ERROR', () => {
        const resolution = resolveRunStatus({
          exitCode: 0,
          events: [
            {
              type: 'result',
              payload: {
                type: 'result',
                status: 'ERROR',
                message: 'Acceptance test failed on line 42',
              },
            },
          ],
        });

        expect(resolution.status).toBe('ERROR');
        expect(resolution.reason).toContain('Acceptance test failed on line 42');
        expect(resolution.parsedResult?.status).toBe('ERROR');
      });

      it('resolves to ERROR when exit code is 0 but event result reports status FAILED', () => {
        const resolution = resolveRunStatus({
          exitCode: 0,
          events: [
            {
              type: 'result',
              payload: {
                status: 'FAILED',
                summary: 'Unit test suite returned failures',
              },
            },
          ],
        });

        expect(resolution.status).toBe('ERROR');
        expect(resolution.reason).toContain('Unit test suite returned failures');
        expect(resolution.parsedResult?.status).toBe('FAILED');
      });

      it('resolves to ERROR when exit code is 0 but event result reports success: false', () => {
        const resolution = resolveRunStatus({
          exitCode: 0,
          events: [
            {
              type: 'result',
              payload: {
                success: false,
                error: 'Could not connect to external service',
              },
            },
          ],
        });

        expect(resolution.status).toBe('ERROR');
        expect(resolution.reason).toContain('Could not connect to external service');
      });

      it('resolves to ERROR when process is terminated by signal without exit code', () => {
        const resolution = resolveRunStatus({
          exitCode: null,
          signal: 'SIGSEGV',
          events: [],
        });

        expect(resolution.status).toBe('ERROR');
        expect(resolution.reason).toContain('terminated abruptly by signal: SIGSEGV');
      });
    });

    // ------------------------------------------------------------------------
    // TRƯỜNG HỢP 3: INVALID_OUTPUT
    // exit 0 nhưng không có/sai result
    // ------------------------------------------------------------------------
    describe('Trường hợp 3: INVALID_OUTPUT', () => {
      it('resolves to INVALID_OUTPUT when exit code is 0 but no events at all', () => {
        const resolution = resolveRunStatus({
          exitCode: 0,
          events: [],
        });

        expect(resolution.status).toBe('INVALID_OUTPUT');
        expect(resolution.reason).toContain('emitted no result event');
      });

      it('resolves to INVALID_OUTPUT when exit code is 0 with stdout/stderr but no result event', () => {
        const resolution = resolveRunStatus({
          exitCode: 0,
          events: [
            { type: 'process_start', payload: { pid: 200 } },
            { type: 'stdout', payload: { text: 'Everything finished normally' } },
            { type: 'stderr', payload: { text: 'Some warning' } },
            { type: 'process_exit', payload: { exitCode: 0 } },
          ],
        });

        expect(resolution.status).toBe('INVALID_OUTPUT');
        expect(resolution.reason).toContain('emitted no result event');
      });

      it('resolves to INVALID_OUTPUT when result event payload is missing required status or success', () => {
        const resolution = resolveRunStatus({
          exitCode: 0,
          events: [
            {
              type: 'result',
              payload: {
                type: 'result',
                data: { step: 10 },
                // missing status and success
              },
            },
          ],
        });

        expect(resolution.status).toBe('INVALID_OUTPUT');
        expect(resolution.reason).toContain('result event payload was invalid');
      });

      it('resolves to INVALID_OUTPUT when result event has an unknown/invalid status string', () => {
        const resolution = resolveRunStatus({
          exitCode: 0,
          events: [
            {
              type: 'result',
              payload: {
                status: 'RANDOM_GARBAGE_STATUS',
              },
            },
          ],
        });

        expect(resolution.status).toBe('INVALID_OUTPUT');
        expect(resolution.reason).toContain('result event payload was invalid');
      });

      it('resolves to INVALID_OUTPUT when result event payload is not an object', () => {
        const resolution = resolveRunStatus({
          exitCode: 0,
          events: [
            {
              type: 'result',
              payload: 'just a raw string',
            },
          ],
        });

        expect(resolution.status).toBe('INVALID_OUTPUT');
        expect(resolution.reason).toContain('result event payload was invalid');
      });

      it('resolves to INVALID_OUTPUT when result event is null', () => {
        const resolution = resolveRunStatus({
          exitCode: 0,
          events: [
            {
              type: 'result',
              payload: null,
            },
          ],
        });

        expect(resolution.status).toBe('INVALID_OUTPUT');
        expect(resolution.reason).toContain('result event payload was invalid');
      });
    });

    // ------------------------------------------------------------------------
    // Các trạng thái mở rộng: TIMEOUT & CANCELLED
    // ------------------------------------------------------------------------
    describe('Trạng thái mở rộng: TIMEOUT và CANCELLED', () => {
      it('resolves to TIMEOUT when isTimeout flag is true', () => {
        const resolution = resolveRunStatus({
          exitCode: null,
          signal: 'SIGKILL',
          events: [{ type: 'stdout', payload: { text: 'Running slow...' } }],
          isTimeout: true,
        });

        expect(resolution.status).toBe('TIMEOUT');
        expect(resolution.reason).toContain('timed out');
      });

      it('resolves to CANCELLED when isCancelled flag is true', () => {
        const resolution = resolveRunStatus({
          exitCode: null,
          signal: 'SIGTERM',
          events: [{ type: 'stdout', payload: { text: 'Working...' } }],
          isCancelled: true,
        });

        expect(resolution.status).toBe('CANCELLED');
        expect(resolution.reason).toContain('cancelled by user');
      });
    });
  });
});
