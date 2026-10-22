import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DependencyGraph,
  detectCycleDFS,
  detectCycleKahn,
  detectCycle,
  findCycle,
  topologicalSort,
  formatCyclePath,
  canonicalizeCycle,
  validateWorkbook,
  validateRawWorkbook,
  assertValidWorkbook,
  WorkbookValidationError,
  VALIDATION_ERROR_CODES,
  AppError,
  type ParsedWorkbookResult,
  type ValidationErrorItem,
} from '../packages/shared/src/index.js';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  TaskDependencyRepository,
} from '../packages/db/src/index.js';

describe('TSK-005: Phát hiện cycle (DFS/Kahn), trả về đường đi chu trình — Nghiệm thu đồ thị có/không chu trình', () => {
  let db: ReturnType<typeof createDatabase>;
  let taskRepo: TaskRepository;
  let depRepo: TaskDependencyRepository;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    depRepo = new TaskDependencyRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('Nghiệm thu 1: Đồ thị không chu trình (DAG) — Kiểm tra bằng cả DFS và Kahn', () => {
    it('Đồ thị tuyến tính: xác nhận không chu trình, thứ tự thực thi chuẩn xác', () => {
      // T3 depends on T2, T2 depends on T1
      const tasks = [
        { id: 'TSK-1', dependencies: [] },
        { id: 'TSK-2', dependencies: ['TSK-1'] },
        { id: 'TSK-3', dependencies: ['TSK-2'] },
      ];

      const graph = new DependencyGraph(tasks);

      // 1. Kiểm tra bằng DFS
      const dfsResult = graph.detectCycleDFS();
      expect(dfsResult.hasCycle).toBe(false);
      expect(dfsResult.cycle).toBeNull();
      expect(dfsResult.cyclePathString).toBeNull();
      expect(dfsResult.algorithm).toBe('dfs');

      // 2. Kiểm tra bằng Kahn
      const kahnResult = graph.detectCycleKahn();
      expect(kahnResult.hasCycle).toBe(false);
      expect(kahnResult.cycle).toBeNull();
      expect(kahnResult.cyclePathString).toBeNull();
      expect(kahnResult.algorithm).toBe('kahn');

      // 3. Thứ tự thực thi topological: TSK-1 -> TSK-2 -> TSK-3
      const order = graph.topologicalSort();
      expect(order).toEqual(['TSK-1', 'TSK-2', 'TSK-3']);
    });

    it('Đồ thị hình kim cương (Diamond DAG): nhiều nhánh hội tụ không tạo chu trình', () => {
      // START -> A, B -> END
      const diamond = [
        { id: 'START', dependencies: [] },
        { id: 'BRANCH-A', dependencies: ['START'] },
        { id: 'BRANCH-B', dependencies: ['START'] },
        { id: 'END', dependencies: ['BRANCH-A', 'BRANCH-B'] },
      ];

      const graph = new DependencyGraph(diamond);

      expect(graph.detectCycleDFS().hasCycle).toBe(false);
      expect(graph.detectCycleKahn().hasCycle).toBe(false);
      expect(graph.hasCycle()).toBe(false);
      expect(detectCycle(diamond).hasCycle).toBe(false);

      const order = graph.topologicalSort();
      const fnOrder = topologicalSort(diamond);
      expect(fnOrder).toEqual(order);
      expect(order.indexOf('START')).toBeLessThan(order.indexOf('BRANCH-A'));
      expect(order.indexOf('START')).toBeLessThan(order.indexOf('BRANCH-B'));
      expect(order.indexOf('BRANCH-A')).toBeLessThan(order.indexOf('END'));
      expect(order.indexOf('BRANCH-B')).toBeLessThan(order.indexOf('END'));
    });

    it('Đồ thị mô phỏng Roadmap AI Orchestrator (12 nodes, nhiều tầng): không chu trình', () => {
      // FND -> TSK -> AGY -> ORC -> QLT -> REL -> UI -> OPS
      const roadmapNodes = [
        { id: 'FND-001', dependencies: [] },
        { id: 'FND-002', dependencies: ['FND-001'] },
        { id: 'FND-003', dependencies: ['FND-001'] },
        { id: 'TSK-001', dependencies: ['FND-003'] },
        { id: 'TSK-002', dependencies: ['TSK-001'] },
        { id: 'TSK-003', dependencies: ['TSK-002'] },
        { id: 'TSK-004', dependencies: ['TSK-001'] },
        { id: 'TSK-005', dependencies: ['TSK-004'] },
        { id: 'AGY-001', dependencies: ['FND-001'] },
        { id: 'AGY-002', dependencies: ['AGY-001'] },
        { id: 'ORC-001', dependencies: ['TSK-001', 'AGY-002'] },
        { id: 'ORC-002', dependencies: ['TSK-005', 'ORC-001'] },
      ];

      const graph = new DependencyGraph(roadmapNodes);

      expect(graph.detectCycleDFS().hasCycle).toBe(false);
      expect(graph.detectCycleKahn().hasCycle).toBe(false);

      const order = graph.topologicalSort();
      expect(order).toHaveLength(12);
      expect(order.indexOf('FND-001')).toBe(0);
      expect(order.indexOf('TSK-005')).toBeLessThan(order.indexOf('ORC-002'));
    });
  });

  describe('Nghiệm thu 2: Đồ thị có chu trình trực tiếp 2 node (A <-> B) — Trả về đường đi chu trình', () => {
    it('Phát hiện chu trình 2 node và trả về đúng đường đi chu trình bằng cả DFS và Kahn', () => {
      const cycleTasks = [
        { id: 'TASK-ALPHA', dependencies: ['TASK-BETA'] },
        { id: 'TASK-BETA', dependencies: ['TASK-ALPHA'] },
      ];

      const graph = new DependencyGraph(cycleTasks);

      // 1. Kiểm tra DFS
      const dfsResult = graph.detectCycleDFS();
      expect(dfsResult.hasCycle).toBe(true);
      expect(dfsResult.cycle).toEqual(['TASK-ALPHA', 'TASK-BETA', 'TASK-ALPHA']);
      expect(dfsResult.cyclePathString).toBe('TASK-ALPHA -> TASK-BETA -> TASK-ALPHA');

      // 2. Kiểm tra Kahn
      const kahnResult = graph.detectCycleKahn();
      expect(kahnResult.hasCycle).toBe(true);
      expect(kahnResult.cycle).toEqual(['TASK-ALPHA', 'TASK-BETA', 'TASK-ALPHA']);
      expect(kahnResult.cyclePathString).toBe('TASK-ALPHA -> TASK-BETA -> TASK-ALPHA');

      // 3. Hàm tiện ích findCycle
      expect(findCycle(cycleTasks, 'dfs')).toEqual(['TASK-ALPHA', 'TASK-BETA', 'TASK-ALPHA']);
      expect(findCycle(cycleTasks, 'kahn')).toEqual(['TASK-ALPHA', 'TASK-BETA', 'TASK-ALPHA']);
    });
  });

  describe('Nghiệm thu 3: Đồ thị có chu trình 3+ node (A -> B -> C -> A) — Trả về chu trình khép kín', () => {
    it('Phát hiện chu trình tam giác 3 node và trả về đường đi chu trình khép kín', () => {
      const triangleCycle = [
        { id: 'N1', dependencies: ['N2'] },
        { id: 'N2', dependencies: ['N3'] },
        { id: 'N3', dependencies: ['N1'] },
      ];

      const graph = new DependencyGraph(triangleCycle);

      const dfsResult = graph.detectCycleDFS();
      expect(dfsResult.hasCycle).toBe(true);
      expect(dfsResult.cycle).toEqual(['N1', 'N2', 'N3', 'N1']);
      expect(dfsResult.cyclePathString).toBe('N1 -> N2 -> N3 -> N1');

      const kahnResult = graph.detectCycleKahn();
      expect(kahnResult.hasCycle).toBe(true);
      expect(kahnResult.cycle).toEqual(['N1', 'N2', 'N3', 'N1']);
      expect(kahnResult.cyclePathString).toBe('N1 -> N2 -> N3 -> N1');

      // topologicalSort ném lỗi có context chi tiết
      expect(() => graph.topologicalSort()).toThrowError(AppError);
      try {
        graph.topologicalSort();
      } catch (e) {
        const appErr = e as AppError;
        expect(appErr.code).toBe('CIRCULAR_DEPENDENCY_ERROR');
        expect(appErr.context.cycle).toEqual(['N1', 'N2', 'N3', 'N1']);
        expect(appErr.context.cyclePathString).toBe('N1 -> N2 -> N3 -> N1');
      }
    });

    it('Phát hiện chu trình 4 node (A -> B -> C -> D -> A)', () => {
      const cycle4 = [
        { id: 'P', dependencies: ['Q'] },
        { id: 'Q', dependencies: ['R'] },
        { id: 'R', dependencies: ['S'] },
        { id: 'S', dependencies: ['P'] },
      ];

      const dfs = detectCycleDFS(cycle4);
      expect(dfs.hasCycle).toBe(true);
      expect(dfs.cycle).toEqual(['P', 'Q', 'R', 'S', 'P']);
      expect(dfs.cyclePathString).toBe('P -> Q -> R -> S -> P');

      const kahn = detectCycleKahn(cycle4);
      expect(kahn.hasCycle).toBe(true);
      expect(kahn.cycle).toEqual(['P', 'Q', 'R', 'S', 'P']);
    });
  });

  describe('Nghiệm thu 4: Đồ thị tự phụ thuộc (Self Loop: A -> A) — Trả về chu trình [A, A]', () => {
    it('Phát hiện tự phụ thuộc và trích xuất chu trình [A, A]', () => {
      const selfLoop = [{ id: 'SELF', dependencies: ['SELF'] }];

      const dfs = detectCycleDFS(selfLoop);
      expect(dfs.hasCycle).toBe(true);
      expect(dfs.cycle).toEqual(['SELF', 'SELF']);
      expect(dfs.cyclePathString).toBe('SELF -> SELF');

      const kahn = detectCycleKahn(selfLoop);
      expect(kahn.hasCycle).toBe(true);
      expect(kahn.cycle).toEqual(['SELF', 'SELF']);
      expect(kahn.cyclePathString).toBe('SELF -> SELF');
    });
  });

  describe('Nghiệm thu 5: Đồ thị có nhánh dẫn vào / ra chu trình — Trích xuất chính xác chu trình', () => {
    it('Nhánh dẫn vào (In-tail): ROOT -> MID -> C1 -> C2 -> C1 (không lẫn ROOT, MID trong chu trình)', () => {
      const graphWithTailIn = [
        { id: 'ROOT', dependencies: [] },
        { id: 'MID', dependencies: ['ROOT'] },
        { id: 'C1', dependencies: ['MID', 'C2'] },
        { id: 'C2', dependencies: ['C1'] },
      ];

      const dfs = detectCycleDFS(graphWithTailIn);
      expect(dfs.hasCycle).toBe(true);
      expect(dfs.cycle).toEqual(['C1', 'C2', 'C1']);

      const kahn = detectCycleKahn(graphWithTailIn);
      expect(kahn.hasCycle).toBe(true);
      expect(kahn.cycle).toEqual(['C1', 'C2', 'C1']);
    });

    it('Nhánh dẫn ra (Out-tail): C1 -> C2 -> C1; LEAF phụ thuộc C2 (không lẫn LEAF trong chu trình)', () => {
      const graphWithTailOut = [
        { id: 'C1', dependencies: ['C2'] },
        { id: 'C2', dependencies: ['C1'] },
        { id: 'LEAF', dependencies: ['C2'] },
      ];

      const dfs = detectCycleDFS(graphWithTailOut);
      expect(dfs.hasCycle).toBe(true);
      expect(dfs.cycle).toEqual(['C1', 'C2', 'C1']);

      const kahn = detectCycleKahn(graphWithTailOut);
      expect(kahn.hasCycle).toBe(true);
      expect(kahn.cycle).toEqual(['C1', 'C2', 'C1']);
    });
  });

  describe('Nghiệm thu 6: Đồ thị có nhiều chu trình rời rạc — Thu thập toàn bộ chu trình', () => {
    it('findAllCyclesDFS thu thập đầy đủ các chu trình riêng biệt', () => {
      // Chu trình 1: K1 <-> K2
      // Chu trình 2: M1 -> M2 -> M3 -> M1
      const multiCycles = [
        { id: 'K1', dependencies: ['K2'] },
        { id: 'K2', dependencies: ['K1'] },
        { id: 'M1', dependencies: ['M2'] },
        { id: 'M2', dependencies: ['M3'] },
        { id: 'M3', dependencies: ['M1'] },
      ];

      const graph = new DependencyGraph(multiCycles);
      const allCycles = graph.findAllCyclesDFS();

      expect(allCycles.length).toBe(2);
      expect(allCycles).toContainEqual(['K1', 'K2', 'K1']);
      expect(allCycles).toContainEqual(['M1', 'M2', 'M3', 'M1']);
    });
  });

  describe('Nghiệm thu 7: Tích hợp Workbook Validator — Từ chối workbook chứa chu trình', () => {
    it('validateWorkbook phát hiện chu trình phụ thuộc và báo lỗi CIRCULAR_DEPENDENCY tại sheet Tasks', () => {
      const invalidWorkbook: ParsedWorkbookResult = {
        tasks: [
          {
            id: 'CYCLE-X',
            feature_id: null,
            title: 'Task X',
            description: null,
            phase: null,
            worker_type: 'agy',
            repository: '.',
            acceptance_criteria: [],
            test_commands: [],
            priority: 0,
            max_attempts: 3,
            timeout_minutes: 30,
            dependencies: ['CYCLE-Y'],
            status: 'TODO',
            rowNumber: 2,
            raw: {},
          },
          {
            id: 'CYCLE-Y',
            feature_id: null,
            title: 'Task Y',
            description: null,
            phase: null,
            worker_type: 'agy',
            repository: '.',
            acceptance_criteria: [],
            test_commands: [],
            priority: 0,
            max_attempts: 3,
            timeout_minutes: 30,
            dependencies: ['CYCLE-X'],
            status: 'TODO',
            rowNumber: 3,
            raw: {},
          },
        ],
        features: [],
        config: {
          repository: '.',
          agy_bin: 'agy',
          agy_args: '-p',
          verify_commands: [],
          max_attempts: 3,
          timeout_minutes: 30,
          max_concurrency: 1,
          settings: {},
          raw: {},
        },
        sourceType: 'excel',
      };

      const report = validateWorkbook(invalidWorkbook);
      expect(report.valid).toBe(false);

      const cycleErrors = report.errors.filter(
        (e: ValidationErrorItem) => e.code === VALIDATION_ERROR_CODES.CIRCULAR_DEPENDENCY,
      );
      expect(cycleErrors.length).toBeGreaterThan(0);
      expect(cycleErrors[0]?.sheet).toBe('Tasks');
      expect(cycleErrors[0]?.column).toBe('dependencies');
      expect(cycleErrors[0]?.message).toContain('CYCLE-X -> CYCLE-Y -> CYCLE-X');

      // assertValidWorkbook ném ngoại lệ WorkbookValidationError
      expect(() => assertValidWorkbook(invalidWorkbook)).toThrowError(WorkbookValidationError);
    });

    it('validateRawWorkbook phát hiện chu trình từ raw rows', () => {
      const rawInput = {
        tasks: [
          { rowNumber: 2, data: { id: 'T1', title: 'Task 1', dependencies: 'T2' } },
          { rowNumber: 3, data: { id: 'T2', title: 'Task 2', dependencies: 'T3' } },
          { rowNumber: 4, data: { id: 'T3', title: 'Task 3', dependencies: 'T1' } },
        ],
      };

      const report = validateRawWorkbook(rawInput);
      expect(report.valid).toBe(false);
      const cycleErrors = report.errors.filter(
        (e: ValidationErrorItem) => e.code === VALIDATION_ERROR_CODES.CIRCULAR_DEPENDENCY,
      );
      expect(cycleErrors.length).toBeGreaterThan(0);
      expect(cycleErrors[0]?.message).toContain('T1 -> T2 -> T3 -> T1');
    });
  });

  describe('Nghiệm thu 8: Tích hợp Database — Ngăn chặn chu trình và rollback giao dịch', () => {
    it('TaskDependencyRepository.add từ chối thêm dependency tạo chu trình', () => {
      taskRepo.create({ id: 'TASK-1', title: 'Task 1' });
      taskRepo.create({ id: 'TASK-2', title: 'Task 2' });
      taskRepo.create({ id: 'TASK-3', title: 'Task 3' });

      depRepo.add('TASK-2', 'TASK-1'); // TASK-2 phụ thuộc TASK-1
      depRepo.add('TASK-3', 'TASK-2'); // TASK-3 phụ thuộc TASK-2

      // Cố tình thêm TASK-1 phụ thuộc TASK-3 -> Chu trình: TASK-1 -> TASK-3 -> TASK-2 -> TASK-1
      expect(() => depRepo.add('TASK-1', 'TASK-3')).toThrowError(
        expect.objectContaining({
          code: 'CIRCULAR_DEPENDENCY_ERROR',
        }),
      );

      // Đảm bảo không có bản ghi rác nào bị thêm vào
      expect(depRepo.getByTaskId('TASK-1')).toEqual([]);
    });

    it('TaskDependencyRepository.setForTask từ chối thiết lập dependency tạo chu trình', () => {
      taskRepo.create({ id: 'A1', title: 'A1' });
      taskRepo.create({ id: 'A2', title: 'A2' });

      depRepo.add('A2', 'A1'); // A2 phụ thuộc A1

      // Cố tình cập nhật dependencies của A1 thành ['A2']
      expect(() => depRepo.setForTask('A1', ['A2'])).toThrowError(
        expect.objectContaining({
          code: 'CIRCULAR_DEPENDENCY_ERROR',
        }),
      );

      expect(depRepo.getByTaskId('A1')).toEqual([]);
    });

    it('TaskRepository.createMany từ chối batch có chu trình và rollback toàn bộ transaction', () => {
      expect(() =>
        taskRepo.createMany([
          { id: 'BATCH-C1', title: 'Batch C1', dependencies: ['BATCH-C2'] },
          { id: 'BATCH-C2', title: 'Batch C2', dependencies: ['BATCH-C1'] },
        ]),
      ).toThrowError(
        expect.objectContaining({
          code: 'CIRCULAR_DEPENDENCY_ERROR',
        }),
      );

      // Khẳng định giao dịch bị hủy bỏ (atomic rollback), không có task nào lọt vào DB
      expect(taskRepo.exists('BATCH-C1')).toBe(false);
      expect(taskRepo.exists('BATCH-C2')).toBe(false);
      expect(taskRepo.count()).toBe(0);
    });

    it('TaskRepository.detectCycle và getExecutionOrder hoạt động chuẩn xác với SQLite', () => {
      taskRepo.create({ id: 'DB-1', title: 'DB 1', priority: 10 });
      taskRepo.create({ id: 'DB-2', title: 'DB 2', dependencies: ['DB-1'], priority: 20 });
      taskRepo.create({ id: 'DB-3', title: 'DB 3', dependencies: ['DB-2'], priority: 30 });

      // DB hiện tại không có chu trình
      const cycleRes = taskRepo.detectCycle();
      expect(cycleRes.hasCycle).toBe(false);
      expect(cycleRes.cycle).toBeNull();

      // Lấy thứ tự thực thi hợp lệ
      const executionOrder = taskRepo.getExecutionOrder();
      expect(executionOrder).toEqual(['DB-1', 'DB-2', 'DB-3']);
    });
  });

  describe('Định dạng và chuẩn hóa đường đi chu trình', () => {
    it('formatCyclePath định dạng trực quan', () => {
      expect(formatCyclePath(['A', 'B', 'C', 'A'])).toBe('A -> B -> C -> A');
      expect(formatCyclePath(['X'])).toBe('X');
      expect(formatCyclePath([])).toBe('');
    });

    it('canonicalizeCycle chuẩn hóa về node có mã nhỏ nhất theo bảng chữ cái', () => {
      expect(canonicalizeCycle(['Z', 'A', 'B', 'Z'])).toEqual(['A', 'B', 'Z', 'A']);
      expect(canonicalizeCycle(['M', 'N', 'M'])).toEqual(['M', 'N', 'M']);
    });
  });
});
