import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import {
  type AuditResult,
  type SecretScanResult,
  type SecretFinding,
  type SecurityCheckResult,
  type SecurityCheckRecord,
  type SecurityCheckFilter,
  type CreateQualityCommandRecordInput,
  parsePnpmAuditOutput,
  parseGitleaksJson,
  scanDirectoryForSecrets,
  scanTextForSecrets,
  AppError,
  logger,
} from '@ai-orchestrator/shared';
import {
  SecurityCheckRepository,
  QualityCheckRepository,
  TaskRepository,
} from '@ai-orchestrator/db';
import { ProcessAdapter } from '../adapters/process-adapter.js';
import type { RepositoryRegistry } from '../adapters/repository-registry.js';

export interface SecurityCheckServiceOptions {
  db?: Database.Database;
  securityCheckRepo?: SecurityCheckRepository;
  qualityCheckRepo?: QualityCheckRepository;
  taskRepo?: TaskRepository;
  processAdapter?: ProcessAdapter;
  repositoryRegistry?: RepositoryRegistry;
  defaultRepoPath?: string;
}

export interface RunAuditOptions {
  repoPath?: string;
  taskId?: string;
  runId?: string;
  auditLevel?: 'info' | 'low' | 'moderate' | 'high' | 'critical';
  timeoutMs?: number;
}

export interface RunSecretScanOptions {
  repoPath?: string;
  taskId?: string;
  runId?: string;
  scanner?: 'auto' | 'gitleaks' | 'builtin' | 'both';
  diffContent?: string;
  timeoutMs?: number;
}

export interface RunSecurityCheckOptions {
  repoPath?: string;
  taskId?: string;
  runId?: string;
  scanner?: 'auto' | 'gitleaks' | 'builtin' | 'both';
  auditLevel?: 'info' | 'low' | 'moderate' | 'high' | 'critical';
  diffContent?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class SecurityCheckService {
  private readonly securityCheckRepo?: SecurityCheckRepository;
  private readonly qualityCheckRepo?: QualityCheckRepository;
  private readonly taskRepo?: TaskRepository;
  private readonly processAdapter: ProcessAdapter;
  private readonly repositoryRegistry?: RepositoryRegistry;
  private readonly defaultRepoPath: string;

  constructor(options: SecurityCheckServiceOptions = {}) {
    if (options.securityCheckRepo) {
      this.securityCheckRepo = options.securityCheckRepo;
    } else if (options.db) {
      this.securityCheckRepo = new SecurityCheckRepository(options.db);
    }

    if (options.qualityCheckRepo) {
      this.qualityCheckRepo = options.qualityCheckRepo;
    } else if (options.db) {
      this.qualityCheckRepo = new QualityCheckRepository(options.db);
    }

    if (options.taskRepo) {
      this.taskRepo = options.taskRepo;
    } else if (options.db) {
      this.taskRepo = new TaskRepository(options.db);
    }

    this.processAdapter = options.processAdapter ?? new ProcessAdapter();
    this.repositoryRegistry = options.repositoryRegistry;
    this.defaultRepoPath = options.defaultRepoPath ?? process.cwd();
  }

  /**
   * Resolves and validates target repository directory path.
   */
  resolveRepoPath(requestedPath?: string): string {
    const rawPath = requestedPath || this.defaultRepoPath;
    let resolved = path.resolve(rawPath);

    if (this.repositoryRegistry) {
      const reg = this.repositoryRegistry.get(rawPath);
      if (reg) {
        resolved = reg.path;
      }
      this.repositoryRegistry.assertCwdValid(resolved);
    }

    return resolved;
  }

  /**
   * Checks whether the `gitleaks` CLI executable is installed and available.
   */
  async isGitleaksAvailable(): Promise<boolean> {
    try {
      const handle = this.processAdapter.spawn({
        exe: 'gitleaks',
        args: ['version'],
        cwd: process.cwd(),
      });
      const result = await handle.waitForExit();
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  /**
   * Runs dependency security audit using `pnpm audit --json`.
   * Evaluates vulnerabilities against Quality Gate policy (passes if no high or critical vulnerabilities).
   * Stores execution in quality command records when configured.
   */
  async runAudit(options: RunAuditOptions = {}): Promise<AuditResult> {
    const repoPath = this.resolveRepoPath(options.repoPath);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = new Date().toISOString();
    const startTime = Date.now();

    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;

    try {
      const handle = this.processAdapter.spawn({
        exe: 'pnpm',
        args: ['audit', '--json'],
        cwd: repoPath,
      });

      handle.on('stdout', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });

      handle.on('stderr', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      let timeoutTimer: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<{ timedOut: boolean }>((resolve) => {
        timeoutTimer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      });

      const exitResult = await Promise.race([handle.waitForExit(), timeoutPromise]);
      if (timeoutTimer) clearTimeout(timeoutTimer);

      if ('timedOut' in exitResult && exitResult.timedOut) {
        try {
          await handle.terminate({ gracePeriodMs: 1000 });
        } catch {
          handle.kill('SIGKILL');
        }
        exitCode = 124;
        stderr += '\n[Audit process timed out]';
      } else if ('exitCode' in exitResult) {
        exitCode = exitResult.exitCode;
      }
    } catch (err) {
      exitCode = 1;
      stderr += `\nFailed to spawn pnpm audit: ${(err as Error).message}`;
    }

    const durationMs = Math.max(0, Date.now() - startTime);
    const finishedAt = new Date().toISOString();

    const auditResult = parsePnpmAuditOutput(stdout, {
      command: 'pnpm audit --json',
      exitCode,
      stderr,
      durationMs,
      auditLevel: options.auditLevel ?? 'high',
    });

    // Record into quality_command_records if repository is available
    if (this.qualityCheckRepo) {
      const recordInput: CreateQualityCommandRecordInput = {
        id: crypto.randomUUID(),
        task_id: options.taskId ?? null,
        run_id: options.runId ?? null,
        stage: 'custom',
        command_id: 'pnpm-audit',
        name: 'Dependency Security Audit (pnpm audit)',
        command: 'pnpm audit --json',
        exe: 'pnpm',
        args: ['audit', '--json'],
        cwd: repoPath,
        exit_code: exitCode,
        status: auditResult.passed ? 'SUCCESS' : 'FAILURE',
        stdout,
        stderr,
        duration_ms: durationMs,
        started_at: startedAt,
        finished_at: finishedAt,
      };
      try {
        this.qualityCheckRepo.create(recordInput);
      } catch (err) {
        logger.warn('Failed to record pnpm audit in quality_command_records', {
          error: (err as Error).message,
        });
      }
    }

    return auditResult;
  }

  /**
   * Runs secret scanning using Gitleaks (if available) or the high-confidence built-in regex scanner.
   */
  async runSecretScan(options: RunSecretScanOptions = {}): Promise<SecretScanResult> {
    const repoPath = this.resolveRepoPath(options.repoPath);
    const requestedScanner = options.scanner ?? 'auto';
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startTime = Date.now();

    // If diff content is directly supplied, use built-in secret scanner on text
    if (options.diffContent !== undefined) {
      const findings = scanTextForSecrets(options.diffContent, 'git.diff');
      const durationMs = Math.max(0, Date.now() - startTime);
      return {
        passed: findings.length === 0,
        scanner: 'builtin',
        command: 'builtin-text-scanner',
        exit_code: 0,
        stdout: `Scanned provided text. Discovered ${findings.length} secret finding(s).`,
        stderr: '',
        duration_ms: durationMs,
        findings,
        total_findings: findings.length,
        files_scanned: 1,
        summary:
          findings.length === 0
            ? 'Secret scan PASS: No secrets detected in provided content'
            : `Secret scan FAIL: ${findings.length} secret(s) detected`,
      };
    }

    let gitleaksAvailable = false;
    if (requestedScanner === 'gitleaks' || requestedScanner === 'auto' || requestedScanner === 'both') {
      gitleaksAvailable = await this.isGitleaksAvailable();
    }

    // Path A: Run Gitleaks CLI if available and requested
    if (gitleaksAvailable && (requestedScanner === 'gitleaks' || requestedScanner === 'auto' || requestedScanner === 'both')) {
      const reportFile = path.join(
        repoPath,
        `.gitleaks-report-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`,
      );
      let stdout = '';
      let stderr = '';
      let exitCode: number | null = null;

      try {
        const handle = this.processAdapter.spawn({
          exe: 'gitleaks',
          args: [
            'detect',
            '--no-git',
            '--source',
            repoPath,
            '--report-format',
            'json',
            '--report-path',
            reportFile,
            '--redact',
          ],
          cwd: repoPath,
        });

        handle.on('stdout', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });

        handle.on('stderr', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });

        let timeoutTimer: NodeJS.Timeout | null = null;
        const timeoutPromise = new Promise<{ timedOut: boolean }>((resolve) => {
          timeoutTimer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
        });

        const exitResult = await Promise.race([handle.waitForExit(), timeoutPromise]);
        if (timeoutTimer) clearTimeout(timeoutTimer);

        if ('timedOut' in exitResult && exitResult.timedOut) {
          try {
            await handle.terminate({ gracePeriodMs: 1000 });
          } catch {
            handle.kill('SIGKILL');
          }
          exitCode = 124;
        } else if ('exitCode' in exitResult) {
          exitCode = exitResult.exitCode;
        }

        let findings: SecretFinding[] = [];
        if (fs.existsSync(reportFile)) {
          const reportJson = await fs.promises.readFile(reportFile, 'utf8');
          findings = parseGitleaksJson(reportJson);
          try {
            await fs.promises.unlink(reportFile);
          } catch {
            // Ignore report cleanup error
          }
        }

        const durationMs = Math.max(0, Date.now() - startTime);
        const passed = findings.length === 0;
        return {
          passed,
          scanner: 'gitleaks',
          command: `gitleaks detect --no-git --source ${repoPath}`,
          exit_code: exitCode,
          stdout,
          stderr,
          duration_ms: durationMs,
          findings,
          total_findings: findings.length,
          files_scanned: 0,
          summary: passed
            ? 'Secret scan PASS (Gitleaks): No secrets found'
            : `Secret scan FAIL (Gitleaks): ${findings.length} secret(s) detected`,
        };
      } catch (err) {
        if (fs.existsSync(reportFile)) {
          try {
            await fs.promises.unlink(reportFile);
          } catch {
            // Ignore cleanup
          }
        }

        if (requestedScanner === 'gitleaks') {
          throw new AppError(
            'GITLEAKS_EXECUTION_ERROR',
            `Gitleaks execution failed: ${(err as Error).message}`,
          );
        }
        // If auto mode, fall through to built-in scanner
      }
    }

    // Path B: Run built-in scanner (default fallback or explicit)
    const { findings, filesScanned } = await scanDirectoryForSecrets(repoPath);
    const durationMs = Math.max(0, Date.now() - startTime);
    const passed = findings.length === 0;

    return {
      passed,
      scanner: 'builtin',
      command: `builtin-secret-scanner ${repoPath}`,
      exit_code: 0,
      stdout: `Scanned ${filesScanned} files across repository. Found ${findings.length} secret(s).`,
      stderr: '',
      duration_ms: durationMs,
      findings,
      total_findings: findings.length,
      files_scanned: filesScanned,
      summary: passed
        ? `Secret scan PASS (Builtin): ${filesScanned} files clean, 0 secrets detected`
        : `Secret scan FAIL (Builtin): ${findings.length} secret(s) detected across ${filesScanned} files`,
    };
  }

  /**
   * Executes a full Security Check combining dependency audit and secret scan.
   * Persists results into SQLite database repository and audit reports.
   * Satisfies ROADMAP QLT-005: "Security check: pnpm audit + quét secret (gitleaks nếu có) - Kết quả thật được lưu".
   */
  async runSecurityCheck(options: RunSecurityCheckOptions = {}): Promise<SecurityCheckResult> {
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const repoPath = this.resolveRepoPath(options.repoPath);

    logger.info('Starting security check (audit + secrets)', {
      repoPath,
      taskId: options.taskId,
      runId: options.runId,
    });

    // 1. Run pnpm audit
    const audit = await this.runAudit({
      repoPath,
      taskId: options.taskId,
      runId: options.runId,
      auditLevel: options.auditLevel,
      timeoutMs: options.timeoutMs,
    });

    // 2. Run secret scan
    const secrets = await this.runSecretScan({
      repoPath,
      taskId: options.taskId,
      runId: options.runId,
      scanner: options.scanner,
      diffContent: options.diffContent,
      timeoutMs: options.timeoutMs,
    });

    const finishedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.now() - startTime);
    const passed = audit.passed && secrets.passed;
    const checkId = crypto.randomUUID();

    const summary = passed
      ? `Security Check PASSED: Audit clean (${audit.counts.total} advisories, 0 high/critical), Secrets clean (${secrets.total_findings} findings)`
      : `Security Check FAILED: ${!audit.passed ? `Audit failed (${audit.highOrCriticalCount} high/critical)` : 'Audit passed'}; ${!secrets.passed ? `Secrets failed (${secrets.total_findings} detected)` : 'Secrets passed'}`;

    const checkResult: SecurityCheckResult = {
      id: checkId,
      task_id: options.taskId ?? null,
      run_id: options.runId ?? null,
      repo_path: repoPath,
      passed,
      audit_passed: audit.passed,
      secret_passed: secrets.passed,
      audit_high_critical_count: audit.highOrCriticalCount,
      secret_findings_count: secrets.total_findings,
      audit,
      secrets,
      summary,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: durationMs,
    };

    // 3. Persist record into SQLite repository ("Kết quả thật được lưu")
    if (this.securityCheckRepo) {
      try {
        this.securityCheckRepo.create(
          {
            id: checkId,
            task_id: options.taskId ?? null,
            run_id: options.runId ?? null,
            repo_path: repoPath,
            passed,
            audit_passed: audit.passed,
            secret_passed: secrets.passed,
            audit_high_critical_count: audit.highOrCriticalCount,
            secret_findings_count: secrets.total_findings,
            audit_summary: JSON.stringify(audit.counts),
            secret_summary: JSON.stringify({
              scanner: secrets.scanner,
              total_findings: secrets.total_findings,
              files_scanned: secrets.files_scanned,
            }),
            raw_details: JSON.stringify({
              audit_summary: audit.summary,
              secret_summary: secrets.summary,
              vulnerabilities_sample: audit.vulnerabilities.slice(0, 10),
            }),
            duration_ms: durationMs,
            created_at: finishedAt,
          },
          secrets.findings,
        );
      } catch (err) {
        logger.error('Failed to persist security check record to database', {
          error: (err as Error).message,
        });
      }
    }

    return checkResult;
  }

  /**
   * Executes a security check on a specific task in the database.
   */
  async checkTask(
    taskId: string,
    options: Omit<RunSecurityCheckOptions, 'taskId'> = {},
  ): Promise<SecurityCheckResult> {
    if (!this.taskRepo) {
      throw new AppError('TASK_REPO_NOT_CONFIGURED', 'TaskRepository is required for checkTask');
    }

    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new AppError('TASK_NOT_FOUND', `Task with ID ${taskId} not found`);
    }

    return this.runSecurityCheck({
      ...options,
      taskId,
      repoPath: options.repoPath ?? this.defaultRepoPath,
    });
  }

  /**
   * Queries stored security checks.
   */
  getSecurityChecks(filter: SecurityCheckFilter = {}): SecurityCheckRecord[] {
    if (!this.securityCheckRepo) {
      return [];
    }
    return this.securityCheckRepo.find(filter);
  }

  /**
   * Retrieves a specific security check by ID.
   */
  getSecurityCheckById(id: string): SecurityCheckRecord | null {
    if (!this.securityCheckRepo) {
      return null;
    }
    return this.securityCheckRepo.findById(id);
  }

  /**
   * Retrieves secret findings for a specific security check.
   */
  getSecretFindings(checkId: string): SecretFinding[] {
    if (!this.securityCheckRepo) {
      return [];
    }
    return this.securityCheckRepo.findSecretFindingsByCheckId(checkId);
  }
}
