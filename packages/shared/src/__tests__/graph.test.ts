import { describe, it, expect } from 'vitest';
import {
  DependencyGraph,
  detectCycleDFS,
  detectCycleKahn,
  detectCycle,
  topologicalSort,
  findCycle,
  formatCyclePath,
  canonicalizeCycle,
} from '../graph/index.js';
import { AppError } from '../errors.js';

describe('DependencyGraph & Cycle Detection (TSK-005)', () => {
  describe('Đồ thị KHÔNG chu trình (DAG - Directed Acyclic Graph)', () => {
    it('Xác nhận đồ thị rỗng không có chu trình', () => {
      const graph = new DependencyGraph();
      const dfsResult = graph.detectCycleDFS();
      const kahnResult = graph.detectCycleKahn();

      expect(dfsResult.hasCycle).toBe(false);
      expect(dfsResult.cycle).toBeNull();
      expect(kahnResult.hasCycle).toBe(false);
      expect(kahnResult.cycle).toBeNull();
      expect(graph.topologicalSort()).toEqual([]);
    });

    it('Xác nhận 1 task độc lập không có chu trình', () => {
      const graph = new DependencyGraph([{ id: 'TSK-1', dependencies: [] }]);

      expect(graph.hasCycle()).toBe(false);
      expect(graph.detectCycleDFS().hasCycle).toBe(false);
      expect(graph.detectCycleKahn().hasCycle).toBe(false);
      expect(graph.topologicalSort()).toEqual(['TSK-1']);
    });

    it('Xác nhận đồ thị tuyến tính: A -> B -> C không có chu trình', () => {
      // TSK-3 phụ thuộc TSK-2, TSK-2 phụ thuộc TSK-1
      const tasks = [
        { id: 'TSK-1', dependencies: [] },
        { id: 'TSK-2', dependencies: ['TSK-1'] },
        { id: 'TSK-3', dependencies: ['TSK-2'] },
      ];

      const graph = new DependencyGraph(tasks);

      const dfsRes = graph.detectCycleDFS();
      expect(dfsRes.hasCycle).toBe(false);
      expect(dfsRes.cycle).toBeNull();

      const kahnRes = graph.detectCycleKahn();
      expect(kahnRes.hasCycle).toBe(false);
      expect(kahnRes.cycle).toBeNull();

      // Thứ tự thực thi: TSK-1 phải chạy trước TSK-2, TSK-2 trước TSK-3
      const order = graph.topologicalSort();
      expect(order).toEqual(['TSK-1', 'TSK-2', 'TSK-3']);
    });

    it('Xác nhận đồ thị hình kim cương (Diamond): A -> (B, C) -> D', () => {
      // D phụ thuộc B và C; B và C phụ thuộc A
      const tasks = [
        { id: 'A', dependencies: [] },
        { id: 'B', dependencies: ['A'] },
        { id: 'C', dependencies: ['A'] },
        { id: 'D', dependencies: ['B', 'C'] },
      ];

      const graph = new DependencyGraph(tasks);
      expect(graph.detectCycleDFS().hasCycle).toBe(false);
      expect(graph.detectCycleKahn().hasCycle).toBe(false);

      const order = graph.topologicalSort();
      expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
      expect(order.indexOf('A')).toBeLessThan(order.indexOf('C'));
      expect(order.indexOf('B')).toBeLessThan(order.indexOf('D'));
      expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'));
    });

    it('Xác nhận đồ thị rời rạc gồm nhiều thành phần liên thông không có chu trình', () => {
      // Component 1: T1 -> T2
      // Component 2: T3 -> T4 -> T5
      const tasks = [
        { id: 'T1', dependencies: [] },
        { id: 'T2', dependencies: ['T1'] },
        { id: 'T3', dependencies: [] },
        { id: 'T4', dependencies: ['T3'] },
        { id: 'T5', dependencies: ['T4'] },
      ];

      const graph = new DependencyGraph(tasks);
      expect(graph.detectCycleDFS().hasCycle).toBe(false);
      expect(graph.detectCycleKahn().hasCycle).toBe(false);

      const order = graph.topologicalSort();
      expect(order.indexOf('T1')).toBeLessThan(order.indexOf('T2'));
      expect(order.indexOf('T3')).toBeLessThan(order.indexOf('T4'));
      expect(order.indexOf('T4')).toBeLessThan(order.indexOf('T5'));
    });

    it('Topological sort ưu tiên sắp xếp theo priority khi có nhiều task sẵn sàng', () => {
      // P1, P2, P3 đều không có dependencies, nhưng có priority khác nhau
      const tasks = [
        { id: 'LOW', dependencies: [], priority: 1 },
        { id: 'HIGH', dependencies: [], priority: 10 },
        { id: 'MED', dependencies: [], priority: 5 },
      ];

      const graph = new DependencyGraph(tasks);
      const order = graph.topologicalSort();
      expect(order).toEqual(['HIGH', 'MED', 'LOW']);
    });
  });

  describe('Đồ thị CÓ chu trình (Cyclic Graph)', () => {
    it('Phát hiện self-dependency (A -> A) và trả về đường đi chu trình', () => {
      const graph = new DependencyGraph();
      graph.addDependency('A', 'A');

      const dfsResult = graph.detectCycleDFS();
      expect(dfsResult.hasCycle).toBe(true);
      expect(dfsResult.cycle).toEqual(['A', 'A']);
      expect(dfsResult.cyclePathString).toBe('A -> A');

      const kahnResult = graph.detectCycleKahn();
      expect(kahnResult.hasCycle).toBe(true);
      expect(kahnResult.cycle).toEqual(['A', 'A']);
      expect(kahnResult.cyclePathString).toBe('A -> A');
    });

    it('Phát hiện chu trình 2 node (A -> B -> A) và trả về đường đi', () => {
      const tasks = [
        { id: 'A', dependencies: ['B'] },
        { id: 'B', dependencies: ['A'] },
      ];

      const graph = new DependencyGraph(tasks);

      const dfsResult = graph.detectCycleDFS();
      expect(dfsResult.hasCycle).toBe(true);
      expect(dfsResult.cycle).toEqual(['A', 'B', 'A']);
      expect(dfsResult.cyclePathString).toBe('A -> B -> A');

      const kahnResult = graph.detectCycleKahn();
      expect(kahnResult.hasCycle).toBe(true);
      expect(kahnResult.cycle).toEqual(['A', 'B', 'A']);
      expect(kahnResult.cyclePathString).toBe('A -> B -> A');
    });

    it('Phát hiện chu trình 3 node (A -> B -> C -> A) và trả về đường đi khép kín', () => {
      const tasks = [
        { id: 'A', dependencies: ['B'] },
        { id: 'B', dependencies: ['C'] },
        { id: 'C', dependencies: ['A'] },
      ];

      const graph = new DependencyGraph(tasks);

      const dfsResult = graph.detectCycleDFS();
      expect(dfsResult.hasCycle).toBe(true);
      expect(dfsResult.cycle).toEqual(['A', 'B', 'C', 'A']);
      expect(dfsResult.cyclePathString).toBe('A -> B -> C -> A');

      const kahnResult = graph.detectCycleKahn();
      expect(kahnResult.hasCycle).toBe(true);
      expect(kahnResult.cycle).toEqual(['A', 'B', 'C', 'A']);
      expect(kahnResult.cyclePathString).toBe('A -> B -> C -> A');
    });

    it('Phát hiện chu trình khi có nhánh dẫn vào (In-tail: X -> Y -> A -> B -> A)', () => {
      // X phụ thuộc Y, Y phụ thuộc A; A và B tạo chu trình
      const tasks = [
        { id: 'X', dependencies: ['Y'] },
        { id: 'Y', dependencies: ['A'] },
        { id: 'A', dependencies: ['B'] },
        { id: 'B', dependencies: ['A'] },
      ];

      const graph = new DependencyGraph(tasks);

      const dfsResult = graph.detectCycleDFS();
      expect(dfsResult.hasCycle).toBe(true);
      // Đường đi chu trình chỉ chứa các node trong chu trình (A, B)
      expect(dfsResult.cycle).toEqual(['A', 'B', 'A']);

      const kahnResult = graph.detectCycleKahn();
      expect(kahnResult.hasCycle).toBe(true);
      expect(kahnResult.cycle).toEqual(['A', 'B', 'A']);
    });

    it('Phát hiện chu trình khi có nhánh dẫn ra (Out-tail: A -> B -> A -> Z)', () => {
      const tasks = [
        { id: 'A', dependencies: ['B'] },
        { id: 'B', dependencies: ['A'] },
        { id: 'Z', dependencies: ['A'] },
      ];

      const graph = new DependencyGraph(tasks);

      const dfsResult = graph.detectCycleDFS();
      expect(dfsResult.hasCycle).toBe(true);
      expect(dfsResult.cycle).toEqual(['A', 'B', 'A']);

      const kahnResult = graph.detectCycleKahn();
      expect(kahnResult.hasCycle).toBe(true);
      expect(kahnResult.cycle).toEqual(['A', 'B', 'A']);
    });

    it('Phát hiện chu trình trong đồ thị có thành phần độc lập (DAG + Cycle component)', () => {
      // Thành phần 1 (DAG): OK1 -> OK2
      // Thành phần 2 (Cycle): C1 -> C2 -> C3 -> C1
      const tasks = [
        { id: 'OK1', dependencies: [] },
        { id: 'OK2', dependencies: ['OK1'] },
        { id: 'C1', dependencies: ['C2'] },
        { id: 'C2', dependencies: ['C3'] },
        { id: 'C3', dependencies: ['C1'] },
      ];

      const graph = new DependencyGraph(tasks);

      const dfsResult = graph.detectCycleDFS();
      expect(dfsResult.hasCycle).toBe(true);
      expect(dfsResult.cycle).toEqual(['C1', 'C2', 'C3', 'C1']);

      const kahnResult = graph.detectCycleKahn();
      expect(kahnResult.hasCycle).toBe(true);
      expect(kahnResult.cycle).toEqual(['C1', 'C2', 'C3', 'C1']);
    });

    it('findAllCyclesDFS phát hiện và thu thập tất cả các chu trình rời nhau', () => {
      // Chu trình 1: A <-> B
      // Chu trình 2: C <-> D
      const tasks = [
        { id: 'A', dependencies: ['B'] },
        { id: 'B', dependencies: ['A'] },
        { id: 'C', dependencies: ['D'] },
        { id: 'D', dependencies: ['C'] },
      ];

      const graph = new DependencyGraph(tasks);
      const allCycles = graph.findAllCyclesDFS();

      expect(allCycles.length).toBe(2);
      expect(allCycles).toContainEqual(['A', 'B', 'A']);
      expect(allCycles).toContainEqual(['C', 'D', 'C']);
    });

    it('topologicalSort ném AppError("CIRCULAR_DEPENDENCY_ERROR") khi đồ thị có chu trình', () => {
      const tasks = [
        { id: 'TASK-A', dependencies: ['TASK-B'] },
        { id: 'TASK-B', dependencies: ['TASK-A'] },
      ];

      const graph = new DependencyGraph(tasks);

      expect(() => graph.topologicalSort()).toThrowError(AppError);
      try {
        graph.topologicalSort();
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        const appErr = err as AppError;
        expect(appErr.code).toBe('CIRCULAR_DEPENDENCY_ERROR');
        expect(appErr.context.cycle).toEqual(['TASK-A', 'TASK-B', 'TASK-A']);
        expect(appErr.context.cyclePathString).toBe('TASK-A -> TASK-B -> TASK-A');
      }
    });
  });

  describe('Các hàm tiện ích độc lập (Standalone Helper Functions)', () => {
    const dagTasks = [
      { id: '1', dependencies: [] },
      { id: '2', dependencies: ['1'] },
    ];

    const cycleTasks = [
      { id: 'X', dependencies: ['Y'] },
      { id: 'Y', dependencies: ['X'] },
    ];

    it('detectCycleDFS / detectCycleKahn / detectCycle hoạt động với mảng tasks', () => {
      expect(detectCycleDFS(dagTasks).hasCycle).toBe(false);
      expect(detectCycleKahn(dagTasks).hasCycle).toBe(false);
      expect(detectCycle(dagTasks).hasCycle).toBe(false);

      expect(detectCycleDFS(cycleTasks).hasCycle).toBe(true);
      expect(detectCycleKahn(cycleTasks).hasCycle).toBe(true);
      expect(detectCycle(cycleTasks, { algorithm: 'kahn' }).hasCycle).toBe(true);
    });

    it('findCycle trả về đường đi chu trình hoặc null', () => {
      expect(findCycle(dagTasks)).toBeNull();
      expect(findCycle(cycleTasks)).toEqual(['X', 'Y', 'X']);
      expect(findCycle(cycleTasks, 'kahn')).toEqual(['X', 'Y', 'X']);
    });

    it('topologicalSort trả về thứ tự cho DAG và ném lỗi cho đồ thị có chu trình', () => {
      expect(topologicalSort(dagTasks)).toEqual(['1', '2']);
      expect(() => topologicalSort(cycleTasks)).toThrowError(AppError);
    });

    it('formatCyclePath và canonicalizeCycle hoạt động chính xác', () => {
      expect(formatCyclePath(['A', 'B', 'C', 'A'])).toBe('A -> B -> C -> A');
      expect(formatCyclePath([])).toBe('');

      // Chu trình bắt đầu từ B: B -> C -> A -> B được chuẩn hóa về A -> B -> C -> A
      const rotated = canonicalizeCycle(['B', 'C', 'A', 'B']);
      expect(rotated).toEqual(['A', 'B', 'C', 'A']);
    });
  });
});
