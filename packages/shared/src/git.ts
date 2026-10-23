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

/**
 * Validates a git branch name according to git check-ref-format rules.
 * Throws AppError('INVALID_BRANCH_NAME') if invalid.
 */
export function validateGitBranchName(branchName: string): void {
  if (!branchName || typeof branchName !== 'string') {
    throw new AppError('INVALID_BRANCH_NAME', 'Branch name cannot be empty', { branchName });
  }

  const trimmed = branchName.trim();
  if (trimmed !== branchName) {
    throw new AppError(
      'INVALID_BRANCH_NAME',
      'Branch name cannot have leading or trailing whitespace',
      { branchName },
    );
  }

  if (branchName.length === 0 || branchName.length > 255) {
    throw new AppError(
      'INVALID_BRANCH_NAME',
      `Branch name length (${branchName.length}) exceeds 255 characters`,
      { branchName },
    );
  }

  // Ref format rules:
  // Cannot begin or end with a slash '/'
  // Cannot end with '.lock'
  // Cannot contain '..'
  // Cannot contain consecutive slashes '//'
  // Cannot contain '@{'
  // Cannot be '@'
  // Cannot contain ASCII control characters, spaces, or characters ~ ^ : ? * [ \
  if (
    branchName.startsWith('/') ||
    branchName.endsWith('/') ||
    branchName.startsWith('.') ||
    branchName.endsWith('.') ||
    branchName.endsWith('.lock') ||
    branchName.includes('..') ||
    branchName.includes('//') ||
    branchName.includes('@{') ||
    branchName === '@' ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x20\x7f~^:?*[\\\]]/.test(branchName)
  ) {
    throw new AppError(
      'INVALID_BRANCH_NAME',
      `Invalid git branch name: "${branchName}". Branch names cannot contain special characters or spaces.`,
      { branchName },
    );
  }
}

/**
 * Checks whether a branch exists in the repository.
 */
export async function gitBranchExists(
  repoPath: string,
  branchName: string,
  options?: { checkRemote?: boolean; remoteName?: string },
): Promise<boolean> {
  const localCheck = await runGitCommand(
    ['show-ref', '--verify', `refs/heads/${branchName}`],
    repoPath,
  );
  if (localCheck.exitCode === 0) {
    return true;
  }

  if (options?.checkRemote) {
    const remote = options.remoteName ?? 'origin';
    const remoteCheck = await runGitCommand(
      ['show-ref', '--verify', `refs/remotes/${remote}/${branchName}`],
      repoPath,
    );
    if (remoteCheck.exitCode === 0) {
      return true;
    }
  }

  return false;
}

/**
 * Lists branch names in the repository.
 */
export async function gitListBranches(
  repoPath: string,
  options?: { remote?: boolean },
): Promise<string[]> {
  const args = ['branch', '--list', '--format=%(refname:short)'];
  if (options?.remote) {
    args.push('-a');
  }

  const { stdout, stderr, exitCode } = await runGitCommand(args, repoPath);
  if (exitCode !== 0) {
    throw new AppError('GIT_COMMAND_FAILED', `Failed to list git branches: ${stderr.trim()}`, {
      repoPath,
      stderr,
      exitCode,
    });
  }

  return stdout
    .split(/\r?\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

/**
 * Returns the name of the currently checked out branch, or null if detached.
 */
export async function gitGetCurrentBranch(repoPath: string): Promise<string | null> {
  const { stdout, exitCode } = await runGitCommand(
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    repoPath,
  );
  if (exitCode !== 0) {
    return null;
  }
  const branch = stdout.trim();
  return branch && branch !== 'HEAD' ? branch : null;
}

/**
 * Returns the commit SHA for a given git reference, or null if it cannot be resolved.
 */
export async function gitGetRefCommit(repoPath: string, ref: string): Promise<string | null> {
  const { stdout, exitCode } = await runGitCommand(
    ['rev-parse', '--verify', `${ref}^{commit}`],
    repoPath,
  );
  if (exitCode !== 0) {
    return null;
  }
  const sha = stdout.trim();
  return sha.length > 0 ? sha : null;
}

/**
 * Automatically determines a sensible default base branch for a new branch.
 * Checks 'main' -> 'dev' -> 'master' -> current branch -> 'HEAD'.
 */
export async function gitGetDefaultBaseBranch(repoPath: string): Promise<string> {
  if (await gitBranchExists(repoPath, 'main')) {
    return 'main';
  }
  if (await gitBranchExists(repoPath, 'dev')) {
    return 'dev';
  }
  if (await gitBranchExists(repoPath, 'master')) {
    return 'master';
  }
  const current = await gitGetCurrentBranch(repoPath);
  if (current) {
    return current;
  }
  return 'HEAD';
}

export interface GitCreateBranchOptions {
  branchName: string;
  baseBranch?: string;
  requireClean?: boolean;
  checkout?: boolean;
  checkRemote?: boolean;
  remoteName?: string;
}

export interface GitCreateBranchResult {
  branch: string;
  baseBranch: string;
  commitSha: string;
  repoPath: string;
  created: boolean;
  createdAt: string;
}

/**
 * Creates a git branch safely without overwriting existing branches.
 * Throws AppError('BRANCH_ALREADY_EXISTS') if branch already exists.
 * Throws AppError('REPO_DIRTY') if working tree has uncommitted changes and requireClean is true.
 * Throws AppError('INVALID_BRANCH_NAME') if branch name format is invalid.
 */
export async function gitCreateBranch(
  repoPath: string,
  options: GitCreateBranchOptions,
): Promise<GitCreateBranchResult> {
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

  const { branchName } = options;
  validateGitBranchName(branchName);

  // 1. Verify working directory cleanliness
  if (options.requireClean !== false) {
    await checkRepoClean(repoPath);
  }

  // 2. Safe check: Branch trùng -> lỗi (Do NOT overwrite)
  const alreadyExists = await gitBranchExists(repoPath, branchName, {
    checkRemote: options.checkRemote,
    remoteName: options.remoteName,
  });

  if (alreadyExists) {
    throw new AppError(
      'BRANCH_ALREADY_EXISTS',
      `Git branch '${branchName}' already exists in repository '${repoPath}'. Overwriting existing branch is strictly prohibited.`,
      {
        repoPath,
        branch: branchName,
      },
    );
  }

  // 3. Resolve base branch
  const baseBranch = options.baseBranch ?? (await gitGetDefaultBaseBranch(repoPath));
  const baseSha = await gitGetRefCommit(repoPath, baseBranch);
  if (!baseSha) {
    throw new AppError(
      'BASE_REF_NOT_FOUND',
      `Base reference '${baseBranch}' could not be resolved to a commit in '${repoPath}'`,
      {
        repoPath,
        baseBranch,
      },
    );
  }

  // 4. Create branch safely (git branch <branchName> <baseBranch>)
  const { stderr, exitCode } = await runGitCommand(
    ['branch', branchName, baseBranch],
    repoPath,
  );

  if (exitCode !== 0) {
    if (stderr.toLowerCase().includes('already exists')) {
      throw new AppError(
        'BRANCH_ALREADY_EXISTS',
        `Git branch '${branchName}' already exists in repository '${repoPath}'. Overwriting existing branch is strictly prohibited.`,
        {
          repoPath,
          branch: branchName,
          stderr,
        },
      );
    }
    throw new AppError(
      'GIT_COMMAND_FAILED',
      `Failed to create git branch '${branchName}': ${stderr.trim() || `Exit code ${exitCode}`}`,
      {
        repoPath,
        branchName,
        baseBranch,
        stderr,
        exitCode,
      },
    );
  }

  // 5. Optionally checkout the newly created branch
  if (options.checkout) {
    const { stderr: coStderr, exitCode: coExit } = await runGitCommand(
      ['checkout', branchName],
      repoPath,
    );
    if (coExit !== 0) {
      throw new AppError(
        'GIT_COMMAND_FAILED',
        `Branch '${branchName}' was created but checkout failed: ${coStderr.trim()}`,
        {
          repoPath,
          branchName,
          stderr: coStderr,
          exitCode: coExit,
        },
      );
    }
  }

  // 6. Obtain commit SHA of the created branch
  const commitSha = (await gitGetRefCommit(repoPath, branchName)) ?? baseSha;
  const createdAt = new Date().toISOString();

  return {
    branch: branchName,
    baseBranch,
    commitSha,
    repoPath,
    created: true,
    createdAt,
  };
}


