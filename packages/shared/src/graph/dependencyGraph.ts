import { AppError } from '../errors.js';
import type {
  CycleDetectionAlgorithm,
  CycleDetectionOptions,
  CycleDetectionResult,
  DependencyNodeInput,
  TopologicalSortResult,
} from './types.js';

/**
 * Định dạng mảng chu trình thành chuỗi biểu diễn đường đi trực quan (ví dụ: 'A -> B -> C -> A').
 */
export function formatCyclePath(cycle: string[]): string {
  if (!cycle || cycle.length === 0) {
    return '';
  }
  return cycle.join(' -> ');
}

/**
 * Chuẩn hóa một chu trình [v0, v1, ..., vk, v0] về dạng chuẩn (bắt đầu bằng node có mã nhỏ nhất theo bảng chữ cái).
 * Giúp nhận diện và loại bỏ các chu trình trùng lặp do điểm bắt đầu duyệt khác nhau.
 */
export function canonicalizeCycle(cycle: string[]): string[] {
  if (cycle.length <= 2) {
    return cycle;
  }
  // Bỏ phần tử lặp cuối cùng để lấy chuỗi các node thực tế
  const nodes = cycle.slice(0, cycle.length - 1);
  let minIdx = 0;
  for (let i = 1; i < nodes.length; i++) {
    const nodeI = nodes[i];
    const minNode = nodes[minIdx];
    if (nodeI !== undefined && minNode !== undefined && nodeI < minNode) {
      minIdx = i;
    }
  }

  const rotated: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const item = nodes[(minIdx + i) % nodes.length];
    if (item !== undefined) {
      rotated.push(item);
    }
  }
  const first = rotated[0];
  if (first !== undefined) {
    rotated.push(first);
  }
  return rotated;
}

export class DependencyGraph {
  private readonly nodes = new Set<string>();
  // taskId -> Set các task mà taskId phụ thuộc vào (prerequisites)
  private readonly dependencies = new Map<string, Set<string>>();
  // taskId -> Set các task phụ thuộc vào taskId (dependents)
  private readonly dependents = new Map<string, Set<string>>();
  // taskId -> priority (dùng để sắp xếp tie-break trong topological sort)
  private readonly priorities = new Map<string, number>();

  constructor(tasks?: Iterable<DependencyNodeInput>) {
    if (tasks) {
      this.addTasks(tasks);
    }
  }

  public addNode(id: string, priority = 0): void {
    const trimmed = id.trim();
    if (!trimmed) return;

    this.nodes.add(trimmed);
    if (!this.dependencies.has(trimmed)) {
      this.dependencies.set(trimmed, new Set());
    }
    if (!this.dependents.has(trimmed)) {
      this.dependents.set(trimmed, new Set());
    }
    if (!this.priorities.has(trimmed)) {
      this.priorities.set(trimmed, priority);
    }
  }

  public addDependency(taskId: string, dependsOnId: string): void {
    const tId = taskId.trim();
    const dId = dependsOnId.trim();
    if (!tId || !dId) return;

    this.addNode(tId);
    this.addNode(dId);

    const deps = this.dependencies.get(tId);
    if (deps) {
      deps.add(dId);
    }

    const dependentsSet = this.dependents.get(dId);
    if (dependentsSet) {
      dependentsSet.add(tId);
    }
  }

  public addTasks(tasks: Iterable<DependencyNodeInput>): void {
    for (const task of tasks) {
      const id = task.id ? task.id.trim() : '';
      if (!id) continue;

      this.addNode(id, task.priority ?? 0);
      const deps = task.dependencies ?? [];
      for (const dep of deps) {
        if (dep && typeof dep === 'string') {
          const trimmedDep = dep.trim();
          if (trimmedDep) {
            this.addDependency(id, trimmedDep);
          }
        }
      }
    }
  }

  public hasNode(id: string): boolean {
    return this.nodes.has(id.trim());
  }

  public getNodes(): string[] {
    return Array.from(this.nodes).sort();
  }

  public getDependencies(id: string): string[] {
    const set = this.dependencies.get(id.trim());
    return set ? Array.from(set).sort() : [];
  }

  public getDependents(id: string): string[] {
    const set = this.dependents.get(id.trim());
    return set ? Array.from(set).sort() : [];
  }

  public getPriority(id: string): number {
    return this.priorities.get(id.trim()) ?? 0;
  }

  public setPriority(id: string, priority: number): void {
    this.priorities.set(id.trim(), priority);
  }

  public nodeCount(): number {
    return this.nodes.size;
  }

  public edgeCount(): number {
    let count = 0;
    for (const set of this.dependencies.values()) {
      count += set.size;
    }
    return count;
  }

  /**
   * Phát hiện chu trình bằng thuật toán Depth-First Search (DFS) với 3 trạng thái màu:
   * - 0 (UNVISITED - trắng)
   * - 1 (VISITING - xám / đang trong call stack)
   * - 2 (VISITED - đen / đã duyệt xong nhánh)
   * Khi gặp một node ở trạng thái VISITING (back-edge), chu trình được trích xuất trực tiếp từ path stack.
   */
  public detectCycleDFS(): CycleDetectionResult {
    const nodes = this.getNodes();
    // 0 = UNVISITED, 1 = VISITING, 2 = VISITED
    const state = new Map<string, number>();
    const currentPath: string[] = [];
    const pathIndex = new Map<string, number>();

    for (const node of nodes) {
      state.set(node, 0);
    }

    for (const startNode of nodes) {
      if (state.get(startNode) !== 0) {
        continue;
      }

      const foundCycle = this.dfsVisit(
        startNode,
        state,
        currentPath,
        pathIndex,
      );
      if (foundCycle) {
        return {
          hasCycle: true,
          cycle: foundCycle,
          cyclePathString: formatCyclePath(foundCycle),
          cycleNodes: Array.from(new Set(foundCycle)),
          algorithm: 'dfs',
        };
      }
    }

    return {
      hasCycle: false,
      cycle: null,
      cyclePathString: null,
      algorithm: 'dfs',
    };
  }

  private dfsVisit(
    u: string,
    state: Map<string, number>,
    currentPath: string[],
    pathIndex: Map<string, number>,
  ): string[] | null {
    state.set(u, 1);
    currentPath.push(u);
    pathIndex.set(u, currentPath.length - 1);

    const neighbors = this.getDependencies(u);
    for (const v of neighbors) {
      const vState = state.get(v) ?? 0;
      if (vState === 1) {
        // Back-edge phát hiện chu trình!
        const startIndex = pathIndex.get(v);
        if (startIndex !== undefined) {
          const cycle = currentPath.slice(startIndex);
          cycle.push(v);
          return cycle;
        }
      } else if (vState === 0) {
        const cycle = this.dfsVisit(v, state, currentPath, pathIndex);
        if (cycle) {
          return cycle;
        }
      }
    }

    state.set(u, 2);
    currentPath.pop();
    pathIndex.delete(u);
    return null;
  }

  /**
   * Thu thập tất cả các chu trình đơn (simple cycles) bằng thuật toán DFS.
   */
  public findAllCyclesDFS(): string[][] {
    const nodes = this.getNodes();
    const allCycles: string[][] = [];
    const seenSignatures = new Set<string>();

    const state = new Map<string, number>();
    for (const node of nodes) {
      state.set(node, 0);
    }

    const currentPath: string[] = [];
    const pathIndex = new Map<string, number>();

    const dfsCollect = (u: string): void => {
      state.set(u, 1);
      currentPath.push(u);
      pathIndex.set(u, currentPath.length - 1);

      const neighbors = this.getDependencies(u);
      for (const v of neighbors) {
        const vState = state.get(v) ?? 0;
        if (vState === 1) {
          const startIndex = pathIndex.get(v);
          if (startIndex !== undefined) {
            const cycle = currentPath.slice(startIndex);
            cycle.push(v);
            const canonical = canonicalizeCycle(cycle);
            const signature = canonical.join('->');
            if (!seenSignatures.has(signature)) {
              seenSignatures.add(signature);
              allCycles.push(cycle);
            }
          }
        } else if (vState === 0) {
          dfsCollect(v);
        }
      }

      state.set(u, 2);
      currentPath.pop();
      pathIndex.delete(u);
    };

    for (const node of nodes) {
      if (state.get(node) === 0) {
        dfsCollect(node);
      }
    }

    return allCycles;
  }

  /**
   * Phát hiện chu trình bằng thuật toán Kahn (Topological Sort dựa trên In-Degree):
   * Trong đồ thị thực thi, task u chỉ có thể chạy khi tất cả các task v mà u phụ thuộc vào đã chạy xong.
   * In-degree của u = số lượng dependencies của u chưa được giải quyết.
   * Các task có in-degree = 0 không phụ thuộc vào ai và có thể thực thi ngay.
   * Nếu sau khi duyệt hết queue mà số lượng node đã xếp thứ tự < tổng số node,
   * thì những node còn lại có in-degree > 0 tạo thành hoặc bị kẹt trong chu trình.
   * Thuật toán truy vết từ tập node này để tái tạo chính xác đường đi chu trình.
   */
  public detectCycleKahn(): CycleDetectionResult {
    const nodes = this.getNodes();
    const inDegree = new Map<string, number>();
    const dependentsMap = new Map<string, string[]>();

    for (const node of nodes) {
      // In-degree ở đây là số lượng dependencies của node này (prerequisites)
      const deps = this.getDependencies(node);
      inDegree.set(node, deps.length);
      dependentsMap.set(node, this.getDependents(node));
    }

    // Khởi tạo hàng đợi chứa các node có in-degree = 0 (sẵn sàng chạy)
    // Sắp xếp ưu tiên độ ưu tiên (descending), sau đó theo ID (ascending) để thứ tự hoàn toàn xác định
    const queue: string[] = [];
    for (const node of nodes) {
      if (inDegree.get(node) === 0) {
        queue.push(node);
      }
    }

    const sortQueue = (): void => {
      queue.sort((a, b) => {
        const prioA = this.getPriority(a);
        const prioB = this.getPriority(b);
        if (prioA !== prioB) return prioB - prioA;
        return a.localeCompare(b);
      });
    };

    sortQueue();

    const sortedOrder: string[] = [];

    while (queue.length > 0) {
      const u = queue.shift();
      if (u === undefined) break;

      sortedOrder.push(u);

      const dependents = dependentsMap.get(u) ?? [];
      for (const v of dependents) {
        const currentDeg = inDegree.get(v) ?? 1;
        const newDeg = currentDeg - 1;
        inDegree.set(v, newDeg);
        if (newDeg === 0) {
          queue.push(v);
          sortQueue();
        }
      }
    }

    if (sortedOrder.length === nodes.length) {
      // Đồ thị là DAG hoàn toàn hợp lệ, không có chu trình!
      return {
        hasCycle: false,
        cycle: null,
        cyclePathString: null,
        algorithm: 'kahn',
      };
    }

    // Có chu trình!
    // Các node có in-degree > 0 sau khi Kahn kết thúc chính là các node bị vướng chu trình
    const cycleNodesSet = new Set<string>();
    for (const [node, deg] of inDegree.entries()) {
      if (deg > 0) {
        cycleNodesSet.add(node);
      }
    }

    // Tái tạo đường đi chu trình từ các node này
    const cyclePath = this.reconstructCycleFromNodes(cycleNodesSet);

    return {
      hasCycle: true,
      cycle: cyclePath,
      cyclePathString: cyclePath ? formatCyclePath(cyclePath) : null,
      cycleNodes: Array.from(cycleNodesSet).sort(),
      algorithm: 'kahn',
    };
  }

  /**
   * Truy vết và tái tạo chu trình từ tập các node có chu trình:
   * Vì mỗi node trong cycleNodesSet đều có ít nhất 1 dependency thuộc cycleNodesSet,
   * việc đi theo cạnh dependency chắc chắn sẽ quay lại một node đã đi qua (nguyên lý Dirichlet),
   * tạo thành chu trình khép kín [v, ..., v].
   */
  private reconstructCycleFromNodes(cycleNodes: Set<string>): string[] | null {
    if (cycleNodes.size === 0) {
      return null;
    }

    // Chọn node bắt đầu nhỏ nhất theo bảng chữ cái để kết quả xác định (deterministic)
    const sortedCandidates = Array.from(cycleNodes).sort();
    const start = sortedCandidates[0];
    if (!start) return null;

    const visitedOrder: string[] = [];
    const visitedIndex = new Map<string, number>();

    let current: string | undefined = start;
    while (current !== undefined) {
      if (visitedIndex.has(current)) {
        const startIndex = visitedIndex.get(current)!;
        const cycle = visitedOrder.slice(startIndex);
        cycle.push(current);
        return cycle;
      }

      visitedIndex.set(current, visitedOrder.length);
      visitedOrder.push(current);

      // Tìm dependency tiếp theo nằm trong cycleNodes
      const nextDeps: string[] = this.getDependencies(current).filter((d) => cycleNodes.has(d));
      nextDeps.sort(); // Đảm bảo tính xác định
      current = nextDeps[0];
    }

    return null;
  }

  /**
   * Phương thức chung phát hiện chu trình, hỗ trợ chọn thuật toán 'dfs' hoặc 'kahn'.
   * Mặc định sử dụng 'dfs' nếu không chỉ định.
   */
  public detectCycle(options: CycleDetectionOptions = {}): CycleDetectionResult {
    const algorithm = options.algorithm ?? 'dfs';
    if (algorithm === 'kahn') {
      const result = this.detectCycleKahn();
      if (options.findAll && result.hasCycle) {
        result.allCycles = this.findAllCyclesDFS();
      }
      return result;
    }

    const result = this.detectCycleDFS();
    if (options.findAll && result.hasCycle) {
      result.allCycles = this.findAllCyclesDFS();
    }
    return result;
  }

  public hasCycle(): boolean {
    return this.detectCycleDFS().hasCycle;
  }

  public findCycle(algorithm: CycleDetectionAlgorithm = 'dfs'): string[] | null {
    const res = this.detectCycle({ algorithm });
    return res.cycle;
  }

  /**
   * Trả về kết quả Topological Sort dưới dạng TopologicalSortResult:
   * - Nếu không có chu trình: `success: true, order: string[]` (thứ tự thực thi, prerequisite chạy trước).
   * - Nếu có chu trình: `success: false, cycle: string[], cyclePathString: string`.
   */
  public getTopologicalOrder(): TopologicalSortResult {
    const nodes = this.getNodes();
    const inDegree = new Map<string, number>();
    const dependentsMap = new Map<string, string[]>();

    for (const node of nodes) {
      const deps = this.getDependencies(node);
      inDegree.set(node, deps.length);
      dependentsMap.set(node, this.getDependents(node));
    }

    const queue: string[] = [];
    for (const node of nodes) {
      if (inDegree.get(node) === 0) {
        queue.push(node);
      }
    }

    const sortQueue = (): void => {
      queue.sort((a, b) => {
        const prioA = this.getPriority(a);
        const prioB = this.getPriority(b);
        if (prioA !== prioB) return prioB - prioA;
        return a.localeCompare(b);
      });
    };

    sortQueue();

    const order: string[] = [];

    while (queue.length > 0) {
      const u = queue.shift();
      if (u === undefined) break;

      order.push(u);

      const dependents = dependentsMap.get(u) ?? [];
      for (const v of dependents) {
        const currentDeg = inDegree.get(v) ?? 1;
        const newDeg = currentDeg - 1;
        inDegree.set(v, newDeg);
        if (newDeg === 0) {
          queue.push(v);
          sortQueue();
        }
      }
    }

    if (order.length === nodes.length) {
      return {
        success: true,
        order,
        hasCycle: false,
        cycle: null,
        cyclePathString: null,
      };
    }

    const cycleNodesSet = new Set<string>();
    for (const [node, deg] of inDegree.entries()) {
      if (deg > 0) {
        cycleNodesSet.add(node);
      }
    }
    const cycle = this.reconstructCycleFromNodes(cycleNodesSet);
    const cyclePathString = cycle ? formatCyclePath(cycle) : null;

    return {
      success: false,
      order: [],
      hasCycle: true,
      cycle,
      cyclePathString,
    };
  }

  /**
   * Sắp xếp tô-pô các node trong đồ thị (thứ tự thực thi).
   * Ném ra `AppError('CIRCULAR_DEPENDENCY_ERROR')` nếu phát hiện chu trình.
   */
  public topologicalSort(): string[] {
    const result = this.getTopologicalOrder();
    if (!result.success) {
      throw new AppError(
        'CIRCULAR_DEPENDENCY_ERROR',
        `Phát hiện chu trình phụ thuộc trong đồ thị: ${result.cyclePathString}`,
        {
          cycle: result.cycle,
          cyclePathString: result.cyclePathString,
        },
      );
    }
    return result.order;
  }
}

/**
 * Hàm tiện ích: Xây dựng DependencyGraph từ danh sách task đầu vào và chạy phát hiện chu trình (DFS).
 */
export function detectCycleDFS(
  tasksOrGraph: Iterable<DependencyNodeInput> | DependencyGraph,
): CycleDetectionResult {
  const graph =
    tasksOrGraph instanceof DependencyGraph
      ? tasksOrGraph
      : new DependencyGraph(tasksOrGraph);
  return graph.detectCycleDFS();
}

/**
 * Hàm tiện ích: Xây dựng DependencyGraph từ danh sách task đầu vào và chạy phát hiện chu trình bằng thuật toán Kahn.
 */
export function detectCycleKahn(
  tasksOrGraph: Iterable<DependencyNodeInput> | DependencyGraph,
): CycleDetectionResult {
  const graph =
    tasksOrGraph instanceof DependencyGraph
      ? tasksOrGraph
      : new DependencyGraph(tasksOrGraph);
  return graph.detectCycleKahn();
}

/**
 * Hàm phát hiện chu trình đa năng hỗ trợ cả DFS và Kahn.
 */
export function detectCycle(
  tasksOrGraph: Iterable<DependencyNodeInput> | DependencyGraph,
  options: CycleDetectionOptions = {},
): CycleDetectionResult {
  const graph =
    tasksOrGraph instanceof DependencyGraph
      ? tasksOrGraph
      : new DependencyGraph(tasksOrGraph);
  return graph.detectCycle(options);
}

/**
 * Hàm sắp xếp thứ tự thực thi hợp lệ (topological sort) bằng thuật toán Kahn.
 */
export function topologicalSort(
  tasksOrGraph: Iterable<DependencyNodeInput> | DependencyGraph,
): string[] {
  const graph =
    tasksOrGraph instanceof DependencyGraph
      ? tasksOrGraph
      : new DependencyGraph(tasksOrGraph);
  return graph.topologicalSort();
}

/**
 * Hàm tìm đường đi chu trình đầu tiên (nếu có), trả về mảng các ID node (ví dụ: ['A', 'B', 'C', 'A']).
 */
export function findCycle(
  tasksOrGraph: Iterable<DependencyNodeInput> | DependencyGraph,
  algorithm: CycleDetectionAlgorithm = 'dfs',
): string[] | null {
  const graph =
    tasksOrGraph instanceof DependencyGraph
      ? tasksOrGraph
      : new DependencyGraph(tasksOrGraph);
  return graph.findCycle(algorithm);
}
