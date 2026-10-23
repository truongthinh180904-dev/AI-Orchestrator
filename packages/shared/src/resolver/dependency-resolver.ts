import { AppError } from '../errors.js';
import type { TaskStatus, TaskWithDependencies } from '../models/task.js';
import type {
  DependencyResolutionSummary,
  ResolveReadyOptions,
  TaskDependencyItem,
  TaskDependencyStatus,
} from './types.js';

/**
 * Kiểm tra xem trạng thái của một dependency có được coi là hoàn tất (thỏa mãn) hay không.
 * Theo tiêu chuẩn hệ thống, một dependency CHỈ được coi là hoàn tất khi trạng thái là 'DONE'.
 */
export function isDependencySatisfied(status: TaskStatus | undefined | null): boolean {
  return status === 'DONE';
}

/**
 * Đánh giá chi tiết tình trạng phụ thuộc của một task đối với tập hợp các task đã biết.
 */
export function checkTaskDependencies(
  task: TaskWithDependencies,
  taskLookup: Map<string, TaskWithDependencies> | ((id: string) => TaskWithDependencies | null | undefined),
): TaskDependencyStatus {
  const getTask = typeof taskLookup === 'function' ? taskLookup : (id: string) => taskLookup.get(id);

  const deps = task.dependencies ?? [];
  const satisfiedDependencies: string[] = [];
  const unsatisfiedDependencies: TaskDependencyItem[] = [];
  const missingDependencies: string[] = [];

  for (const depId of deps) {
    const depTask = getTask(depId);
    if (!depTask) {
      missingDependencies.push(depId);
      unsatisfiedDependencies.push({ id: depId, status: 'MISSING' });
    } else if (depTask.status === 'DONE') {
      satisfiedDependencies.push(depId);
    } else {
      unsatisfiedDependencies.push({ id: depId, status: depTask.status });
    }
  }

  const allDependenciesDone =
    deps.length === 0 || (unsatisfiedDependencies.length === 0 && missingDependencies.length === 0);

  let isReady: boolean;
  let reason: string | undefined;

  if (!allDependenciesDone) {
    isReady = false;
    const pendingNames = unsatisfiedDependencies
      .map((d) => (d.status === 'MISSING' ? `${d.id} (MISSING)` : `${d.id} (${d.status})`))
      .join(', ');
    reason = `Chưa đủ dependencies: ${pendingNames}`;
  } else if (task.status !== 'TODO' && task.status !== 'READY') {
    isReady = false;
    reason = `Trạng thái task hiện tại (${task.status}) không thể nhận để thực thi`;
  } else {
    isReady = true;
    reason = 'Tất cả dependencies đã hoàn tất (DONE)';
  }

  return {
    taskId: task.id,
    isReady,
    currentStatus: task.status,
    totalDependencies: deps.length,
    satisfiedDependencies,
    unsatisfiedDependencies,
    missingDependencies,
    reason,
  };
}

/**
 * DependencyResolver: Bộ giải quyết phụ thuộc task.
 * Nhiệm vụ chính: Xác định danh sách các task READY để đưa vào hàng đợi thực thi.
 * Đảm bảo nghiệm thu nghiêm ngặt: "Chỉ trả task đủ dependency" (mọi dependency đều đã DONE).
 */
export class DependencyResolver {
  private readonly tasks = new Map<string, TaskWithDependencies>();

  constructor(tasks?: Iterable<TaskWithDependencies>) {
    if (tasks) {
      this.addTasks(tasks);
    }
  }

  public addTask(task: TaskWithDependencies): void {
    this.tasks.set(task.id, task);
  }

  public addTasks(tasks: Iterable<TaskWithDependencies>): void {
    for (const task of tasks) {
      this.addTask(task);
    }
  }

  public getTask(id: string): TaskWithDependencies | undefined {
    return this.tasks.get(id);
  }

  public hasTask(id: string): boolean {
    return this.tasks.has(id);
  }

  public getAllTasks(): TaskWithDependencies[] {
    return Array.from(this.tasks.values());
  }

  public size(): number {
    return this.tasks.size;
  }

  /**
   * Kiểm tra chi tiết tình trạng dependencies của 1 task.
   */
  public checkTask(taskId: string): TaskDependencyStatus {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${taskId}' not found in resolver`, { taskId });
    }
    return checkTaskDependencies(task, this.tasks);
  }

  /**
   * Kiểm tra xem toàn bộ dependencies của task có thỏa mãn (đều là DONE) hay không.
   */
  public areDependenciesSatisfied(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }
    const deps = task.dependencies ?? [];
    if (deps.length === 0) {
      return true;
    }
    for (const depId of deps) {
      const depTask = this.tasks.get(depId);
      if (!depTask || depTask.status !== 'DONE') {
        return false;
      }
    }
    return true;
  }

  /**
   * Kiểm tra một task cụ thể có sẵn sàng thực thi (READY) hay không.
   * Task chỉ sẵn sàng khi:
   * 1. Trạng thái hiện tại thuộc candidateStatuses (mặc định: ['TODO', 'READY'])
   * 2. TẤT CẢ các dependencies của task đều có trạng thái 'DONE'.
   */
  public isTaskReady(
    taskId: string,
    candidateStatuses: TaskStatus[] = ['TODO', 'READY'],
  ): boolean {
    const task = this.tasks.get(taskId);
    if (!task) {
      return false;
    }
    if (!candidateStatuses.includes(task.status)) {
      return false;
    }
    return this.areDependenciesSatisfied(taskId);
  }

  /**
   * Trả về danh sách các task READY đủ điều kiện thực thi.
   * Tiêu chí nghiệm thu cốt lõi: "Chỉ trả task đủ dependency".
   *
   * Quy tắc chọn:
   * 1. Task thuộc bộ lọc (featureId, phase, repository) nếu có.
   * 2. Trạng thái hiện tại nằm trong candidateStatuses (mặc định ['TODO', 'READY']).
   * 3. TẤT CẢ dependencies của task phải có trạng thái 'DONE' và tồn tại trong hệ thống.
   *
   * Thứ tự sắp xếp trả về (deterministic):
   * 1. Priority giảm dần (độ ưu tiên cao xếp trước).
   * 2. CreatedAt tăng dần (task tạo trước xếp trước).
   * 3. ID tăng dần (theo bảng chữ cái).
   */
  public getReadyTasks(options?: ResolveReadyOptions): TaskWithDependencies[] {
    const candidateStatuses = options?.candidateStatuses ?? ['TODO', 'READY'];
    const readyList: TaskWithDependencies[] = [];

    for (const task of this.tasks.values()) {
      // Áp dụng bộ lọc
      if (options?.featureId && task.feature_id !== options.featureId) {
        continue;
      }
      if (options?.planId && task.plan_id !== options.planId) {
        continue;
      }
      if (options?.phase && task.phase !== options.phase) {
        continue;
      }
      if (options?.repository && task.repository !== options.repository) {
        continue;
      }

      // Kiểm tra trạng thái ứng viên
      if (!candidateStatuses.includes(task.status)) {
        continue;
      }

      // TIÊU CHÍ BẮT BUỘC: Kiểm tra TẤT CẢ dependencies phải là 'DONE'
      if (this.areDependenciesSatisfied(task.id)) {
        readyList.push(task);
      }
    }

    // Sắp xếp thứ tự ưu tiên
    readyList.sort((a, b) => {
      // 1. Priority DESC
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      // 2. CreatedAt ASC
      const timeA = new Date(a.created_at).getTime();
      const timeB = new Date(b.created_at).getTime();
      if (!isNaN(timeA) && !isNaN(timeB) && timeA !== timeB) {
        return timeA - timeB;
      }
      // 3. ID ASC (lexicographical)
      return a.id.localeCompare(b.id);
    });

    if (options?.limit && options.limit > 0) {
      return readyList.slice(0, options.limit);
    }

    return readyList;
  }

  /**
   * Lấy task tiếp theo có độ ưu tiên cao nhất sẵn sàng thực thi.
   * Dùng cho Scheduler tuần tự (ORC-003).
   */
  public getNextReadyTask(options?: ResolveReadyOptions): TaskWithDependencies | null {
    const ready = this.getReadyTasks({ ...options, limit: 1 });
    return ready.length > 0 && ready[0] !== undefined ? ready[0] : null;
  }

  /**
   * Tổng hợp tình trạng của toàn bộ task trong resolver.
   */
  public getResolutionSummary(options?: ResolveReadyOptions): DependencyResolutionSummary {
    const readyTasks = this.getReadyTasks(options);
    const blockedTasks: Array<{ task: TaskWithDependencies; blockedBy: string[] }> = [];
    const pendingTasks: Array<{ task: TaskWithDependencies; waitingFor: string[] }> = [];
    const completedTasks: TaskWithDependencies[] = [];

    for (const task of this.tasks.values()) {
      if (options?.featureId && task.feature_id !== options.featureId) continue;
      if (options?.planId && task.plan_id !== options.planId) continue;
      if (options?.phase && task.phase !== options.phase) continue;
      if (options?.repository && task.repository !== options.repository) continue;

      if (task.status === 'DONE') {
        completedTasks.push(task);
        continue;
      }

      // Kiểm tra xem có bị block bởi failure không
      const failedDeps: string[] = [];
      const waitingDeps: string[] = [];

      for (const depId of task.dependencies) {
        const dep = this.tasks.get(depId);
        if (!dep || dep.status === 'FAILED' || dep.status === 'CANCELLED' || dep.status === 'BLOCKED') {
          failedDeps.push(depId);
        } else if (dep.status !== 'DONE') {
          waitingDeps.push(depId);
        }
      }

      if (failedDeps.length > 0) {
        blockedTasks.push({ task, blockedBy: failedDeps });
      } else if (waitingDeps.length > 0) {
        pendingTasks.push({ task, waitingFor: waitingDeps });
      }
    }

    return {
      totalTasks: this.tasks.size,
      readyTasks,
      blockedTasks,
      pendingTasks,
      completedTasks,
    };
  }

  /**
   * Tìm các task bị chặn do có dependency bị FAILED, CANCELLED hoặc BLOCKED.
   */
  public findBlockedByFailedTasks(): Array<{
    task: TaskWithDependencies;
    failedDependencies: string[];
  }> {
    const blocked: Array<{ task: TaskWithDependencies; failedDependencies: string[] }> = [];

    for (const task of this.tasks.values()) {
      if (task.status === 'DONE') continue;

      const failedDeps: string[] = [];
      for (const depId of task.dependencies) {
        const dep = this.tasks.get(depId);
        if (!dep || dep.status === 'FAILED' || dep.status === 'CANCELLED' || dep.status === 'BLOCKED') {
          failedDeps.push(depId);
        }
      }

      if (failedDeps.length > 0) {
        blocked.push({ task, failedDependencies: failedDeps });
      }
    }

    return blocked;
  }
}

/**
 * Hàm trợ giúp nhanh: Giải quyết và trả về danh sách task READY từ một danh sách tasks đầu vào.
 */
export function resolveReadyTasks(
  tasks: Iterable<TaskWithDependencies>,
  options?: ResolveReadyOptions,
): TaskWithDependencies[] {
  const resolver = new DependencyResolver(tasks);
  return resolver.getReadyTasks(options);
}
