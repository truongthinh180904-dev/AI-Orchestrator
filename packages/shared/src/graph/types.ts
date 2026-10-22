export type CycleDetectionAlgorithm = 'dfs' | 'kahn';

export interface CycleDetectionResult {
  hasCycle: boolean;
  cycle: string[] | null;
  cyclePathString: string | null;
  allCycles?: string[][];
  cycleNodes?: string[];
  algorithm: CycleDetectionAlgorithm;
}

export interface TopologicalSortResult {
  success: boolean;
  order: string[];
  hasCycle: boolean;
  cycle: string[] | null;
  cyclePathString: string | null;
}

export interface DependencyNodeInput {
  id: string;
  dependencies?: string[] | null;
  rowNumber?: number;
  priority?: number;
  [key: string]: unknown;
}

export interface CycleDetectionOptions {
  algorithm?: CycleDetectionAlgorithm;
  findAll?: boolean;
  existingTaskIds?: Iterable<string>;
  existingDependencies?: Iterable<{ taskId: string; dependsOnId: string }>;
  ignoreExternal?: boolean;
}
