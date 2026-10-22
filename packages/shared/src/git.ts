import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { AppError } from './errors.js';

export interface GitFileStatus {
  path: string;
  indexStatus: string;
  workTreeStatus: string;
  raw: string;
  origPath?: string;
}

export interface RepoStatusResult {
  isClean: boolean;
  files: GitFileStatus[];
  raw: string;
}

export interface CheckRepoCleanOptions {
  /**
   * Optional whitelist of relative file paths that are allowed to be modified.
   * If any uncommitted change is outside this list, the repository is considered dirty.
   */
  allowedFiles?: string[];
  /**
   * If true, untracked files (`??`) are ignored when checking cleanliness.
   * Defaults to false (untracked files are treated as dirty).
   */
  ignoreUntracked?: boolean;
}

/**
 * Parses raw output from `git status --porcelain`.
 */
export function parseGitPorcelain(rawOutput: string): GitFileStatus[] {
  const lines = rawOutput.split(/\r?\n/);
  const files: GitFileStatus[] = [];

  for (const rawLine of lines) {
    if (!rawLine || rawLine.length < 3) continue;

    const indexStatus = rawLine.charAt(0);
    const workTreeStatus = rawLine.charAt(1);
    let filePathPart = rawLine.slice(3).trim();

    let origPath: string | undefined;
    if (filePathPart.includes(' -> ')) {
      const parts = filePathPart.split(' -> ');
      origPath = parts[0]?.trim();
      let targetPart = parts[1]?.trim() ?? filePathPart;
      if (origPath?.startsWith('"') && origPath.endsWith('"')) {
        origPath = origPath.slice(1, -1);
      }
      if (targetPart.startsWith('"') && targetPart.endsWith('"')) {
        targetPart = targetPart.slice(1, -1);
      }
      filePathPart = targetPart;
    } else if (filePathPart.startsWith('"') && filePathPart.endsWith('"')) {
      filePathPart = filePathPart.slice(1, -1);
    }

    files.push({
      indexStatus,
      workTreeStatus,
      path: filePathPart,
      origPath,
      raw: rawLine,
    });
  }

  return files;
}

function runGitCommand(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(
        new AppError(
          'GIT_SPAWN_ERROR',
          `Failed to start git process: ${err instanceof Error ? err.message : String(err)}`,
          {
            cwd,
            args,
          },
        ),
      );
      return;
    }

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(
          new AppError('GIT_NOT_FOUND', 'Git executable not found in system PATH', {
            cwd,
            args,
            originalError: err.message,
          }),
        );
      } else {
        reject(
          new AppError('GIT_SPAWN_ERROR', `Git process error: ${err.message}`, {
            cwd,
            args,
            originalError: err.message,
          }),
        );
      }
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
}

/**
 * Retrieves repository status details without throwing an error if the working tree is dirty.
 * Throws AppError if the directory does not exist or is not a git repository.
 */
export async function getRepoStatus(
  repoPath: string,
  options?: CheckRepoCleanOptions,
): Promise<RepoStatusResult> {
  if (!fs.existsSync(repoPath)) {
    throw new AppError('PATH_NOT_FOUND', `Repository path does not exist: ${repoPath}`, {
      repoPath,
    });
  }

  const stat = fs.statSync(repoPath);
  if (!stat.isDirectory()) {
    throw new AppError('NOT_A_DIRECTORY', `Repository path is not a directory: ${repoPath}`, {
      repoPath,
    });
  }

  const args = ['status', '--porcelain'];
  if (options?.ignoreUntracked) {
    args.push('-uno');
  }

  const { stdout, stderr, exitCode } = await runGitCommand(args, repoPath);

  if (exitCode !== 0) {
    if (
      stderr.toLowerCase().includes('not a git repository') ||
      stderr.toLowerCase().includes('not inside a git repository')
    ) {
      throw new AppError('NOT_A_GIT_REPO', `Directory is not a git repository: ${repoPath}`, {
        repoPath,
        stderr,
        exitCode,
      });
    }
    throw new AppError(
      'GIT_COMMAND_FAILED',
      `git status --porcelain failed: ${stderr.trim() || `Exit code ${exitCode}`}`,
      {
        repoPath,
        exitCode,
        stderr,
      },
    );
  }

  const allFiles = parseGitPorcelain(stdout);
  let dirtyFiles = allFiles;

  if (options?.allowedFiles && options.allowedFiles.length > 0) {
    const allowedSet = new Set(options.allowedFiles);
    dirtyFiles = allFiles.filter((f) => !allowedSet.has(f.path));
  }

  return {
    isClean: dirtyFiles.length === 0,
    files: dirtyFiles,
    raw: stdout,
  };
}

/**
 * Returns true if the repository working tree is clean (or has only allowed changes).
 */
export async function isRepoClean(
  repoPath: string,
  options?: CheckRepoCleanOptions,
): Promise<boolean> {
  const status = await getRepoStatus(repoPath, options);
  return status.isClean;
}

/**
 * Checks whether the git repository at `repoPath` has a clean working tree.
 * Uses `git status --porcelain` via child_process.spawn.
 *
 * If the repository is dirty, throws AppError with code 'REPO_DIRTY'.
 *
 * @param repoPath Directory path of the git repository.
 * @param options Optional configuration (allowedFiles, ignoreUntracked).
 * @returns RepoStatusResult if clean.
 * @throws AppError ('REPO_DIRTY', 'PATH_NOT_FOUND', 'NOT_A_GIT_REPO', etc.)
 */
export async function checkRepoClean(
  repoPath: string,
  options?: CheckRepoCleanOptions,
): Promise<RepoStatusResult> {
  const status = await getRepoStatus(repoPath, options);

  if (!status.isClean) {
    const fileSummary = status.files
      .map((f) => `${f.indexStatus}${f.workTreeStatus} ${f.path}`)
      .join('\n  ');

    throw new AppError(
      'REPO_DIRTY',
      `Repository at "${repoPath}" has uncommitted changes (${status.files.length} file(s)):\n  ${fileSummary}`,
      {
        repoPath,
        dirtyCount: status.files.length,
        dirtyFiles: status.files,
        raw: status.raw,
      },
    );
  }

  return status;
}
