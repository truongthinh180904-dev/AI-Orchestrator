import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, type RegisteredRepository } from '@ai-orchestrator/shared';

export interface ValidateCwdResult {
  valid: boolean;
  canonicalPath?: string;
  repo?: RegisteredRepository;
  isWorktree?: boolean;
  reason?: string;
}

export interface RegisterRepoOptions {
  id?: string;
  name?: string;
  isDefault?: boolean;
  requireGit?: boolean;
}

/**
 * RepositoryRegistry manages authorized repository roots and isolated worktree directories,
 * providing strict boundaries to ensure that any execution working directory (cwd)
 * belongs to a registered repository and cannot perform path traversal or symlink escapes.
 */
export class RepositoryRegistry {
  private readonly _repos = new Map<string, RegisteredRepository>(); // keyed by canonical path
  private readonly _idToPath = new Map<string, string>(); // id -> canonical path
  private readonly _worktrees = new Map<string, string>(); // canonical worktree path -> canonical repo path
  private _defaultRepoPath: string | null = null;

  constructor(initialRepos: string[] = []) {
    for (const r of initialRepos) {
      this.register(r);
    }
  }

  /**
   * Registers a repository path in the registry.
   */
  register(repoPath: string, options: RegisterRepoOptions = {}): RegisteredRepository {
    if (!repoPath || typeof repoPath !== 'string' || repoPath.trim().length === 0) {
      throw new AppError('INVALID_INPUT', 'Repository path cannot be empty', { repoPath });
    }

    const resolved = path.resolve(repoPath);

    if (!fs.existsSync(resolved)) {
      throw new AppError('PATH_NOT_FOUND', `Repository path does not exist: ${repoPath}`, {
        repoPath,
        resolvedPath: resolved,
      });
    }

    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new AppError('NOT_A_DIRECTORY', `Repository path is not a directory: ${repoPath}`, {
        repoPath,
        resolvedPath: resolved,
      });
    }

    const canonicalPath = fs.realpathSync(resolved);

    if (options.requireGit) {
      const gitDir = path.join(canonicalPath, '.git');
      if (!fs.existsSync(gitDir)) {
        throw new AppError('NOT_A_GIT_REPO', `Directory is not a git repository: ${repoPath}`, {
          repoPath,
          canonicalPath,
        });
      }
    }

    // Check if already registered
    const existing = this._repos.get(canonicalPath);
    if (existing) {
      if (options.isDefault) {
        this._setDefault(canonicalPath);
      }
      return existing;
    }

    const id = options.id ?? `repo-${randomUUID().slice(0, 8)}`;
    const name = options.name ?? path.basename(canonicalPath);
    const repo: RegisteredRepository = {
      id,
      path: canonicalPath,
      name,
      isDefault: Boolean(options.isDefault) || this._repos.size === 0,
      registeredAt: new Date().toISOString(),
    };

    this._repos.set(canonicalPath, repo);
    this._idToPath.set(id, canonicalPath);

    if (repo.isDefault) {
      this._setDefault(canonicalPath);
    }

    return repo;
  }

  private _setDefault(canonicalPath: string): void {
    this._defaultRepoPath = canonicalPath;
    for (const [p, r] of this._repos.entries()) {
      r.isDefault = p === canonicalPath;
    }
  }

  /**
   * Unregisters a repository by ID or path.
   */
  unregister(idOrPath: string): boolean {
    let canonicalPath: string | undefined;

    if (this._idToPath.has(idOrPath)) {
      canonicalPath = this._idToPath.get(idOrPath);
    } else {
      const resolved = path.resolve(idOrPath);
      if (fs.existsSync(resolved)) {
        canonicalPath = fs.realpathSync(resolved);
      } else {
        canonicalPath = resolved;
      }
    }

    if (!canonicalPath || !this._repos.has(canonicalPath)) {
      return false;
    }

    const repo = this._repos.get(canonicalPath)!;
    this._idToPath.delete(repo.id);
    this._repos.delete(canonicalPath);

    // Clean up associated worktrees
    for (const [wtPath, parentPath] of this._worktrees.entries()) {
      if (parentPath === canonicalPath) {
        this._worktrees.delete(wtPath);
      }
    }

    if (this._defaultRepoPath === canonicalPath) {
      this._defaultRepoPath = null;
      const nextRepo = this._repos.values().next().value;
      if (nextRepo) {
        this._setDefault(nextRepo.path);
      }
    }

    return true;
  }

  /**
   * Retrieves a registered repository by ID or path.
   */
  get(idOrPath: string): RegisteredRepository | undefined {
    if (this._idToPath.has(idOrPath)) {
      const p = this._idToPath.get(idOrPath)!;
      return this._repos.get(p);
    }

    try {
      const resolved = path.resolve(idOrPath);
      if (fs.existsSync(resolved)) {
        const canonical = fs.realpathSync(resolved);
        return this._repos.get(canonical);
      }
    } catch {
      // Ignored
    }

    return undefined;
  }

  /**
   * Gets the default registered repository.
   */
  getDefault(): RegisteredRepository | undefined {
    if (!this._defaultRepoPath) return undefined;
    return this._repos.get(this._defaultRepoPath);
  }

  /**
   * Lists all registered repositories.
   */
  list(): RegisteredRepository[] {
    return Array.from(this._repos.values());
  }

  /**
   * Clears all registered repositories and worktrees.
   */
  clear(): void {
    this._repos.clear();
    this._idToPath.clear();
    this._worktrees.clear();
    this._defaultRepoPath = null;
  }

  /**
   * Registers an isolated worktree path as an authorized execution working directory
   * linked to a registered repository.
   */
  registerWorktree(worktreePath: string, parentRepoIdOrPath: string): void {
    const repo = this.get(parentRepoIdOrPath);
    if (!repo) {
      throw new AppError(
        'UNREGISTERED_REPOSITORY',
        `Parent repository not registered: ${parentRepoIdOrPath}`,
        { parentRepoIdOrPath, worktreePath },
      );
    }

    const resolved = path.resolve(worktreePath);
    const canonicalWorktree = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
    this._worktrees.set(canonicalWorktree, repo.path);
  }

  /**
   * Unregisters an isolated worktree.
   */
  unregisterWorktree(worktreePath: string): boolean {
    const resolved = path.resolve(worktreePath);
    const canonicalWorktree = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
    return this._worktrees.delete(canonicalWorktree);
  }

  /**
   * Determines if targetPath is strictly within or equal to rootPath (accounting for realpaths).
   */
  isPathWithin(targetPath: string, rootPath: string): boolean {
    const rel = path.relative(rootPath, targetPath);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  /**
   * Validates whether a proposed cwd belongs to any registered repository or authorized worktree.
   */
  validateCwd(cwd: string): ValidateCwdResult {
    if (!cwd || typeof cwd !== 'string' || cwd.trim().length === 0) {
      return {
        valid: false,
        reason: 'Working directory path cannot be empty',
      };
    }

    const resolved = path.resolve(cwd);

    if (!fs.existsSync(resolved)) {
      return {
        valid: false,
        reason: `Working directory does not exist: ${cwd}`,
      };
    }

    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return {
          valid: false,
          reason: `Working directory path is not a directory: ${cwd}`,
        };
      }
    } catch (err) {
      return {
        valid: false,
        reason: `Failed to inspect working directory: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let canonicalCwd: string;
    try {
      canonicalCwd = fs.realpathSync(resolved);
    } catch {
      return {
        valid: false,
        reason: `Failed to resolve canonical path for: ${cwd}`,
      };
    }

    // 1. Check if it matches an authorized worktree directly or is inside one
    for (const [wtPath, repoPath] of this._worktrees.entries()) {
      if (this.isPathWithin(canonicalCwd, wtPath)) {
        const repo = this._repos.get(repoPath);
        return {
          valid: true,
          canonicalPath: canonicalCwd,
          repo,
          isWorktree: true,
        };
      }
    }

    // 2. Check if it is inside any registered repository root
    for (const repo of this._repos.values()) {
      if (this.isPathWithin(canonicalCwd, repo.path)) {
        return {
          valid: true,
          canonicalPath: canonicalCwd,
          repo,
          isWorktree: false,
        };
      }
    }

    return {
      valid: false,
      reason: `Working directory "${cwd}" does not belong to any registered repository or authorized worktree`,
    };
  }

  /**
   * Asserts that cwd is valid and within registered repositories.
   * Throws AppError with appropriate code and context if invalid.
   * Returns canonical path on success.
   */
  assertCwdValid(cwd: string): string {
    const result = this.validateCwd(cwd);
    if (!result.valid) {
      const resolved = path.resolve(cwd);
      let errorCode = 'UNREGISTERED_REPOSITORY';

      if (!fs.existsSync(resolved)) {
        errorCode = 'INVALID_WORKING_DIRECTORY';
      } else {
        try {
          if (!fs.statSync(resolved).isDirectory()) {
            errorCode = 'INVALID_WORKING_DIRECTORY';
          }
        } catch {
          errorCode = 'INVALID_WORKING_DIRECTORY';
        }
      }

      throw new AppError(errorCode, result.reason ?? `Cwd sai bị từ chối: "${cwd}"`, {
        cwd,
        resolvedPath: resolved,
        registeredRepos: this.list().map((r) => ({ id: r.id, path: r.path })),
      });
    }

    return result.canonicalPath!;
  }
}

export function createRepositoryRegistry(initialRepos: string[] = []): RepositoryRegistry {
  return new RepositoryRegistry(initialRepos);
}

export const defaultRepositoryRegistry = new RepositoryRegistry();
