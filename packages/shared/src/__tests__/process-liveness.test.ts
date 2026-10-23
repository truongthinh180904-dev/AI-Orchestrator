import { describe, expect, it } from 'vitest';
import {
  isProcessAlive,
  evaluateProcessLiveness,
  ProcessStateInspectionSchema,
} from '../process/liveness.js';

describe('Process Liveness & State Evaluation', () => {
  describe('isProcessAlive()', () => {
    it('returns true for the current running process PID', () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it('returns false for non-existent or invalid PID', () => {
      expect(isProcessAlive(null)).toBe(false);
      expect(isProcessAlive(undefined)).toBe(false);
      expect(isProcessAlive(0)).toBe(false);
      expect(isProcessAlive(-10)).toBe(false);
      expect(isProcessAlive(NaN)).toBe(false);
      // Extremely high PID unlikely to exist in OS
      expect(isProcessAlive(99999999)).toBe(false);
    });
  });

  describe('evaluateProcessLiveness() — Distinguishing Dead vs Finished vs Alive', () => {
    const baseRun = {
      id: 'run-123',
      task_id: 'task-abc',
      status: 'RUNNING' as const,
      pid: 12345,
      started_at: '2026-10-23T12:00:00.000Z',
      finished_at: null,
      exit_code: null,
      last_heartbeat_at: '2026-10-23T12:00:10.000Z',
    };

    it('Phân biệt XONG (FINISHED): Process hoàn thành có finished_at và status SUCCESS', () => {
      const inspection = evaluateProcessLiveness({
        run: {
          ...baseRun,
          status: 'SUCCESS',
          finished_at: '2026-10-23T12:05:00.000Z',
          exit_code: 0,
        },
        osProcessAliveChecker: () => false, // PID no longer alive in OS
      });

      expect(inspection.state).toBe('FINISHED');
      expect(inspection.isFinished).toBe(true);
      expect(inspection.isAlive).toBe(false);
      expect(inspection.isCrashed).toBe(false);
      expect(inspection.isUnresponsive).toBe(false);
      expect(inspection.diagnosis).toContain('finished execution');

      // Validates schema
      expect(ProcessStateInspectionSchema.parse(inspection)).toBeDefined();
    });

    it('Phân biệt CHẾT (DEAD): Run status RUNNING nhưng PID đã biến mất khỏi OS', () => {
      const inspection = evaluateProcessLiveness({
        run: {
          ...baseRun,
          status: 'RUNNING',
          finished_at: null,
          exit_code: null,
        },
        osProcessAliveChecker: () => false, // PID does not exist!
      });

      expect(inspection.state).toBe('DEAD');
      expect(inspection.isFinished).toBe(false);
      expect(inspection.isAlive).toBe(false);
      expect(inspection.isCrashed).toBe(true);
      expect(inspection.isUnresponsive).toBe(false);
      expect(inspection.diagnosis).toContain('dead/crashed unexpectedly');
      expect(inspection.diagnosis).toContain('PID disappeared from OS');

      expect(ProcessStateInspectionSchema.parse(inspection)).toBeDefined();
    });

    it('CÒN SỐNG & ĐANG CHẠY (ALIVE): PID còn sống và heartbeat mới', () => {
      const now = new Date('2026-10-23T12:00:20.000Z').getTime();
      const inspection = evaluateProcessLiveness({
        run: {
          ...baseRun,
          last_heartbeat_at: '2026-10-23T12:00:15.000Z', // 5 seconds ago
        },
        heartbeatTimeoutMs: 15_000,
        now,
        osProcessAliveChecker: () => true, // PID is alive
      });

      expect(inspection.state).toBe('ALIVE');
      expect(inspection.isAlive).toBe(true);
      expect(inspection.isHeartbeatFresh).toBe(true);
      expect(inspection.isFinished).toBe(false);
      expect(inspection.isCrashed).toBe(false);
      expect(inspection.isUnresponsive).toBe(false);
      expect(inspection.heartbeatAgeMs).toBe(5_000);
      expect(inspection.diagnosis).toContain('alive and actively running');

      expect(ProcessStateInspectionSchema.parse(inspection)).toBeDefined();
    });

    it('TREO / MẤT HEARTBEAT (UNRESPONSIVE): PID còn sống nhưng heartbeat vượt ngưỡng timeout', () => {
      const now = new Date('2026-10-23T12:01:00.000Z').getTime(); // 50 seconds after last heartbeat
      const inspection = evaluateProcessLiveness({
        run: {
          ...baseRun,
          last_heartbeat_at: '2026-10-23T12:00:10.000Z',
        },
        heartbeatTimeoutMs: 30_000,
        now,
        osProcessAliveChecker: () => true, // PID still alive in OS!
      });

      expect(inspection.state).toBe('UNRESPONSIVE');
      expect(inspection.isAlive).toBe(true);
      expect(inspection.isHeartbeatFresh).toBe(false);
      expect(inspection.isUnresponsive).toBe(true);
      expect(inspection.isFinished).toBe(false);
      expect(inspection.isCrashed).toBe(false);
      expect(inspection.heartbeatAgeMs).toBe(50_000);
      expect(inspection.diagnosis).toContain('alive in OS but unresponsive');

      expect(ProcessStateInspectionSchema.parse(inspection)).toBeDefined();
    });

    it('Trường hợp RUNNING nhưng không có PID: Trả về UNKNOWN', () => {
      const inspection = evaluateProcessLiveness({
        run: {
          ...baseRun,
          pid: null,
        },
      });

      expect(inspection.state).toBe('UNKNOWN');
      expect(inspection.isAlive).toBe(false);
      expect(inspection.isFinished).toBe(false);
    });
  });
});
