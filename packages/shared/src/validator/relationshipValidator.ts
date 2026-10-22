import {
  VALIDATION_ERROR_CODES,
  type ValidationErrorItem,
  type ValidationOptions,
} from './types.js';
import {
  DependencyGraph,
  canonicalizeCycle,
  formatCyclePath,
} from '../graph/index.js';

export const FOUNDATION_TASK_IDS = [
  'FND-001',
  'FND-002',
  'FND-003',
  'FND-004',
  'FND-005',
  'FND-006',
] as const;

export interface TaskRelationshipCandidate {
  id: string;
  dependencies?: string[];
  feature_id?: string | null;
  rowNumber?: number;
}

export interface FeatureRelationshipCandidate {
  id: string;
  required_tasks?: string[];
  rowNumber?: number;
}

/**
 * Kiểm tra trùng lặp mã task_id trong tập task đầu vào và với cơ sở dữ liệu hiện có.
 */
export function validateTaskIdsUniqueness(
  tasks: TaskRelationshipCandidate[],
  options: ValidationOptions = {},
): ValidationErrorItem[] {
  const issues: ValidationErrorItem[] = [];
  const sheet = 'Tasks';
  const seenInBatch = new Map<string, number>();

  const existingSet = options.existingTaskIds
    ? new Set(Array.from(options.existingTaskIds))
    : null;
  const checkExisting = options.checkExistingDuplicates !== false;

  for (let idx = 0; idx < tasks.length; idx++) {
    const task = tasks[idx];
    if (!task) continue;

    const rowNumber = task.rowNumber ?? idx + 2;
    const id = task.id ? task.id.trim() : '';

    if (!id) {
      continue;
    }

    if (seenInBatch.has(id)) {
      const firstSeenRow = seenInBatch.get(id);
      issues.push({
        sheet,
        row: rowNumber,
        column: 'id',
        code: VALIDATION_ERROR_CODES.DUPLICATE_TASK_ID,
        message: `Trùng mã task '${id}' (đã xuất hiện ở dòng ${firstSeenRow}).`,
        value: id,
        severity: 'error',
      });
    } else {
      seenInBatch.set(id, rowNumber);

      if (checkExisting && existingSet && existingSet.has(id)) {
        issues.push({
          sheet,
          row: rowNumber,
          column: 'id',
          code: VALIDATION_ERROR_CODES.DUPLICATE_TASK_ID,
          message: `Mã task '${id}' đã tồn tại trong cơ sở dữ liệu/hệ thống.`,
          value: id,
          severity: 'error',
        });
      }
    }
  }

  return issues;
}

/**
 * Kiểm tra trùng lặp mã feature_id trong tập feature đầu vào và với cơ sở dữ liệu hiện có.
 */
export function validateFeatureIdsUniqueness(
  features: FeatureRelationshipCandidate[],
  options: ValidationOptions = {},
): ValidationErrorItem[] {
  const issues: ValidationErrorItem[] = [];
  const sheet = 'Features';
  const seenInBatch = new Map<string, number>();

  const existingSet = options.existingFeatureIds
    ? new Set(Array.from(options.existingFeatureIds))
    : null;
  const checkExisting = options.checkExistingDuplicates !== false;

  for (let idx = 0; idx < features.length; idx++) {
    const feat = features[idx];
    if (!feat) continue;

    const rowNumber = feat.rowNumber ?? idx + 2;
    const id = feat.id ? feat.id.trim() : '';

    if (!id) {
      continue;
    }

    if (seenInBatch.has(id)) {
      const firstSeenRow = seenInBatch.get(id);
      issues.push({
        sheet,
        row: rowNumber,
        column: 'id',
        code: VALIDATION_ERROR_CODES.DUPLICATE_FEATURE_ID,
        message: `Trùng mã feature '${id}' (đã xuất hiện ở dòng ${firstSeenRow}).`,
        value: id,
        severity: 'error',
      });
    } else {
      seenInBatch.set(id, rowNumber);

      if (checkExisting && existingSet && existingSet.has(id)) {
        issues.push({
          sheet,
          row: rowNumber,
          column: 'id',
          code: VALIDATION_ERROR_CODES.DUPLICATE_FEATURE_ID,
          message: `Mã feature '${id}' đã tồn tại trong cơ sở dữ liệu/hệ thống.`,
          value: id,
          severity: 'error',
        });
      }
    }
  }

  return issues;
}

/**
 * Kiểm tra các dependency được khai báo có tồn tại hay không.
 * Một dependency được coi là hợp lệ nếu:
 * 1. Nó nằm trong danh sách task của tập hiện tại (được khai báo trong workbook/batch).
 * 2. HOẶC nó nằm trong danh sách existingTaskIds đã có trong hệ thống.
 */
export function validateDependenciesExistence(
  tasks: TaskRelationshipCandidate[],
  options: ValidationOptions = {},
): ValidationErrorItem[] {
  const issues: ValidationErrorItem[] = [];
  const sheet = 'Tasks';

  // Tập hợp tất cả các task_id hợp lệ
  const availableTaskIds = new Set<string>();

  for (const t of tasks) {
    const id = t.id ? t.id.trim() : '';
    if (id) {
      availableTaskIds.add(id);
    }
  }

  if (options.existingTaskIds !== undefined) {
    for (const id of options.existingTaskIds) {
      if (id && id.trim()) {
        availableTaskIds.add(id.trim());
      }
    }
  } else {
    // Mặc định nạp các mốc Foundation tasks của hệ thống (GĐ 0) đã hoàn thành
    for (const id of FOUNDATION_TASK_IDS) {
      availableTaskIds.add(id);
    }
  }

  for (let idx = 0; idx < tasks.length; idx++) {
    const task = tasks[idx];
    if (!task) continue;

    const rowNumber = task.rowNumber ?? idx + 2;
    const taskId = task.id ? task.id.trim() : '';
    const deps = task.dependencies ?? [];

    for (const dep of deps) {
      const trimmedDep = dep.trim();
      if (!trimmedDep) continue;

      // Bỏ qua nếu là self-dependency vì taskValidator đã kiểm tra
      if (trimmedDep === taskId) {
        continue;
      }

      if (!availableTaskIds.has(trimmedDep)) {
        issues.push({
          sheet,
          row: rowNumber,
          column: 'dependencies',
          code: VALIDATION_ERROR_CODES.NON_EXISTENT_DEPENDENCY,
          message: `Task '${taskId || `dòng ${rowNumber}`}' phụ thuộc vào dependency '${trimmedDep}' không tồn tại.`,
          value: trimmedDep,
          severity: 'error',
        });
      }
    }
  }

  return issues;
}

/**
 * Kiểm tra tính hợp lệ của tham chiếu giữa Task và Feature:
 * 1. task.feature_id phải tồn tại trong features hoặc existingFeatureIds.
 * 2. feature.required_tasks phải tồn tại trong tasks hoặc existingTaskIds.
 */
export function validateCrossEntityReferences(
  tasks: TaskRelationshipCandidate[],
  features: FeatureRelationshipCandidate[] = [],
  options: ValidationOptions = {},
): ValidationErrorItem[] {
  const issues: ValidationErrorItem[] = [];

  // 1. Kiểm tra task.feature_id
  const availableFeatureIds = new Set<string>();
  for (const f of features) {
    const id = f.id ? f.id.trim() : '';
    if (id) {
      availableFeatureIds.add(id);
    }
  }

  if (options.existingFeatureIds) {
    for (const id of options.existingFeatureIds) {
      if (id && id.trim()) {
        availableFeatureIds.add(id.trim());
      }
    }
  }

  // Chỉ kiểm tra feature_id khi có ít nhất một nguồn feature (tập hiện tại hoặc existing)
  // Nếu cả hai đều rỗng và không yêu cầu features sheet thì có thể là import task độc lập
  const hasFeatureContext = availableFeatureIds.size > 0 || options.requireFeaturesSheet;

  for (let idx = 0; idx < tasks.length; idx++) {
    const task = tasks[idx];
    if (!task) continue;

    const rowNumber = task.rowNumber ?? idx + 2;
    const featId = task.feature_id ? task.feature_id.trim() : '';

    if (featId && hasFeatureContext && !availableFeatureIds.has(featId)) {
      issues.push({
        sheet: 'Tasks',
        row: rowNumber,
        column: 'feature_id',
        code: VALIDATION_ERROR_CODES.MISSING_FEATURE,
        message: `Task '${task.id || `dòng ${rowNumber}`}' tham chiếu feature '${featId}' không tồn tại.`,
        value: featId,
        severity: 'error',
      });
    }
  }

  // 2. Kiểm tra feature.required_tasks
  const availableTaskIds = new Set<string>();
  for (const t of tasks) {
    const id = t.id ? t.id.trim() : '';
    if (id) {
      availableTaskIds.add(id);
    }
  }

  if (options.existingTaskIds !== undefined) {
    for (const id of options.existingTaskIds) {
      if (id && id.trim()) {
        availableTaskIds.add(id.trim());
      }
    }
  } else {
    // Mặc định nạp các mốc Foundation tasks của hệ thống (GĐ 0) đã hoàn thành
    for (const id of FOUNDATION_TASK_IDS) {
      availableTaskIds.add(id);
    }
  }

  for (let idx = 0; idx < features.length; idx++) {
    const feature = features[idx];
    if (!feature) continue;

    const rowNumber = feature.rowNumber ?? idx + 2;
    const featId = feature.id ? feature.id.trim() : '';
    const reqTasks = feature.required_tasks ?? [];

    for (const reqTask of reqTasks) {
      const trimmedTask = reqTask.trim();
      if (!trimmedTask) continue;

      if (!availableTaskIds.has(trimmedTask)) {
        issues.push({
          sheet: 'Features',
          row: rowNumber,
          column: 'required_tasks',
          code: VALIDATION_ERROR_CODES.MISSING_REQUIRED_TASK,
          message: `Feature '${featId || `dòng ${rowNumber}`}' yêu cầu task '${trimmedTask}' không tồn tại.`,
          value: trimmedTask,
          severity: 'error',
        });
      }
    }
  }

  return issues;
}

/**
 * Kiểm tra phát hiện chu trình phụ thuộc (circular dependency) trong tập task bằng DFS hoặc Kahn.
 */
export function validateDependencyCycles(
  tasks: TaskRelationshipCandidate[],
  options: ValidationOptions = {},
): ValidationErrorItem[] {
  const issues: ValidationErrorItem[] = [];
  if (options.checkCycles === false || tasks.length === 0) {
    return issues;
  }

  const sheet = 'Tasks';
  const taskRowMap = new Map<string, number>();

  for (let idx = 0; idx < tasks.length; idx++) {
    const task = tasks[idx];
    if (!task) continue;
    const id = task.id ? task.id.trim() : '';
    if (id && !taskRowMap.has(id)) {
      taskRowMap.set(id, task.rowNumber ?? idx + 2);
    }
  }

  const graph = new DependencyGraph();
  for (const task of tasks) {
    const id = task.id ? task.id.trim() : '';
    if (!id) continue;
    graph.addNode(id);
    const deps = task.dependencies ?? [];
    for (const dep of deps) {
      const trimmedDep = dep.trim();
      // Bỏ qua self-dependency vì taskValidator đã có rule riêng
      if (trimmedDep && trimmedDep !== id) {
        graph.addDependency(id, trimmedDep);
      }
    }
  }

  if (options.existingDependencies) {
    for (const edge of options.existingDependencies) {
      if (edge.taskId && edge.dependsOnId && edge.taskId !== edge.dependsOnId) {
        graph.addDependency(edge.taskId, edge.dependsOnId);
      }
    }
  }

  const algorithm = options.cycleAlgorithm ?? 'dfs';
  const allCycles = graph.findAllCyclesDFS();

  if (allCycles.length > 0) {
    const reportedSignatures = new Set<string>();
    for (const cycle of allCycles) {
      const pathString = formatCyclePath(cycle);
      const signature = canonicalizeCycle(cycle).join('->');
      if (reportedSignatures.has(signature)) continue;
      reportedSignatures.add(signature);

      const cycleUniqueNodes = Array.from(new Set(cycle));
      let reportedForCycle = false;

      for (const nodeId of cycleUniqueNodes) {
        const row = taskRowMap.get(nodeId);
        if (row !== undefined) {
          issues.push({
            sheet,
            row,
            column: 'dependencies',
            code: VALIDATION_ERROR_CODES.CIRCULAR_DEPENDENCY,
            message: `Phát hiện chu trình phụ thuộc (circular dependency): ${pathString}`,
            value: cycle,
            severity: 'error',
          });
          reportedForCycle = true;
        }
      }

      if (!reportedForCycle && tasks.length > 0) {
        const firstRow = tasks[0]?.rowNumber ?? 2;
        issues.push({
          sheet,
          row: firstRow,
          column: 'dependencies',
          code: VALIDATION_ERROR_CODES.CIRCULAR_DEPENDENCY,
          message: `Phát hiện chu trình phụ thuộc (circular dependency): ${pathString}`,
          value: cycle,
          severity: 'error',
        });
      }
    }
  } else if (algorithm === 'kahn') {
    const kahnResult = graph.detectCycleKahn();
    if (kahnResult.hasCycle && kahnResult.cycle) {
      const pathString = kahnResult.cyclePathString ?? formatCyclePath(kahnResult.cycle);
      const cycleUniqueNodes = Array.from(new Set(kahnResult.cycle));
      for (const nodeId of cycleUniqueNodes) {
        const row = taskRowMap.get(nodeId);
        if (row !== undefined) {
          issues.push({
            sheet,
            row,
            column: 'dependencies',
            code: VALIDATION_ERROR_CODES.CIRCULAR_DEPENDENCY,
            message: `Phát hiện chu trình phụ thuộc (circular dependency): ${pathString}`,
            value: kahnResult.cycle,
            severity: 'error',
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Kiểm tra toàn diện quan hệ giữa các thực thể (trùng lặp ID và dependency/feature tồn tại).
 */
export function validateRelationships(
  input: {
    tasks?: TaskRelationshipCandidate[];
    features?: FeatureRelationshipCandidate[];
  },
  options: ValidationOptions = {},
): ValidationErrorItem[] {
  const issues: ValidationErrorItem[] = [];
  const tasks = input.tasks ?? [];
  const features = input.features ?? [];

  // 1. Trùng lặp Task ID
  if (tasks.length > 0) {
    issues.push(...validateTaskIdsUniqueness(tasks, options));
  }

  // 2. Trùng lặp Feature ID
  if (features.length > 0) {
    issues.push(...validateFeatureIdsUniqueness(features, options));
  }

  // 3. Dependency không tồn tại
  if (tasks.length > 0) {
    issues.push(...validateDependenciesExistence(tasks, options));
  }

  // 4. Tham chiếu chéo giữa Task và Feature
  issues.push(...validateCrossEntityReferences(tasks, features, options));

  // 5. Chu trình phụ thuộc (Cycle Detection)
  if (tasks.length > 0) {
    issues.push(...validateDependencyCycles(tasks, options));
  }

  return issues;
}
