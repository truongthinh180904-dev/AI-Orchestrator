import path from 'node:path';
import {
  AppError,
  checkRepoClean,
  gitWorktreeAdd,
  gitWorktreeRemove,
  gitWorktreeList,
  gitWorktreePrune,
  type WorktreeInfo,
} from '@ai-orchestrator/shared';
import { RepositoryRegistry, defaultRepositoryRegistry } from './repository-registry.js';

export interface IsolatedWorktree {
  readonly taskId: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly repoPath: string;
  readonly createdAt: Date;

  remove(options?: { force?: boolean }): Promise<void>;
}

export interface CreateIsolatedWorktreeOptions {
  repoPath: string;
  taskId: string;
  slug?: string;
  branchName?: string;
  worktreeDir?: string;
  baseCommitOrBranch?: string;
  requireClean?: boolean;
  force?: boolean;
  detach?: boolean;
}

export interface WorktreeManagerOptions {
  repositoryRegistry?: RepositoryRegistry;
}

export class WorktreeManager {
  private readonly _registry: RepositoryRegistry;

  constructor(options: WorktreeManagerOptions = {}) {
    this._registry = options.repositoryRegistry ?? defaultRepositoryRegistry;
  }

  get registry(): RepositoryRegistry {
    return this._registry;
  }

  /**
   * Creates an isolated worktree for a task, verifying that repoPath is a registered repository.
   * Registers the created worktree in the repository registry as an authorized cwd.
   */
  async createIsolatedWorktree(options: CreateIsolatedWorktreeOptions): Promise<IsolatedWorktree> {
    const {
      repoPath,
      taskId,
      slug,
      baseCommitOrBranch,
      requireClean = false,
      force = false,
      detach = false,
    } = options;

    if (!taskId || taskId.trim().length === 0) {
      throw new AppError('INVALID_INPUT', 'Task ID cannot be empty when creating worktree', {
        taskId,
      });
    }

    // 1. Verify parent repository is registered
    const repo = this._registry.get(repoPath);
    if (!repo) {
      throw new AppError(
        'UNREGISTERED_REPOSITORY',
        `Cannot create worktree: repository "${repoPath}" is not registered`,
        {
          repoPath,
          registeredRepos: this._registry.list().map((r) => ({ id: r.id, path: r.path })),
        },
      );
    }

    // 2. Optionally verify parent repo is clean
    if (requireClean) {
      await checkRepoClean(repo.path);
    }

    // 3. Determine worktree path
    let worktreePath: string;
    if (options.worktreeDir) {
      worktreePath = path.resolve(options.worktreeDir);
    } else {
      // Default to sibling directory ../wt-<taskId> or subfolder
      const parentDir = path.dirname(repo.path);
      worktreePath = path.resolve(parentDir, `wt-${taskId}`);
    }

    // 4. Determine branch name: agy/<task-id>[-<slug>]
    const branchName =
      options.branchName ??
      `agy/${taskId}${slug ? `-${slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}` : ''}`;

    // 5. Execute git worktree add
    await gitWorktreeAdd(repo.path, {
      worktreePath,
      branch: branchName,
      commitOrBranch: baseCommitOrBranch,
      force,
      detach,
    });

    // 6. Register worktree in RepositoryRegistry
    this._registry.registerWorktree(worktreePath, repo.path);

    const createdAt = new Date();

    const instance: IsolatedWorktree = {
      taskId,
      worktreePath,
      branch: branchName,
      repoPath: repo.path,
      createdAt,
      remove: async (opts) => {
        await this.removeIsolatedWorktree(repo.path, worktreePath, opts);
      },
    };

    return instance;
  }

  /**
   * Removes an isolated worktree and unregisters it from the repository registry.
   */
  async removeIsolatedWorktree(
    repoPath: string,
    worktreePath: string,
    options?: { force?: boolean },
  ): Promise<void> {
    const resolvedPath = path.resolve(worktreePath);

    try {
      await gitWorktreeRemove(repoPath, resolvedPath, options);
    } finally {
      this._registry.unregisterWorktree(resolvedPath);
    }
  }

  /**
   * Lists all git worktrees for a registered repository.
   */
  async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    const repo = this._registry.get(repoPath);
    const targetRepoPath = repo ? repo.path : path.resolve(repoPath);
    return gitWorktreeList(targetRepoPath);
  }

  /**
   * Prunes disconnected or stale worktrees.
   */
  async pruneWorktrees(repoPath: string): Promise<void> {
    const repo = this._registry.get(repoPath);
    const targetRepoPath = repo ? repo.path : path.resolve(repoPath);
    await gitWorktreePrune(targetRepoPath);
  }
}

export function createWorktreeManager(options?: WorktreeManagerOptions): WorktreeManager {
  return new WorktreeManager(options);
}

export const defaultWorktreeManager = new WorktreeManager();
