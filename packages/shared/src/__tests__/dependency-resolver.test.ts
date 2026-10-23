import { describe, it, expect } from 'vitest';
import {
  DependencyResolver,
  isDependencySatisfied,
  checkTaskDependencies,
  resolveReadyTasks,
  type TaskWithDependencies,
} from '../index.js';

function createTask(
  id: string,
  overrides: Partial<TaskWithDependencies> = {},
): TaskWithDependencies {
  return {
    id,
    feature_id: 'feat-1',
    plan_id: null,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    phase: 'phase-1',
    worker_type: 'agy',
    repository: '.',
    scope_files: [],
    acceptance_criteria: ['Acceptance criteria'],
    test_commands: ['pnpm test'],
    priority: 0,
    max_attempts: 3,
    timeout_minutes: 30,
    status: 'TODO',
    attempts: 0,
    created_at: '2026-10-23T00:00:00.000Z',
    updated_at: '2026-10-23T00:00:00.000Z',
    dependencies: [],
    ...overrides,
  };
}

describe('ORC-002: Dependency Resolver (Unit Tests)', () => {
  describe('isDependencySatisfied()', () => {
    it('chỉ trả về true khi trạng thái dependency là DONE', () => {
      expect(isDependencySatisfied('DONE')).toBe(true);
      expect(isDependencySatisfied('TODO')).toBe(false);
      expect(isDependencySatisfied('READY')).toBe(false);
      expect(isDependencySatisfied('RUNNING')).toBe(false);
      expect(isDependencySatisfied('VERIFYING')).toBe(false);
      expect(isDependencySatisfied('FAILED')).toBe(false);
      expect(isDependencySatisfied('BLOCKED')).toBe(false);
      expect(isDependencySatisfied('PAUSED')).toBe(false);
      expect(isDependencySatisfied('CANCELLED')).toBe(false);
      expect(isDependencySatisfied(undefined)).toBe(false);
      expect(isDependencySatisfied(null)).toBe(false);
    });
  });

  describe('checkTaskDependencies()', () => {
    it('task không có dependency thì luôn ready khi ở trạng thái TODO/READY', () => {
      const task = createTask('T1', { status: 'TODO', dependencies: [] });
      const map = new Map([[task.id, task]]);
      const status = checkTaskDependencies(task, map);

      expect(status.isReady).toBe(true);
      expect(status.totalDependencies).toBe(0);
      expect(status.satisfiedDependencies).toEqual([]);
      expect(status.unsatisfiedDependencies).toEqual([]);
      expect(status.missingDependencies).toEqual([]);
      expect(status.reason).toContain('DONE');
    });

    it('task có dependency chưa DONE thì isReady là false kèm lý do rõ ràng', () => {
      const dep = createTask('DEP-1', { status: 'RUNNING' });
      const task = createTask('T2', { status: 'TODO', dependencies: ['DEP-1'] });
      const map = new Map([
        [dep.id, dep],
        [task.id, task],
      ]);

      const status = checkTaskDependencies(task, map);
      expect(status.isReady).toBe(false);
      expect(status.totalDependencies).toBe(1);
      expect(status.satisfiedDependencies).toEqual([]);
      expect(status.unsatisfiedDependencies).toEqual([{ id: 'DEP-1', status: 'RUNNING' }]);
      expect(status.reason).toContain('DEP-1 (RUNNING)');
    });

    it('task có dependency không tồn tại (MISSING) thì isReady là false', () => {
      const task = createTask('T3', { status: 'TODO', dependencies: ['NON_EXISTENT'] });
      const map = new Map([[task.id, task]]);

      const status = checkTaskDependencies(task, map);
      expect(status.isReady).toBe(false);
      expect(status.missingDependencies).toEqual(['NON_EXISTENT']);
      expect(status.unsatisfiedDependencies).toEqual([{ id: 'NON_EXISTENT', status: 'MISSING' }]);
      expect(status.reason).toContain('MISSING');
    });

    it('task có tất cả dependencies đều DONE thì isReady là true', () => {
      const d1 = createTask('D1', { status: 'DONE' });
      const d2 = createTask('D2', { status: 'DONE' });
      const task = createTask('T4', { status: 'TODO', dependencies: ['D1', 'D2'] });
      const map = new Map([
        [d1.id, d1],
        [d2.id, d2],
        [task.id, task],
      ]);

      const status = checkTaskDependencies(task, map);
      expect(status.isReady).toBe(true);
      expect(status.satisfiedDependencies).toEqual(['D1', 'D2']);
      expect(status.unsatisfiedDependencies).toEqual([]);
    });

    it('task có trạng thái không thể nhận (như RUNNING hoặc DONE) thì isReady là false', () => {
      const taskDone = createTask('T-DONE', { status: 'DONE', dependencies: [] });
      const statusDone = checkTaskDependencies(taskDone, new Map([[taskDone.id, taskDone]]));
      expect(statusDone.isReady).toBe(false);
      expect(statusDone.reason).toContain('DONE');

      const taskRunning = createTask('T-RUNNING', { status: 'RUNNING', dependencies: [] });
      const statusRunning = checkTaskDependencies(taskRunning, new Map([[taskRunning.id, taskRunning]]));
      expect(statusRunning.isReady).toBe(false);
      expect(statusRunning.reason).toContain('RUNNING');
    });
  });

  describe('DependencyResolver Core — Chỉ trả task đủ dependency', () => {
    it('chỉ trả các task có toàn bộ dependencies đã hoàn tất (DONE)', () => {
      const tasks: TaskWithDependencies[] = [
        createTask('ROOT-1', { status: 'DONE', dependencies: [] }),
        createTask('ROOT-2', { status: 'RUNNING', dependencies: [] }),
        createTask('ROOT-3', { status: 'TODO', dependencies: [] }),
        createTask('CHILD-1', { status: 'TODO', dependencies: ['ROOT-1'] }), // Đủ: ROOT-1 DONE
        createTask('CHILD-2', { status: 'TODO', dependencies: ['ROOT-2'] }), // Chưa đủ: ROOT-2 RUNNING
        createTask('CHILD-3', { status: 'TODO', dependencies: ['ROOT-1', 'ROOT-2'] }), // Chưa đủ
        createTask('CHILD-4', { status: 'TODO', dependencies: ['ROOT-1', 'ROOT-3'] }), // Chưa đủ: ROOT-3 TODO
        createTask('CHILD-5', { status: 'READY', dependencies: ['ROOT-1'] }), // Đủ: ROOT-1 DONE, status READY
      ];

      const resolver = new DependencyResolver(tasks);
      const readyTasks = resolver.getReadyTasks();

      const readyIds = readyTasks.map((t) => t.id);
      // ROOT-3 (no deps, TODO), CHILD-1 (dep ROOT-1 DONE), CHILD-5 (dep ROOT-1 DONE)
      expect(readyIds).toContain('ROOT-3');
      expect(readyIds).toContain('CHILD-1');
      expect(readyIds).toContain('CHILD-5');

      // Các task chưa đủ dependency tuyệt đối không được trả về
      expect(readyIds).not.toContain('ROOT-1'); // Đã DONE
      expect(readyIds).not.toContain('ROOT-2'); // Đang RUNNING
      expect(readyIds).not.toContain('CHILD-2'); // dep ROOT-2 RUNNING
      expect(readyIds).not.toContain('CHILD-3'); // dep ROOT-2 RUNNING
      expect(readyIds).not.toContain('CHILD-4'); // dep ROOT-3 TODO

      // Kiểm tra mọi task trong readyTasks đều có dependencies đã DONE
      for (const t of readyTasks) {
        for (const depId of t.dependencies) {
          const dep = resolver.getTask(depId);
          expect(dep?.status).toBe('DONE');
        }
      }
    });

    it('sắp xếp thứ tự task READY theo priority giảm dần, sau đó theo created_at và ID', () => {
      const tasks: TaskWithDependencies[] = [
        createTask('T-LOW', { priority: 1, created_at: '2026-10-23T01:00:00.000Z' }),
        createTask('T-HIGH', { priority: 100, created_at: '2026-10-23T02:00:00.000Z' }),
        createTask('T-MID-2', { priority: 50, created_at: '2026-10-23T01:30:00.000Z' }),
        createTask('T-MID-1', { priority: 50, created_at: '2026-10-23T01:00:00.000Z' }),
      ];

      const resolver = new DependencyResolver(tasks);
      const readyTasks = resolver.getReadyTasks();

      expect(readyTasks.map((t) => t.id)).toEqual(['T-HIGH', 'T-MID-1', 'T-MID-2', 'T-LOW']);
      expect(resolver.getNextReadyTask()?.id).toBe('T-HIGH');
    });

    it('hỗ trợ giới hạn số lượng task (limit)', () => {
      const tasks: TaskWithDependencies[] = [
        createTask('T1', { priority: 10 }),
        createTask('T2', { priority: 20 }),
        createTask('T3', { priority: 30 }),
      ];

      const resolver = new DependencyResolver(tasks);
      const readyOne = resolver.getReadyTasks({ limit: 1 });
      expect(readyOne).toHaveLength(1);
      expect(readyOne[0]?.id).toBe('T3');

      const readyTwo = resolver.getReadyTasks({ limit: 2 });
      expect(readyTwo.map((t) => t.id)).toEqual(['T3', 'T2']);
    });

    it('hỗ trợ lọc theo featureId, phase và repository', () => {
      const tasks: TaskWithDependencies[] = [
        createTask('T1', { feature_id: 'feat-A', phase: 'P1', repository: 'repo-1' }),
        createTask('T2', { feature_id: 'feat-B', phase: 'P1', repository: 'repo-1' }),
        createTask('T3', { feature_id: 'feat-A', phase: 'P2', repository: 'repo-1' }),
        createTask('T4', { feature_id: 'feat-A', phase: 'P1', repository: 'repo-2' }),
      ];

      const resolver = new DependencyResolver(tasks);

      const byFeature = resolver.getReadyTasks({ featureId: 'feat-A' });
      expect(byFeature.map((t) => t.id)).toEqual(['T1', 'T3', 'T4']);

      const byPhase = resolver.getReadyTasks({ phase: 'P1' });
      expect(byPhase.map((t) => t.id)).toEqual(['T1', 'T2', 'T4']);

      const byRepo = resolver.getReadyTasks({ repository: 'repo-2' });
      expect(byRepo.map((t) => t.id)).toEqual(['T4']);
    });

    it('chu trình kim cương (Diamond): chỉ trả D khi cả B và C đều DONE', () => {
      // A -> B, A -> C, (B, C) -> D
      const tA = createTask('A', { status: 'TODO', dependencies: [] });
      const tB = createTask('B', { status: 'TODO', dependencies: ['A'] });
      const tC = createTask('C', { status: 'TODO', dependencies: ['A'] });
      const tD = createTask('D', { status: 'TODO', dependencies: ['B', 'C'] });

      const resolver = new DependencyResolver([tA, tB, tC, tD]);

      // Bước 0: Chưa ai làm gì -> chỉ A ready
      expect(resolver.getReadyTasks().map((t) => t.id)).toEqual(['A']);

      // Bước 1: A hoàn thành (DONE) -> B và C ready, D chưa ready
      resolver.addTask({ ...tA, status: 'DONE' });
      expect(resolver.getReadyTasks().map((t) => t.id)).toEqual(['B', 'C']);

      // Bước 2: B hoàn thành (DONE), C đang RUNNING -> D vẫn chưa ready (vì C chưa DONE)
      resolver.addTask({ ...tB, status: 'DONE' });
      resolver.addTask({ ...tC, status: 'RUNNING' });
      expect(resolver.getReadyTasks().map((t) => t.id)).toEqual([]);

      // Bước 3: C hoàn thành (DONE) -> D lập tức trở thành READY!
      resolver.addTask({ ...tC, status: 'DONE' });
      expect(resolver.getReadyTasks().map((t) => t.id)).toEqual(['D']);
    });

    it('tổng hợp trạng thái đồ thị qua getResolutionSummary()', () => {
      const tasks: TaskWithDependencies[] = [
        createTask('T-DONE', { status: 'DONE' }),
        createTask('T-READY', { status: 'TODO', dependencies: ['T-DONE'] }),
        createTask('T-FAILED', { status: 'FAILED' }),
        createTask('T-BLOCKED', { status: 'TODO', dependencies: ['T-FAILED'] }),
        createTask('T-PENDING', { status: 'TODO', dependencies: ['T-READY'] }),
      ];

      const resolver = new DependencyResolver(tasks);
      const summary = resolver.getResolutionSummary();

      expect(summary.totalTasks).toBe(5);
      expect(summary.completedTasks.map((t) => t.id)).toEqual(['T-DONE']);
      expect(summary.readyTasks.map((t) => t.id)).toEqual(['T-READY']);
      expect(summary.blockedTasks.map((b) => b.task.id)).toEqual(['T-BLOCKED']);
      expect(summary.pendingTasks.map((p) => p.task.id)).toEqual(['T-PENDING']);

      const blockedByFailures = resolver.findBlockedByFailedTasks();
      expect(blockedByFailures.map((b) => b.task.id)).toEqual(['T-BLOCKED']);
      expect(blockedByFailures[0]?.failedDependencies).toEqual(['T-FAILED']);
    });

    it('hàm helper resolveReadyTasks hoạt động nhất quán', () => {
      const tasks = [
        createTask('A', { status: 'DONE' }),
        createTask('B', { status: 'TODO', dependencies: ['A'] }),
      ];
      const ready = resolveReadyTasks(tasks);
      expect(ready.map((t) => t.id)).toEqual(['B']);
    });
  });
});
