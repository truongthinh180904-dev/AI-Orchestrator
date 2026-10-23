import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './errors.js';
import type { WorktreeInfo } from './models/workspace.js';
import {
  type FileDiffDetail,
  parseUnifiedDiff,
  normalizeScopePath,
} from './models/quality-scope.js';

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

export function runGitCommand(
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

/**
 * Parses raw output from `git worktree list --porcelain`.
 */
export function parseGitWorktreeList(rawOutput: string): WorktreeInfo[] {
  const lines = rawOutput.split(/\r?\n/);
  const worktrees: WorktreeInfo[] = [];

  let current: Partial<WorktreeInfo> | null = null;

  const flushCurrent = () => {
    if (current && current.path && current.head) {
      worktrees.push({
        path: current.path,
        head: current.head,
        branch: current.branch ?? null,
        isBare: current.isBare ?? false,
        isDetached: current.isDetached ?? false,
        isLocked: current.isLocked ?? false,
        lockReason: current.lockReason ?? null,
        prunable: current.prunable ?? null,
      });
    }
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushCurrent();
      continue;
    }

    if (trimmed.startsWith('worktree ')) {
      flushCurrent();
      current = {
        path: trimmed.slice('worktree '.length).trim(),
        isBare: false,
        isDetached: false,
        isLocked: false,
      };
    } else if (current) {
      if (trimmed.startsWith('HEAD ')) {
        current.head = trimmed.slice('HEAD '.length).trim();
      } else if (trimmed.startsWith('branch ')) {
        const fullBranch = trimmed.slice('branch '.length).trim();
        const branchName = fullBranch.startsWith('refs/heads/')
          ? fullBranch.slice('refs/heads/'.length)
          : fullBranch;
        current.branch = branchName;
      } else if (trimmed === 'bare') {
        current.isBare = true;
      } else if (trimmed === 'detached') {
        current.isDetached = true;
      } else if (trimmed.startsWith('locked')) {
        current.isLocked = true;
        const reason = trimmed.slice('locked'.length).trim();
        current.lockReason = reason.length > 0 ? reason : null;
      } else if (trimmed.startsWith('prunable')) {
        const reason = trimmed.slice('prunable'.length).trim();
        current.prunable = reason.length > 0 ? reason : 'prunable';
      }
    }
  }

  flushCurrent();
  return worktrees;
}

/**
 * Retrieves the list of worktrees for a repository using `git worktree list --porcelain`.
 */
export async function gitWorktreeList(repoPath: string): Promise<WorktreeInfo[]> {
  const { stdout, stderr, exitCode } = await runGitCommand(
    ['worktree', 'list', '--porcelain'],
    repoPath,
  );

  if (exitCode !== 0) {
    throw new AppError(
      'GIT_WORKTREE_ERROR',
      `git worktree list failed: ${stderr.trim() || `Exit code ${exitCode}`}`,
      { repoPath, stderr, exitCode },
    );
  }

  return parseGitWorktreeList(stdout);
}

export interface GitWorktreeAddOptions {
  worktreePath: string;
  branch?: string;
  newBranch?: boolean;
  commitOrBranch?: string;
  force?: boolean;
  detach?: boolean;
}

/**
 * Creates an isolated git worktree via `git worktree add`.
 */
export async function gitWorktreeAdd(
  repoPath: string,
  options: GitWorktreeAddOptions,
): Promise<{ worktreePath: string; branch?: string }> {
  const args = ['worktree', 'add'];
  const isNewBranch = options.newBranch ?? true;

  if (options.force) {
    args.push('--force');
  }

  if (options.detach) {
    args.push('--detach');
  } else if (options.branch) {
    if (isNewBranch) {
      args.push('-b', options.branch);
    }
  }

  args.push(options.worktreePath);

  if (options.commitOrBranch) {
    args.push(options.commitOrBranch);
  } else if (!isNewBranch && options.branch) {
    args.push(options.branch);
  }

  const { stderr, exitCode } = await runGitCommand(args, repoPath);

  if (exitCode !== 0) {
    throw new AppError(
      'GIT_WORKTREE_ERROR',
      `git worktree add failed: ${stderr.trim() || `Exit code ${exitCode}`}`,
      { repoPath, options, stderr, exitCode },
    );
  }

  return {
    worktreePath: options.worktreePath,
    branch: options.branch,
  };
}

export interface GitWorktreeRemoveOptions {
  force?: boolean;
}

/**
 * Removes a git worktree via `git worktree remove`.
 */
export async function gitWorktreeRemove(
  repoPath: string,
  worktreePath: string,
  options?: GitWorktreeRemoveOptions,
): Promise<void> {
  const args = ['worktree', 'remove'];
  if (options?.force) {
    args.push('--force');
  }
  args.push(worktreePath);

  const { stderr, exitCode } = await runGitCommand(args, repoPath);

  if (exitCode !== 0) {
    throw new AppError(
      'GIT_WORKTREE_ERROR',
      `git worktree remove failed: ${stderr.trim() || `Exit code ${exitCode}`}`,
      { repoPath, worktreePath, stderr, exitCode },
    );
  }
}

/**
 * Prunes expired or deleted worktrees via `git worktree prune`.
 */
export async function gitWorktreePrune(repoPath: string): Promise<void> {
  const { stderr, exitCode } = await runGitCommand(['worktree', 'prune'], repoPath);

  if (exitCode !== 0) {
    throw new AppError(
      'GIT_WORKTREE_ERROR',
      `git worktree prune failed: ${stderr.trim() || `Exit code ${exitCode}`}`,
      { repoPath, stderr, exitCode },
    );
  }
}

export interface GitDiffOptions {
  /** Base commit, branch, or ref (e.g. 'HEAD', 'main', or SHA) */
  baseRef?: string;
  /** Target commit, branch, or ref (if omitted, compares against working tree) */
  targetRef?: string;
  /** Whether to inspect staged changes only */
  staged?: boolean;
  /** Whether to detect and include untracked files (defaults to true) */
  includeUntracked?: boolean;
  /** Specific file path filters */
  paths?: string[];
}

export interface GitDiffResult {
  rawDiff: string;
  changedFiles: string[];
  fileDiffs: FileDiffDetail[];
}

/**
 * Retrieves git diff comparing working tree or commits, including untracked files.
 */
export async function getGitDiff(
  repoPath: string,
  options?: GitDiffOptions,
): Promise<GitDiffResult> {
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

  // Check if HEAD exists in this repository
  const headCheck = await runGitCommand(['rev-parse', '--verify', 'HEAD'], repoPath);
  const hasHead = headCheck.exitCode === 0;

  const diffArgs = ['diff'];

  if (options?.baseRef && options?.targetRef) {
    diffArgs.push(options.baseRef, options.targetRef);
  } else if (options?.baseRef) {
    diffArgs.push(options.baseRef);
  } else if (options?.staged) {
    diffArgs.push('--staged');
  } else if (hasHead) {
    // When no specific ref is provided, compare working tree against HEAD
    diffArgs.push('HEAD');
  }

  if (options?.paths && options.paths.length > 0) {
    diffArgs.push('--', ...options.paths);
  }

  const { stdout: diffStdout, stderr: diffStderr, exitCode: diffExit } = await runGitCommand(
    diffArgs,
    repoPath,
  );

  if (diffExit !== 0) {
    throw new AppError(
      'GIT_COMMAND_FAILED',
      `git diff failed: ${diffStderr.trim() || `Exit code ${diffExit}`}`,
      { repoPath, diffArgs, stderr: diffStderr, exitCode: diffExit },
    );
  }

  let rawDiff = diffStdout;
  const fileDiffs = parseUnifiedDiff(rawDiff);
  const changedFileSet = new Set<string>();

  for (const fd of fileDiffs) {
    changedFileSet.add(normalizeScopePath(fd.path));
    if (fd.oldPath) {
      changedFileSet.add(normalizeScopePath(fd.oldPath));
    }
  }

  // Include untracked files if requested and no specific targetRef commit was passed
  const shouldIncludeUntracked = options?.includeUntracked ?? true;
  if (shouldIncludeUntracked && !options?.targetRef) {
    const statusResult = await getRepoStatus(repoPath);
    for (const fileStatus of statusResult.files) {
      const normPath = normalizeScopePath(fileStatus.path);
      if (fileStatus.indexStatus === '?' && fileStatus.workTreeStatus === '?') {
        if (!changedFileSet.has(normPath)) {
          changedFileSet.add(normPath);

          // Build synthetic file diff for the untracked file
          const fullPath = path.resolve(repoPath, normPath);
          try {
            if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
              const content = fs.readFileSync(fullPath, 'utf-8');
              const lines = content.split('\n');
              const lineCount = lines.length;
              const patchHeader = [
                `diff --git a/${normPath} b/${normPath}`,
                'new file mode 100644',
                '--- /dev/null',
                `+++ b/${normPath}`,
                `@@ -0,0 +1,${lineCount} @@`,
                ...lines.map((l) => `+${l}`),
              ].join('\n');

              rawDiff += (rawDiff ? '\n' : '') + patchHeader;
              fileDiffs.push({
                path: normPath,
                status: 'untracked',
                additions: lineCount,
                deletions: 0,
                patch: patchHeader,
                inScope: true,
              });
              continue;
            }
          } catch {
            // If cannot read (e.g. binary or directory), add placeholder
          }

          fileDiffs.push({
            path: normPath,
            status: 'untracked',
            additions: 0,
            deletions: 0,
            patch: '',
            inScope: true,
          });
        }
      }
    }
  }

  return {
    rawDiff,
    changedFiles: Array.from(changedFileSet).sort(),
    fileDiffs,
  };
}

