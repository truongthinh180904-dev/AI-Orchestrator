import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  AppError,
  resolveRepoQualityConfig,
  RepoQualityConfigInputSchema,
  type RepoQualityConfig,
  type RepoQualityConfigInput,
  type ResolveRepoQualityConfigOptions,
} from '@ai-orchestrator/shared';
import { TaskRepository } from '@ai-orchestrator/db';
import type { RepositoryRegistry } from '../adapters/repository-registry.js';

export interface QualityConfigServiceOptions {
  repositoryRegistry?: RepositoryRegistry;
  db?: Database.Database;
}

export class QualityConfigService {
  private readonly repositoryRegistry?: RepositoryRegistry;
  private readonly db?: Database.Database;
  private readonly taskRepo?: TaskRepository;

  constructor(options: QualityConfigServiceOptions = {}) {
    this.repositoryRegistry = options.repositoryRegistry;
    this.db = options.db;
    if (this.db) {
      this.taskRepo = new TaskRepository(this.db);
    }
  }

  /**
   * Resolves the canonical directory path for a repository ID or path.
   */
  public resolveRepoPath(repoIdOrPath: string): { repoPath: string; repoId?: string } {
    if (!repoIdOrPath || typeof repoIdOrPath !== 'string') {
      throw new AppError('INVALID_INPUT', 'Repository identifier or path cannot be empty', {
        repoIdOrPath,
      });
    }

    // Check if it's registered in RepositoryRegistry
    if (this.repositoryRegistry) {
      const registered = this.repositoryRegistry.get(repoIdOrPath);
      if (registered) {
        return { repoPath: registered.path, repoId: registered.id };
      }
    }

    // Fallback: resolve path directly
    const resolved = path.resolve(repoIdOrPath);
    return { repoPath: resolved };
  }

  /**
   * Reads and resolves the quality verification configuration for a repository.
   */
  public getConfigForRepo(
    repoIdOrPath: string,
    overrides?: RepoQualityConfigInput,
  ): RepoQualityConfig {
    const { repoPath, repoId } = this.resolveRepoPath(repoIdOrPath);

    return resolveRepoQualityConfig({
      repoPath,
      repoId,
      overrides,
    });
  }

  /**
   * Reads and resolves the quality verification configuration tailored for a specific task.
   * Incorporates task.test_commands to override or supplement the test stage.
   */
  public getConfigForTask(taskId: string): RepoQualityConfig {
    if (!this.taskRepo) {
      throw new AppError(
        'DATABASE_NOT_CONFIGURED',
        'Database connection is required to resolve quality config for a task',
        { taskId },
      );
    }

    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new AppError('TASK_NOT_FOUND', `Task with ID '${taskId}' not found`, { taskId });
    }

    const repoPathOrId = task.repository && task.repository.trim().length > 0 ? task.repository : '.';
    const { repoPath, repoId } = this.resolveRepoPath(repoPathOrId);

    return resolveRepoQualityConfig({
      repoPath,
      repoId,
      taskTestCommands: task.test_commands,
    });
  }

  /**
   * Resolves quality config from explicit options.
   */
  public resolveConfig(options: ResolveRepoQualityConfigOptions): RepoQualityConfig {
    let repoPath = options.repoPath;
    let repoId = options.repoId;

    if (options.repoId && !options.repoPath) {
      const resolved = this.resolveRepoPath(options.repoId);
      repoPath = resolved.repoPath;
      repoId = resolved.repoId;
    } else if (options.repoPath) {
      repoPath = path.resolve(options.repoPath);
    }

    return resolveRepoQualityConfig({
      ...options,
      repoPath,
      repoId,
    });
  }

  /**
   * Validates an unknown input against quality config schemas.
   */
  public validateConfig(input: unknown): RepoQualityConfig {
    const parsedInput = RepoQualityConfigInputSchema.parse(input);
    return resolveRepoQualityConfig({
      repoPath: parsedInput.repo_path,
      repoId: parsedInput.repo_id,
      overrides: parsedInput,
    });
  }

  /**
   * Saves quality config to .orchestrator/quality.json in the repository directory.
   */
  public saveRepoQualityConfig(
    repoIdOrPath: string,
    input: RepoQualityConfigInput,
  ): RepoQualityConfig {
    const { repoPath, repoId } = this.resolveRepoPath(repoIdOrPath);

    if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) {
      throw new AppError('PATH_NOT_FOUND', `Repository directory does not exist: ${repoPath}`, {
        repoPath,
      });
    }

    const orchDir = path.join(repoPath, '.orchestrator');
    if (!fs.existsSync(orchDir)) {
      fs.mkdirSync(orchDir, { recursive: true });
    }

    const configFile = path.join(orchDir, 'quality.json');
    fs.writeFileSync(configFile, JSON.stringify(input, null, 2), 'utf-8');

    return resolveRepoQualityConfig({
      repoPath,
      repoId,
      overrides: input,
    });
  }
}
