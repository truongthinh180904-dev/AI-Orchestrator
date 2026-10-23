import type Database from 'better-sqlite3';
import { FeatureRepository, TaskRepository } from '@ai-orchestrator/db';
import {
  type FeatureComponentTasksResult,
  type FeatureComponentTask,
  type FeatureTaskSummary,
  type DefineFeatureTasksInput,
  FeatureComponentTasksResultSchema,
  DefineFeatureTasksInputSchema,
  AppError,
  logger as defaultLogger,
  type Logger,
} from '@ai-orchestrator/shared';

export interface FeatureReleaseServiceOptions {
  logger?: Logger;
}

/**
 * Service quản lý vòng đời phát hành tính năng (Feature Release - REL-*).
 * Chịu trách nhiệm xác định feature, tập task bắt buộc, điều kiện nghiệm thu và điều phối bàn giao.
 */
export class FeatureReleaseService {
  private readonly featureRepo: FeatureRepository;
  private readonly taskRepo: TaskRepository;
  private readonly logger: Logger;

  constructor(
    private readonly db: Database.Database,
    options?: FeatureReleaseServiceOptions,
  ) {
    this.featureRepo = new FeatureRepository(db);
    this.taskRepo = new TaskRepository(db);
    this.logger = options?.logger ?? defaultLogger;
  }

  /**
   * Xác định feature và tập task bắt buộc (Danh sách task thành phần).
   * Nghiệm thu REL-001: Trả về danh sách task thành phần có cấu trúc,
   * phân định rõ task bắt buộc, phát hiện task thiếu, và tính toán thứ tự thực thi topo.
   */
  getComponentTasks(featureId: string): FeatureComponentTasksResult {
    const { feature, tasks } = this.featureRepo.getComponentTasks(featureId);

    // 1. Phát hiện các task bắt buộc được khai báo nhưng chưa tồn tại trong DB
    const foundTaskIds = new Set(tasks.map((t) => t.id));
    const missingTaskIds = feature.required_tasks.filter((reqId) => !foundTaskIds.has(reqId));

    // 2. Tính toán thứ tự thực thi topo theo đồ thị phụ thuộc
    const allTaskIds = tasks.map((t) => t.id);
    let executionOrderIds: string[];
    try {
      executionOrderIds = this.taskRepo.getExecutionOrder(allTaskIds);
    } catch {
      // Fallback nếu có cycle hoặc lỗi topo
      executionOrderIds = allTaskIds;
    }

    const orderMap = new Map<string, number>();
    executionOrderIds.forEach((id, idx) => {
      orderMap.set(id, idx + 1);
    });

    // 3. Phân định từng task thành phần
    const hasExplicitRequiredList = feature.required_tasks.length > 0;
    const componentTasks: FeatureComponentTask[] = tasks.map((t) => {
      // Nếu feature có danh sách required_tasks rõ ràng: chỉ các task trong danh sách mới là bắt buộc.
      // Nếu feature không có required_tasks: mặc định tất cả task gán cho feature đều là bắt buộc.
      const isRequired = hasExplicitRequiredList
        ? feature.required_tasks.includes(t.id)
        : true;

      const order = orderMap.get(t.id) ?? 0;

      return {
        id: t.id,
        feature_id: t.feature_id,
        title: t.title,
        description: t.description ?? null,
        phase: t.phase ?? null,
        priority: t.priority ?? 0,
        status: t.status,
        worker_type: t.worker_type ?? 'agy',
        repository: t.repository ?? '.',
        acceptance_criteria: t.acceptance_criteria ?? [],
        test_commands: t.test_commands ?? [],
        scope_files: t.scope_files ?? null,
        dependencies: t.dependencies ?? [],
        is_required: isRequired,
        execution_order: order,
      };
    });

    // 4. Sắp xếp danh sách task thành phần: thứ tự topo ASC -> priority DESC -> id ASC
    componentTasks.sort((a, b) => {
      if (a.execution_order !== b.execution_order) {
        return a.execution_order - b.execution_order;
      }
      if (a.priority !== b.priority) {
        return b.priority - a.priority;
      }
      return a.id.localeCompare(b.id);
    });

    // 5. Thống kê tổng quan
    const requiredTasks = componentTasks.filter((t) => t.is_required);
    const completedTasks = componentTasks.filter((t) => t.status === 'DONE');
    const pendingTasks = componentTasks.filter((t) =>
      ['TODO', 'READY', 'RUNNING', 'VERIFYING'].includes(t.status),
    );
    const failedTasks = componentTasks.filter((t) =>
      ['FAILED', 'BLOCKED', 'CANCELLED'].includes(t.status),
    );

    const requiredCount = requiredTasks.length + missingTaskIds.length;
    const isAllRequiredDone =
      missingTaskIds.length === 0 &&
      requiredCount > 0 &&
      requiredTasks.every((t) => t.status === 'DONE');
    const readyForRelease = isAllRequiredDone;

    const summary: FeatureTaskSummary = {
      total_tasks: componentTasks.length,
      required_count: requiredCount,
      completed_count: completedTasks.length,
      pending_count: pendingTasks.length,
      failed_count: failedTasks.length,
      missing_count: missingTaskIds.length,
      is_all_required_done: isAllRequiredDone,
      ready_for_release: readyForRelease,
    };

    const result: FeatureComponentTasksResult = {
      feature_id: feature.id,
      feature_name: feature.name,
      description: feature.description ?? null,
      status: feature.status,
      release_policy: feature.release_policy ?? null,
      integration_tests: feature.integration_tests ?? [],
      required_task_ids: feature.required_tasks ?? [],
      all_task_ids: componentTasks.map((t) => t.id),
      tasks: componentTasks,
      missing_task_ids: missingTaskIds,
      summary,
    };

    this.logger.info(`Resolved component tasks for feature '${featureId}'`, {
      featureId,
      totalTasks: summary.total_tasks,
      requiredCount: summary.required_count,
      completedCount: summary.completed_count,
      missingCount: summary.missing_count,
      readyForRelease: summary.ready_for_release,
    });

    return FeatureComponentTasksResultSchema.parse(result);
  }

  /**
   * Định nghĩa hoặc cập nhật tập task bắt buộc và các task thành phần của feature.
   */
  defineFeatureTasks(
    featureId: string,
    input: DefineFeatureTasksInput,
  ): FeatureComponentTasksResult {
    const validated = DefineFeatureTasksInputSchema.parse(input);

    const feature = this.featureRepo.findById(featureId);
    if (!feature) {
      throw new AppError('FEATURE_NOT_FOUND', `Feature with id '${featureId}' not found`, {
        featureId,
      });
    }

    const tx = this.db.transaction(() => {
      if (validated.required_tasks !== undefined) {
        this.featureRepo.setRequiredTasks(featureId, validated.required_tasks);
      }

      if (validated.assign_task_ids && validated.assign_task_ids.length > 0) {
        this.featureRepo.assignTasks(featureId, validated.assign_task_ids);
      }

      if (validated.unassign_task_ids && validated.unassign_task_ids.length > 0) {
        this.featureRepo.unassignTasks(featureId, validated.unassign_task_ids);
      }
    });

    tx();

    return this.getComponentTasks(featureId);
  }
}
