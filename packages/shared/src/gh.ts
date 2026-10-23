import { spawn } from 'node:child_process';
import { AppError } from './errors.js';

export interface GhPrCreateOptions {
  base: string;
  head: string;
  title: string;
  body?: string;
  bodyFile?: string;
  draft?: boolean;
  repoPath?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  allowExisting?: boolean;
  env?: Record<string, string>;
  runCommand?: (
    args: string[],
    cwd: string,
    env?: Record<string, string>,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  onRetry?: (attempt: number, error: AppError) => void;
}

export interface GhPrCreateResult {
  prUrl: string;
  prNumber: number | null;
  head: string;
  base: string;
  title: string;
  isExisting: boolean;
  createdAt: string;
}

export interface GhPrViewOptions {
  repoPath?: string;
  env?: Record<string, string>;
  runCommand?: (
    args: string[],
    cwd: string,
    env?: Record<string, string>,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface GhPrViewResult {
  url: string;
  number: number;
  state: string;
  title: string;
  headRefName: string;
  baseRefName: string;
}

/**
 * Che giấu và loại bỏ GitHub tokens / credentials khỏi log hoặc output của GitHub CLI (gh).
 */
export function sanitizeGhOutput(text: string): string {
  if (!text) return '';

  return (
    text
      // Redact GitHub Personal Access Tokens (classic & fine-grained)
      .replace(/\bghp_[a-zA-Z0-9_]{20,}\b/g, '[REDACTED_GH_TOKEN]')
      .replace(/\bgithub_pat_[a-zA-Z0-9_]{20,}\b/g, '[REDACTED_GH_PAT]')
      // Redact GitHub OAuth, User-to-Server, Server-to-Server tokens
      .replace(/\bgh[ousr]_[a-zA-Z0-9_]{20,}\b/g, '[REDACTED_GH_TOKEN]')
      // Redact Bearer tokens
      .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED_TOKEN]')
      // Redact basic auth in URLs
      .replace(/(https?:\/\/)[^:@/\s]+:[^@/\s]+@/g, '$1[REDACTED_CREDENTIALS]@')
  );
}

/**
 * Trích xuất URL Pull Request từ text output.
 */
export function extractPrUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s/$.?#].[^\s]*\/pull\/\d+/);
  return match ? match[0] : null;
}

/**
 * Trích xuất số hiệu PR (PR number) từ PR URL.
 */
export function extractPrNumber(prUrl: string): number | null {
  const match = prUrl.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  if (match?.[1]) {
    const num = parseInt(match[1], 10);
    return isNaN(num) ? null : num;
  }
  return null;
}

/**
 * Phân loại lỗi trả về từ `gh` CLI thành các AppError với mã lỗi chuẩn hóa.
 */
export function classifyGhError(
  output: string,
  exitCode: number,
  context?: Record<string, unknown>,
): AppError {
  const sanitizedOutput = sanitizeGhOutput(output).trim();
  const lower = sanitizedOutput.toLowerCase();

  // 1. GH executable not found
  if (lower.includes('enoent') || lower.includes('gh: command not found') || lower.includes('not recognized as an internal or external command')) {
    return new AppError(
      'GH_NOT_FOUND',
      `GitHub CLI 'gh' is not installed or not found in system PATH. Please install gh CLI.`,
      { ...context, exitCode, rawOutput: sanitizedOutput },
    );
  }

  // 2. Auth failed
  if (
    lower.includes('to authenticate, please run: gh auth login') ||
    lower.includes('authentication failed') ||
    lower.includes('bad credentials') ||
    lower.includes('http 401') ||
    lower.includes('could not read username') ||
    lower.includes('gh auth status') ||
    lower.includes('not logged in to any github hosts')
  ) {
    return new AppError(
      'GH_AUTH_FAILED',
      `GitHub CLI authentication failed. Ensure GH_TOKEN or 'gh auth login' is configured. Error: ${sanitizedOutput}`,
      { ...context, exitCode, rawOutput: sanitizedOutput },
    );
  }

  // 3. PR already exists
  if (
    lower.includes('already exists:') ||
    lower.includes('a pull request for branch') ||
    lower.includes('pull request already exists')
  ) {
    const existingUrl = extractPrUrl(sanitizedOutput);
    const existingNum = existingUrl ? extractPrNumber(existingUrl) : null;
    return new AppError(
      'GH_PR_ALREADY_EXISTS',
      `A pull request for branch already exists: ${existingUrl ?? sanitizedOutput}`,
      { ...context, exitCode, prUrl: existingUrl, prNumber: existingNum, rawOutput: sanitizedOutput },
    );
  }

  // 4. Network / connection timeout error
  if (
    lower.includes('could not resolve host') ||
    lower.includes('connection timed out') ||
    lower.includes('network is unreachable') ||
    lower.includes('connection reset') ||
    lower.includes('tls handshake timeout') ||
    lower.includes('i/o timeout') ||
    lower.includes('temporary failure in name resolution')
  ) {
    return new AppError(
      'GH_NETWORK_ERROR',
      `GitHub CLI encountered a network connection error: ${sanitizedOutput}`,
      { ...context, exitCode, rawOutput: sanitizedOutput },
    );
  }

  // 5. Default command failure
  return new AppError(
    'GH_COMMAND_FAILED',
    `GitHub CLI 'gh' command failed with exit code ${exitCode}: ${sanitizedOutput || 'Unknown error'}`,
    { ...context, exitCode, rawOutput: sanitizedOutput },
  );
}

/**
 * Thực thi lệnh `gh` bằng child_process.spawn an toàn, cấm shell injection.
 */
export function runGhCommand(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn('gh', args, {
        cwd,
        env: {
          ...process.env,
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      const errObj = err as { code?: string; message?: string };
      if (errObj.code === 'ENOENT') {
        reject(
          new AppError('GH_NOT_FOUND', `GitHub CLI 'gh' executable not found in PATH`, {
            cwd,
            args,
          }),
        );
        return;
      }
      reject(
        new AppError(
          'GH_SPAWN_ERROR',
          `Failed to start gh process: ${errObj.message || String(err)}`,
          { cwd, args },
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

    proc.on('error', (err: unknown) => {
      const errObj = err as { code?: string; message?: string };
      if (errObj.code === 'ENOENT') {
        reject(
          new AppError('GH_NOT_FOUND', `GitHub CLI 'gh' executable not found in PATH`, {
            cwd,
            args,
          }),
        );
      } else {
        reject(
          new AppError('GH_SPAWN_ERROR', `Process gh error: ${errObj.message || String(err)}`, {
            cwd,
            args,
          }),
        );
      }
    });

    proc.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
      });
    });
  });
}

/**
 * Tạo GitHub Pull Request qua `gh pr create` (REL-006).
 * Đảm bảo:
 * - Gọi spawn an toàn, không shell injection.
 * - Che giấu credentials khỏi log và thông báo lỗi.
 * - Tự động retry với exponential backoff khi gặp lỗi mạng tạm thời (GH_NETWORK_ERROR).
 * - Xử lý tính lũy đẳng (idempotency): nếu PR đã tồn tại và allowExisting=true thì bóc tách PR URL và không crash.
 */
export async function ghPrCreate(options: GhPrCreateOptions): Promise<GhPrCreateResult> {
  const {
    base,
    head,
    title,
    body,
    bodyFile,
    draft = false,
    repoPath = '.',
    maxRetries = 2,
    retryDelayMs = 300,
    allowExisting = true,
    env,
  } = options;

  const runner = options.runCommand ?? runGhCommand;

  const args: string[] = ['pr', 'create', '--base', base, '--head', head, '--title', title];

  if (bodyFile) {
    args.push('--body-file', bodyFile);
  } else if (body !== undefined) {
    args.push('--body', body);
  } else {
    args.push('--body', '');
  }

  if (draft) {
    args.push('--draft');
  }

  let lastError: AppError | null = null;
  const totalAttempts = Math.max(1, maxRetries + 1);

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    let stdout: string;
    let stderr: string;
    let exitCode: number;

    try {
      const res = await runner(args, repoPath, env);
      stdout = res.stdout;
      stderr = res.stderr;
      exitCode = res.exitCode;
    } catch (err: unknown) {
      if (err instanceof AppError) {
        lastError = err;
        if (err.code === 'GH_NOT_FOUND') {
          throw err;
        }
      } else {
        lastError = new AppError('GH_COMMAND_FAILED', String(err));
      }
      throw lastError;
    }

    if (exitCode === 0) {
      const rawCombined = `${stdout}\n${stderr}`;
      const prUrl = extractPrUrl(rawCombined) || stdout.trim();
      const prNumber = extractPrNumber(prUrl);

      return {
        prUrl,
        prNumber,
        head,
        base,
        title,
        isExisting: false,
        createdAt: new Date().toISOString(),
      };
    }

    // Classify error
    const classifiedError = classifyGhError(stderr || stdout, exitCode, {
      repoPath,
      base,
      head,
      title,
      attempt,
    });
    lastError = classifiedError;

    // Handle existing PR gracefully if allowExisting=true
    if (classifiedError.code === 'GH_PR_ALREADY_EXISTS' && allowExisting) {
      const existingUrl =
        (classifiedError.context?.prUrl as string) ||
        extractPrUrl(`${stdout}\n${stderr}`);

      if (existingUrl) {
        const prNumber =
          (classifiedError.context?.prNumber as number) ||
          extractPrNumber(existingUrl);

        return {
          prUrl: existingUrl,
          prNumber,
          head,
          base,
          title,
          isExisting: true,
          createdAt: new Date().toISOString(),
        };
      }
    }

    // Fail fast on non-retryable errors
    const isRetryable = classifiedError.code === 'GH_NETWORK_ERROR';
    if (isRetryable && attempt < totalAttempts) {
      if (options.onRetry) {
        options.onRetry(attempt, classifiedError);
      }
      const backoff = retryDelayMs * Math.pow(1.5, attempt - 1);
      await new Promise((res) => setTimeout(res, backoff));
      continue;
    }

    throw classifiedError;
  }

  if (lastError) {
    throw lastError;
  }

  throw new AppError('GH_COMMAND_FAILED', 'Failed to create PR: unknown error', {
    head,
    base,
    title,
  });
}

/**
 * Xem thông tin Pull Request hiện có qua `gh pr view`.
 */
export async function ghPrView(
  branchOrNumber: string,
  options?: GhPrViewOptions,
): Promise<GhPrViewResult | null> {
  const runner = options?.runCommand ?? runGhCommand;
  const repoPath = options?.repoPath ?? '.';

  const args = [
    'pr',
    'view',
    branchOrNumber,
    '--json',
    'url,number,state,title,headRefName,baseRefName',
  ];

  try {
    const { stdout, exitCode } = await runner(args, repoPath, options?.env);
    if (exitCode !== 0 || !stdout.trim()) {
      return null;
    }
    const parsed = JSON.parse(stdout) as GhPrViewResult;
    return parsed;
  } catch {
    return null;
  }
}
