import type Database from 'better-sqlite3';
import { TaskRepository, EventRepository } from '@ai-orchestrator/db';
import {
  type TaskWithDependencies,
  type TaskFilter,
  type TaskDependencyStatus,
  type TaskStatus,
  type ResolveReadyOptions,
  logger as defaultLogger,
  type Logger,
} from '@ai-orchestrator/shared';

export interface ResolveServiceOptions {
  autoTransition?: boolean;
  candidateStatuses?: TaskStatus[];
  limit?: number;
}

export class DependencyResolverService {
  private readonly taskRepo: TaskRepository;
  private readonly eventRepo: EventRepository;
  private readonly logger: Logger;

  constructor(
    private readonly db: Database.Database,
    options?: { logger?: Logger },
  ) {
    this.taskRepo = new TaskRepository(db);
    this.eventRepo = new EventRepository(db);
    this.logger = options?.logger ?? defaultLogger;
  }

  /**
   * Lấy danh sách task READY sẵn sàng thực thi.
   * Đảm bảo tiêu chuẩn: "Chỉ trả task đủ dependency" (mọi dependency đều đã DONE).
   * Nếu autoTransition = true, tự động chuyển các task TODO thỏa mãn dependencies sang READY.
   */
  getReadyTasks(
    filter?: TaskFilter,
    options?: ResolveServiceOptions,
  ): TaskWithDependencies[] {
    if (options?.autoTransition) {
      const transitioned = this.resolveAndTransitionReady(filter);
      if (options.limit && options.limit > 0) {
        return transitioned.slice(0, options.limit);
      }
      return transitioned;
    }

    const resolveOpts: ResolveReadyOptions = {
      featureId: filter?.feature_id,
      phase: filter?.phase,
      candidateStatuses: options?.candidateStatuses,
      limit: options?.limit,
    };

    return this.taskRepo.findReadyTasks(filter, resolveOpts);
  }

  /**
   * Lấy task tiếp theo có độ ưu tiên cao nhất sẵn sàng thực thi.
   */
  getNextReadyTask(
    filter?: TaskFilter,
    options?: { autoTransition?: boolean },
  ): TaskWithDependencies | null {
    const list = this.getReadyTasks(filter, {
      ...options,
      limit: 1,
    });
    return list.length > 0 && list[0] !== undefined ? list[0] : null;
  }

  /**
   * Truy vấn chi tiết tình trạng dependencies của 1 task.
   */
  getDependencyStatus(taskId: string): TaskDependencyStatus {
    return this.taskRepo.getDependencyStatus(taskId);
  }

  /**
   * Tự động giải quyết và chuyển trạng thái các task TODO đã đủ dependencies sang READY.
   * Thực hiện trong SQLite transaction an toàn.
   */
  resolveAndTransitionReady(filter?: TaskFilter): TaskWithDependencies[] {
    const readyTasks = this.taskRepo.resolveAndMarkReady(filter);

    this.logger.info(
      `[DependencyResolverService] Resolved ready tasks: ${readyTasks.length} task(s) ready`,
      {
        count: readyTasks.length,
        taskIds: readyTasks.map((t) => t.id),
      },
    );

    return readyTasks;
  }
}
