import { AppError } from '../errors.js';
import { type TaskStatus } from '../models/task.js';

/**
 * Bảng ánh xạ các trạng thái chuyển đổi hợp lệ cho từng TaskStatus.
 *
 * Chu trình chuẩn:
 *   TODO → READY → RUNNING → VERIFYING → DONE
 *
 * Các trạng thái phân nhánh / ngoại lệ:
 *   - FAILED: từ RUNNING hoặc VERIFYING; có thể retry sang READY hoặc reset sang TODO
 *   - BLOCKED: từ TODO, READY, RUNNING, VERIFYING; khi gỡ chặn sang READY hoặc TODO
 *   - PAUSED: tạm dừng từ READY, RUNNING, VERIFYING; khi tiếp tục chuyển sang READY, RUNNING, VERIFYING
 *   - CANCELLED: hủy tác vụ từ TODO, READY, RUNNING, VERIFYING, FAILED, BLOCKED, PAUSED; có thể mở lại sang TODO
 *   - DONE: trạng thái hoàn tất cuối cùng (terminal), không được phép chuyển sang bất kỳ trạng thái nào khác.
 */
export const ALLOWED_TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  TODO: ['READY', 'BLOCKED', 'CANCELLED'],
  READY: ['RUNNING', 'PAUSED', 'BLOCKED', 'CANCELLED', 'TODO'],
  RUNNING: ['VERIFYING', 'FAILED', 'PAUSED', 'BLOCKED', 'CANCELLED'],
  VERIFYING: ['DONE', 'FAILED', 'PAUSED', 'BLOCKED', 'CANCELLED'],
  DONE: [],
  FAILED: ['READY', 'TODO', 'CANCELLED'],
  BLOCKED: ['READY', 'TODO', 'FAILED', 'CANCELLED'],
  PAUSED: ['READY', 'RUNNING', 'VERIFYING', 'TODO', 'FAILED', 'CANCELLED'],
  CANCELLED: ['TODO'],
} as const;

export interface TaskTransitionOptions {
  taskId?: string;
  reason?: string;
  allowSameState?: boolean;
}

/**
 * Kiểm tra xem chuyển đổi từ `from` sang `to` có hợp lệ theo state machine hay không.
 */
export function isValidTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
  options?: { allowSameState?: boolean },
): boolean {
  if (from === to) {
    return options?.allowSameState === true;
  }
  const allowed = ALLOWED_TASK_TRANSITIONS[from];
  if (!allowed) {
    return false;
  }
  return allowed.includes(to);
}

/**
 * Lấy danh sách các trạng thái kế tiếp được phép chuyển đến từ trạng thái hiện tại.
 */
export function getAllowedTaskTransitions(from: TaskStatus): readonly TaskStatus[] {
  return ALLOWED_TASK_TRANSITIONS[from] ?? [];
}

/**
 * Kiểm tra trạng thái có phải là trạng thái kết thúc (terminal) hay không.
 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'DONE';
}

/**
 * Xác thực chuyển đổi trạng thái. Nếu không hợp lệ, ném AppError với mã ILLEGAL_STATE_TRANSITION.
 */
export function assertValidTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
  options?: TaskTransitionOptions,
): void {
  if (!isValidTaskTransition(from, to, options)) {
    const allowed = getAllowedTaskTransitions(from);
    const taskSuffix = options?.taskId ? ` for task '${options.taskId}'` : '';
    const reasonSuffix = options?.reason ? ` (Reason: ${options.reason})` : '';
    const allowedStr = allowed.length > 0 ? `[${allowed.join(', ')}]` : '[none - terminal state]';

    throw new AppError(
      'ILLEGAL_STATE_TRANSITION',
      `Illegal task state transition${taskSuffix}: cannot transition from '${from}' to '${to}'. Allowed next states from '${from}': ${allowedStr}.${reasonSuffix}`,
      {
        from,
        to,
        taskId: options?.taskId,
        reason: options?.reason,
        allowedTransitions: allowed,
      },
    );
  }
}

export interface TaskTransitionRecord {
  from: TaskStatus;
  to: TaskStatus;
  timestamp: string;
  reason?: string;
  meta?: Record<string, unknown>;
}

export type TaskTransitionListener = (
  from: TaskStatus,
  to: TaskStatus,
  record: TaskTransitionRecord,
) => void;

export interface TaskStateMachineOptions {
  taskId?: string;
  onTransition?: TaskTransitionListener;
}

/**
 * Lớp điều khiển State Machine cho Task, theo dõi trạng thái hiện tại và lịch sử chuyển đổi.
 */
export class TaskStateMachine {
  private _status: TaskStatus;
  private readonly _taskId?: string;
  private readonly _history: TaskTransitionRecord[] = [];
  private readonly _listeners: TaskTransitionListener[] = [];

  constructor(initialStatus: TaskStatus = 'TODO', options?: TaskStateMachineOptions) {
    this._status = initialStatus;
    this._taskId = options?.taskId;
    if (options?.onTransition) {
      this._listeners.push(options.onTransition);
    }
  }

  get status(): TaskStatus {
    return this._status;
  }

  get taskId(): string | undefined {
    return this._taskId;
  }

  get history(): readonly TaskTransitionRecord[] {
    return [...this._history];
  }

  canTransitionTo(target: TaskStatus, options?: { allowSameState?: boolean }): boolean {
    return isValidTaskTransition(this._status, target, options);
  }

  getAllowedTransitions(): readonly TaskStatus[] {
    return getAllowedTaskTransitions(this._status);
  }

  isTerminal(): boolean {
    return isTerminalTaskStatus(this._status);
  }

  onTransition(listener: TaskTransitionListener): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx !== -1) {
        this._listeners.splice(idx, 1);
      }
    };
  }

  transition(
    target: TaskStatus,
    options?: {
      reason?: string;
      meta?: Record<string, unknown>;
      force?: boolean;
      timestamp?: string;
    },
  ): TaskStatus {
    const from = this._status;

    if (!options?.force) {
      assertValidTaskTransition(from, target, {
        taskId: this._taskId,
        reason: options?.reason,
      });
    }

    const timestamp = options?.timestamp ?? new Date().toISOString();
    const record: TaskTransitionRecord = {
      from,
      to: target,
      timestamp,
      reason: options?.reason,
      meta: options?.meta,
    };

    this._status = target;
    this._history.push(record);

    for (const listener of this._listeners) {
      try {
        listener(from, target, record);
      } catch {
        // Tránh listener làm gián đoạn transition
      }
    }

    return target;
  }

  reset(newStatus: TaskStatus = 'TODO'): void {
    this._status = newStatus;
    this._history.length = 0;
  }
}
