import { describe, it, expect, vi } from 'vitest';
import {
  ALLOWED_TASK_TRANSITIONS,
  isValidTaskTransition,
  isTerminalTaskStatus,
  assertValidTaskTransition,
  TaskStateMachine,
  type TaskStatus,
  TASK_STATUSES,
} from '../index.js';

describe('Task State Machine (Shared Domain)', () => {
  describe('ALLOWED_TASK_TRANSITIONS table structure', () => {
    it('defines transition entries for all 9 standard TaskStatus values', () => {
      for (const status of TASK_STATUSES) {
        expect(ALLOWED_TASK_TRANSITIONS).toHaveProperty(status);
        expect(Array.isArray(ALLOWED_TASK_TRANSITIONS[status])).toBe(true);
      }
    });

    it('identifies DONE as a terminal state with no outbound transitions', () => {
      expect(ALLOWED_TASK_TRANSITIONS.DONE).toEqual([]);
      expect(isTerminalTaskStatus('DONE')).toBe(true);
      expect(isTerminalTaskStatus('TODO')).toBe(false);
      expect(isTerminalTaskStatus('RUNNING')).toBe(false);
    });
  });

  describe('Chu trình chuyển đổi chuẩn: TODO → READY → RUNNING → VERIFYING → DONE', () => {
    it('cho phép chu trình hợp lệ từng bước', () => {
      expect(isValidTaskTransition('TODO', 'READY')).toBe(true);
      expect(isValidTaskTransition('READY', 'RUNNING')).toBe(true);
      expect(isValidTaskTransition('RUNNING', 'VERIFYING')).toBe(true);
      expect(isValidTaskTransition('VERIFYING', 'DONE')).toBe(true);
    });

    it('thực hiện tuần tự thành công trên TaskStateMachine', () => {
      const sm = new TaskStateMachine('TODO', { taskId: 'T-CYCLE' });
      expect(sm.status).toBe('TODO');
      expect(sm.taskId).toBe('T-CYCLE');
      expect(sm.isTerminal()).toBe(false);

      expect(sm.transition('READY', { reason: 'Dependencies satisfied' })).toBe('READY');
      expect(sm.status).toBe('READY');

      expect(sm.transition('RUNNING', { reason: 'Scheduler worker assigned' })).toBe('RUNNING');
      expect(sm.status).toBe('RUNNING');

      expect(sm.transition('VERIFYING', { reason: 'Code execution finished, starting tests' })).toBe('VERIFYING');
      expect(sm.status).toBe('VERIFYING');

      expect(sm.transition('DONE', { reason: 'All quality checks and tests passed' })).toBe('DONE');
      expect(sm.status).toBe('DONE');
      expect(sm.isTerminal()).toBe(true);

      expect(sm.history).toHaveLength(4);
      expect(sm.history[0]?.from).toBe('TODO');
      expect(sm.history[0]?.to).toBe('READY');
      expect(sm.history[1]?.from).toBe('READY');
      expect(sm.history[1]?.to).toBe('RUNNING');
      expect(sm.history[2]?.from).toBe('RUNNING');
      expect(sm.history[2]?.to).toBe('VERIFYING');
      expect(sm.history[3]?.from).toBe('VERIFYING');
      expect(sm.history[3]?.to).toBe('DONE');
    });
  });

  describe('Các nhánh phân nhánh / ngoại lệ hợp lệ', () => {
    it('RUNNING → FAILED → READY (Retry cycle)', () => {
      expect(isValidTaskTransition('RUNNING', 'FAILED')).toBe(true);
      expect(isValidTaskTransition('FAILED', 'READY')).toBe(true);

      const sm = new TaskStateMachine('RUNNING');
      sm.transition('FAILED', { reason: 'Process timeout' });
      expect(sm.status).toBe('FAILED');
      sm.transition('READY', { reason: 'Retry attempt 2 scheduled' });
      expect(sm.status).toBe('READY');
    });

    it('VERIFYING → FAILED → READY (Verification test failure & retry)', () => {
      expect(isValidTaskTransition('VERIFYING', 'FAILED')).toBe(true);
      expect(isValidTaskTransition('FAILED', 'READY')).toBe(true);

      const sm = new TaskStateMachine('VERIFYING');
      sm.transition('FAILED', { reason: 'Vitest assertion failed' });
      expect(sm.status).toBe('FAILED');
      sm.transition('READY', { reason: 'Retry' });
      expect(sm.status).toBe('READY');
    });

    it('FAILED → CANCELLED & FAILED → TODO', () => {
      expect(isValidTaskTransition('FAILED', 'CANCELLED')).toBe(true);
      expect(isValidTaskTransition('FAILED', 'TODO')).toBe(true);
    });

    it('Tạm dừng và tiếp tục: PAUSED lifecycle', () => {
      expect(isValidTaskTransition('READY', 'PAUSED')).toBe(true);
      expect(isValidTaskTransition('RUNNING', 'PAUSED')).toBe(true);
      expect(isValidTaskTransition('VERIFYING', 'PAUSED')).toBe(true);

      expect(isValidTaskTransition('PAUSED', 'READY')).toBe(true);
      expect(isValidTaskTransition('PAUSED', 'RUNNING')).toBe(true);
      expect(isValidTaskTransition('PAUSED', 'VERIFYING')).toBe(true);
      expect(isValidTaskTransition('PAUSED', 'CANCELLED')).toBe(true);
    });

    it('Bị chặn và gỡ chặn: BLOCKED lifecycle', () => {
      expect(isValidTaskTransition('TODO', 'BLOCKED')).toBe(true);
      expect(isValidTaskTransition('READY', 'BLOCKED')).toBe(true);
      expect(isValidTaskTransition('RUNNING', 'BLOCKED')).toBe(true);
      expect(isValidTaskTransition('VERIFYING', 'BLOCKED')).toBe(true);

      expect(isValidTaskTransition('BLOCKED', 'READY')).toBe(true);
      expect(isValidTaskTransition('BLOCKED', 'TODO')).toBe(true);
      expect(isValidTaskTransition('BLOCKED', 'FAILED')).toBe(true);
      expect(isValidTaskTransition('BLOCKED', 'CANCELLED')).toBe(true);
    });

    it('Hủy tác vụ: CANCELLED lifecycle', () => {
      expect(isValidTaskTransition('TODO', 'CANCELLED')).toBe(true);
      expect(isValidTaskTransition('READY', 'CANCELLED')).toBe(true);
      expect(isValidTaskTransition('RUNNING', 'CANCELLED')).toBe(true);
      expect(isValidTaskTransition('VERIFYING', 'CANCELLED')).toBe(true);
      expect(isValidTaskTransition('BLOCKED', 'CANCELLED')).toBe(true);
      expect(isValidTaskTransition('FAILED', 'CANCELLED')).toBe(true);
      expect(isValidTaskTransition('PAUSED', 'CANCELLED')).toBe(true);

      // Reopen cancelled task
      expect(isValidTaskTransition('CANCELLED', 'TODO')).toBe(true);
    });
  });

  describe('Nghiệm thu bắt buộc: Chuyển trạng thái trái phép → throw ILLEGAL_STATE_TRANSITION', () => {
    it('Chặn nhảy cóc từ TODO trực tiếp sang RUNNING, VERIFYING, DONE', () => {
      expect(() => assertValidTaskTransition('TODO', 'RUNNING', { taskId: 'T-1' })).toThrowError(
        expect.objectContaining({
          code: 'ILLEGAL_STATE_TRANSITION',
          message: expect.stringContaining("cannot transition from 'TODO' to 'RUNNING'"),
        }),
      );

      expect(() => assertValidTaskTransition('TODO', 'VERIFYING')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );

      expect(() => assertValidTaskTransition('TODO', 'DONE')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );

      expect(() => assertValidTaskTransition('TODO', 'FAILED')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
    });

    it('Chặn nhảy cóc từ READY trực tiếp sang VERIFYING hoặc DONE', () => {
      expect(() => assertValidTaskTransition('READY', 'VERIFYING')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );

      expect(() => assertValidTaskTransition('READY', 'DONE')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
    });

    it('Chặn RUNNING bỏ qua VERIFYING để nhảy thẳng sang DONE', () => {
      expect(() => assertValidTaskTransition('RUNNING', 'DONE', { taskId: 'T-SKIP' })).toThrowError(
        expect.objectContaining({
          code: 'ILLEGAL_STATE_TRANSITION',
          message: expect.stringContaining("cannot transition from 'RUNNING' to 'DONE'"),
        }),
      );
    });

    it('Chặn RUNNING nhảy lùi về TODO hoặc READY', () => {
      expect(() => assertValidTaskTransition('RUNNING', 'TODO')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
      expect(() => assertValidTaskTransition('RUNNING', 'READY')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
    });

    it('Chặn VERIFYING nhảy về TODO, READY, RUNNING', () => {
      expect(() => assertValidTaskTransition('VERIFYING', 'TODO')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
      expect(() => assertValidTaskTransition('VERIFYING', 'READY')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
      expect(() => assertValidTaskTransition('VERIFYING', 'RUNNING')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
    });

    it('Chặn mọi chuyển đổi từ trạng thái kết thúc DONE (terminal state)', () => {
      const targets: TaskStatus[] = [
        'TODO',
        'READY',
        'RUNNING',
        'VERIFYING',
        'DONE',
        'FAILED',
        'BLOCKED',
        'PAUSED',
        'CANCELLED',
      ];

      for (const target of targets) {
        expect(() => assertValidTaskTransition('DONE', target, { taskId: 'T-DONE' })).toThrowError(
          expect.objectContaining({
            code: 'ILLEGAL_STATE_TRANSITION',
            message: expect.stringContaining("cannot transition from 'DONE' to"),
          }),
        );
      }
    });

    it('Chặn FAILED và BLOCKED nhảy thẳng sang RUNNING, VERIFYING, hoặc DONE', () => {
      expect(() => assertValidTaskTransition('FAILED', 'RUNNING')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
      expect(() => assertValidTaskTransition('FAILED', 'VERIFYING')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
      expect(() => assertValidTaskTransition('FAILED', 'DONE')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );

      expect(() => assertValidTaskTransition('BLOCKED', 'RUNNING')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
      expect(() => assertValidTaskTransition('BLOCKED', 'VERIFYING')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
      expect(() => assertValidTaskTransition('BLOCKED', 'DONE')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
    });

    it('Chặn CANCELLED nhảy thẳng sang RUNNING, READY, VERIFYING, DONE', () => {
      expect(() => assertValidTaskTransition('CANCELLED', 'RUNNING')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
      expect(() => assertValidTaskTransition('CANCELLED', 'READY')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
      expect(() => assertValidTaskTransition('CANCELLED', 'VERIFYING')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
      expect(() => assertValidTaskTransition('CANCELLED', 'DONE')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );
    });

    it('Mặc định từ chối chuyển sang cùng trạng thái (same state)', () => {
      expect(isValidTaskTransition('TODO', 'TODO')).toBe(false);
      expect(isValidTaskTransition('RUNNING', 'RUNNING')).toBe(false);
      expect(() => assertValidTaskTransition('RUNNING', 'RUNNING')).toThrowError(
        expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' }),
      );

      // Cho phép khi có tùy chọn allowSameState: true
      expect(isValidTaskTransition('RUNNING', 'RUNNING', { allowSameState: true })).toBe(true);
      expect(() =>
        assertValidTaskTransition('RUNNING', 'RUNNING', { allowSameState: true }),
      ).not.toThrow();
    });

    it('TaskStateMachine.transition() ném lỗi khi chuyển đổi trái phép và không đổi trạng thái', () => {
      const sm = new TaskStateMachine('TODO', { taskId: 'TASK-100' });
      expect(() => sm.transition('DONE')).toThrowError(
        expect.objectContaining({
          code: 'ILLEGAL_STATE_TRANSITION',
          context: expect.objectContaining({
            from: 'TODO',
            to: 'DONE',
            taskId: 'TASK-100',
          }),
        }),
      );
      expect(sm.status).toBe('TODO');
      expect(sm.history).toHaveLength(0);
    });
  });

  describe('TaskStateMachine bổ sung: Callbacks, Force transition, Reset', () => {
    it('kích hoạt onTransition callback khi có chuyển đổi hợp lệ', () => {
      const callback = vi.fn();
      const sm = new TaskStateMachine('TODO', { taskId: 'T-CB' });
      sm.onTransition(callback);

      sm.transition('READY', { reason: 'Ready now', meta: { user: 'admin' } });

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        'TODO',
        'READY',
        expect.objectContaining({
          from: 'TODO',
          to: 'READY',
          reason: 'Ready now',
          meta: { user: 'admin' },
        }),
      );
    });

    it('cho phép force transition khi được cấu hình rõ ràng', () => {
      const sm = new TaskStateMachine('TODO');
      expect(() => sm.transition('DONE', { force: true, reason: 'Admin bypass' })).not.toThrow();
      expect(sm.status).toBe('DONE');
      expect(sm.history[0]?.reason).toBe('Admin bypass');
    });

    it('reset khôi phục trạng thái và làm trống lịch sử', () => {
      const sm = new TaskStateMachine('TODO');
      sm.transition('READY');
      sm.transition('RUNNING');
      expect(sm.history).toHaveLength(2);

      sm.reset('TODO');
      expect(sm.status).toBe('TODO');
      expect(sm.history).toHaveLength(0);
    });

    it('getAllowedTransitions trả về đúng danh sách', () => {
      const sm = new TaskStateMachine('TODO');
      expect(sm.getAllowedTransitions()).toEqual(['READY', 'BLOCKED', 'CANCELLED']);
      sm.transition('READY');
      expect(sm.getAllowedTransitions()).toEqual(['RUNNING', 'PAUSED', 'BLOCKED', 'CANCELLED', 'TODO']);
    });
  });
});
