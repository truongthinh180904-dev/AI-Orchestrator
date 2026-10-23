import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  RunRepository,
  ReportRepository,
  SecurityCheckRepository,
} from '../packages/db/src/index.js';
import type { ChildProcess } from 'node:child_process';
import type { AgentCommandInput } from '../packages/shared/src/index.js';
import {
  parsePnpmAuditOutput,
  maskSecret,
  hashSecret,
  scanTextForSecrets,
  scanDirectoryForSecrets,
  parseGitleaksJson,
  isIgnoredScanPath,
} from '../packages/shared/src/index.js';
import { SecurityCheckService } from '../apps/orchestrator/src/services/security-check-service.js';
import { QualityConfigService } from '../apps/orchestrator/src/services/quality-config-service.js';
import { QualityRunner } from '../apps/orchestrator/src/services/quality-runner.js';
import { buildServer } from '../apps/orchestrator/src/server.js';
import { ProcessAdapter, type ProcessHandle } from '../apps/orchestrator/src/adapters/process-adapter.js';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

class MockProcessAdapter extends ProcessAdapter {
  constructor(
    private readonly mockFn: (cmd: { exe: string; args: string[]; cwd: string }) => {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
    },
  ) {
    super();
  }

  override spawn(
    commandOrExe: AgentCommandInput | string,
    rawArgs?: string[],
    rawCwd?: string,
  ): ProcessHandle {
    let command: { exe: string; args: string[]; cwd: string };
    if (typeof commandOrExe === 'string') {
      command = {
        exe: commandOrExe,
        args: rawArgs ?? [],
        cwd: rawCwd ?? process.cwd(),
      };
    } else {
      command = {
        exe: commandOrExe.exe,
        args: commandOrExe.args ?? [],
        cwd: commandOrExe.cwd ?? process.cwd(),
      };
    }

    const emitter = new EventEmitter() as unknown as ProcessHandle;
    const stdoutStream = new Readable({ read() {} });
    const stderrStream = new Readable({ read() {} });

    Object.assign(emitter, {
      pid: 9999,
      child: { pid: 9999 } as unknown as ChildProcess,
      stdout: stdoutStream,
      stderr: stderrStream,
      command,
      startedAt: new Date(),
      isRunning: () => false,
      kill: () => true,
      terminate: async () => ({ exitCode: 0, signal: null, durationMs: 10, timedOut: false }),
    });

    const result = this.mockFn(command);

    Object.assign(emitter, {
      waitForExit: async () => {
        if (result.stdout) {
          emitter.emit('stdout', Buffer.from(result.stdout));
        }
        if (result.stderr) {
          emitter.emit('stderr', Buffer.from(result.stderr));
        }
        return {
          exitCode: result.exitCode ?? 0,
          signal: null,
          durationMs: 15,
          timedOut: false,
        };
      },
    });

    return emitter;
  }
}

describe('QLT-005 Acceptance Tests: Security check: pnpm audit + quét secret (gitleaks nếu có) — Kết quả thật được lưu', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let runRepo: RunRepository;
  let reportRepo: ReportRepository;
  let securityCheckRepo: SecurityCheckRepository;
  let securityCheckService: SecurityCheckService;
  let app: FastifyInstance;
  let testRepoDir: string;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    runRepo = new RunRepository(db);
    reportRepo = new ReportRepository(db);
    securityCheckRepo = new SecurityCheckRepository(db);

    // Initialize temporary repository
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlt-005-repo-'));
    execSync('git init -b main', { cwd: testRepoDir, stdio: 'ignore' });
    execSync('git config user.email "security-test@example.com"', { cwd: testRepoDir, stdio: 'ignore' });
    execSync('git config user.name "Security Test User"', { cwd: testRepoDir, stdio: 'ignore' });

    fs.mkdirSync(path.join(testRepoDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(testRepoDir, 'src', 'index.ts'),
      'export function greet(): string { return "secure"; }\n',
    );
    execSync('git add . && git commit -m "initial commit"', { cwd: testRepoDir, stdio: 'ignore' });

    const mockAdapter = new MockProcessAdapter((cmd) => {
      if (cmd.exe === 'gitleaks') {
        return { exitCode: 0, stdout: 'v8.18.0' };
      }
      // pnpm audit --json
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          actions: [],
          advisories: {},
          muted: [],
          metadata: {
            vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
            totalDependencies: 50,
          },
        }),
      };
    });

    securityCheckService = new SecurityCheckService({
      db,
      processAdapter: mockAdapter,
      defaultRepoPath: testRepoDir,
    });

    const qualityConfigService = new QualityConfigService({ db });
    const qualityRunner = new QualityRunner({ db, qualityConfigService, processAdapter: mockAdapter });

    app = await buildServer({
      db,
      qualityConfigService,
      qualityRunner,
      securityCheckService,
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    try {
      fs.rmSync(testRepoDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('Nghiệm thu 1: pnpm audit parser bóc tách chính xác các lỗ hổng và nhóm theo severity', () => {
    const rawAudit = JSON.stringify({
      advisories: {
        '100': {
          id: 100,
          title: 'Prototype Pollution in lib-a',
          module_name: 'lib-a',
          severity: 'moderate',
          vulnerable_versions: '<1.2.0',
          patched_versions: '>=1.2.0',
          cwe: 'CWE-1321',
          url: 'https://github.com/advisories/GHSA-100',
          findings: [{ paths: ['root>lib-a'] }],
        },
      },
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 },
      },
    });

    const parsed = parsePnpmAuditOutput(rawAudit, { exitCode: 1 });
    expect(parsed.counts.moderate).toBe(1);
    expect(parsed.counts.total).toBe(1);
    expect(parsed.vulnerabilities).toHaveLength(1);
    expect(parsed.vulnerabilities[0]?.module_name).toBe('lib-a');
    expect(parsed.vulnerabilities[0]?.cwe).toBe('CWE-1321');
  });

  it('Nghiệm thu 2: Quality Gate PASS khi audit không có lỗ hổng high hoặc critical', () => {
    const rawAudit = JSON.stringify({
      advisories: {
        '101': {
          id: 101,
          title: 'Low risk info disclosure',
          module_name: 'lib-low',
          severity: 'low',
        },
        '102': {
          id: 102,
          title: 'Moderate timing attack',
          module_name: 'lib-mod',
          severity: 'moderate',
        },
      },
      metadata: {
        vulnerabilities: { info: 0, low: 1, moderate: 1, high: 0, critical: 0 },
      },
    });

    const parsed = parsePnpmAuditOutput(rawAudit, { exitCode: 1 });
    // Rule SKILL-testing: "audit không có lỗ hổng high+"
    expect(parsed.passed).toBe(true);
    expect(parsed.highOrCriticalCount).toBe(0);
    expect(parsed.summary).toContain('Audit PASS');
  });

  it('Nghiệm thu 3: Quality Gate FAIL khi audit phát hiện lỗ hổng high hoặc critical', () => {
    const rawAudit = JSON.stringify({
      advisories: {
        '201': {
          id: 201,
          title: 'Critical Remote Code Execution',
          module_name: 'unsafe-pkg',
          severity: 'critical',
        },
      },
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1 },
      },
    });

    const parsed = parsePnpmAuditOutput(rawAudit, { exitCode: 1 });
    expect(parsed.passed).toBe(false);
    expect(parsed.highOrCriticalCount).toBe(1);
    expect(parsed.counts.critical).toBe(1);
    expect(parsed.summary).toContain('Audit FAIL');
  });

  it('Nghiệm thu 4: Mặt nạ hóa secret (maskSecret) đảm bảo tuyệt đối không lưu lộ plaintext secret', () => {
    const sensitiveTokens = [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
      'xoxb-1234567890-abcdefghijklmnopqrstuv',
      'sk-ant-1234567890abcdefghijklmnopqrstuvwxyz',
    ];

    for (const token of sensitiveTokens) {
      const masked = maskSecret(token);
      expect(masked).not.toBe(token);
      expect(masked).toContain('*');
      const hash = hashSecret(token);
      expect(hash).toHaveLength(64);
    }
  });

  it('Nghiệm thu 5: Built-in Secret Scanner phát hiện chính xác đa dạng các mẫu secret', () => {
    const content = `
      // API credentials
      const AWS_KEY = "AKIA1234567890ABCDEF";
      const GITHUB_PAT = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
      const OPENAI_KEY = "sk-1234567890abcdefghijklmnopqrstuvwxyz";
      const SLACK = "xoxb-1234567890-abcdefghijklmnopqrstuv";
      const DB_PASSWORD = 'password = "SuperSecretDatabasePassword123"';
    `;

    const findings = scanTextForSecrets(content, 'test.ts');
    expect(findings.length).toBeGreaterThanOrEqual(4);

    const rules = findings.map((f) => f.rule_id);
    expect(rules).toContain('aws_access_key');
    expect(rules).toContain('github_pat');
    expect(rules).toContain('ai_api_key');
    expect(rules).toContain('slack_token');

    for (const f of findings) {
      expect(f.match_preview).toContain('*');
      expect(f.file).toBe('test.ts');
      expect(f.line).toBeGreaterThan(0);
    }
  });

  it('Nghiệm thu 6: Quét thư mục tự động bỏ qua các file không liên quan (.git, node_modules, lockfiles)', async () => {
    // Write a dummy lockfile and .git internal file
    fs.writeFileSync(path.join(testRepoDir, 'pnpm-lock.yaml'), 'fake lockfile');
    fs.writeFileSync(path.join(testRepoDir, '.env.example'), 'PORT=3000');

    const { findings, filesScanned } = await scanDirectoryForSecrets(testRepoDir);
    expect(findings).toHaveLength(0);
    expect(filesScanned).toBeGreaterThan(0);
    expect(isIgnoredScanPath('.git/HEAD')).toBe(true);
    expect(isIgnoredScanPath('node_modules/foo/bar.js')).toBe(true);
  });

  it('Nghiệm thu 7: Tích hợp Gitleaks tự động nhận diện và bóc tách kết quả an toàn', () => {
    const gitleaksReport = JSON.stringify([
      {
        Description: 'AWS Access Key',
        File: 'config/aws.ts',
        StartLine: 15,
        RuleID: 'aws-access-key',
        Secret: 'AKIAIOSFODNN7EXAMPLE',
        Match: 'AKIAIOSFODNN7EXAMPLE',
      },
    ]);

    const findings = parseGitleaksJson(gitleaksReport);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe('config/aws.ts');
    expect(findings[0]?.line).toBe(15);
    expect(findings[0]?.rule_id).toBe('aws-access-key');
    expect(findings[0]?.match_preview).not.toBe('AKIAIOSFODNN7EXAMPLE');
    expect(findings[0]?.match_preview).toContain('*');
  });

  it('Nghiệm thu 8: Kết quả thật được lưu vào SQLite (security_checks và secret_findings)', () => {
    taskRepo.create({ id: 'task-sec-db-1', title: 'Task with secrets DB verification' });

    const record = securityCheckRepo.create(
      {
        task_id: 'task-sec-db-1',
        repo_path: testRepoDir,
        passed: false,
        audit_passed: true,
        secret_passed: false,
        audit_high_critical_count: 0,
        secret_findings_count: 1,
        audit_summary: JSON.stringify({ total: 0 }),
        secret_summary: JSON.stringify({ findings: 1 }),
        raw_details: JSON.stringify({ note: 'Real result saved' }),
        duration_ms: 150,
      },
      [
        {
          rule_id: 'aws_access_key',
          description: 'AWS Key detected',
          file: 'src/aws.ts',
          line: 10,
          match_preview: 'AKIA************9999',
        },
      ],
    );

    expect(record.id).toBeDefined();
    expect(record.passed).toBe(false);

    // Verify persisted in SQLite
    const retrieved = securityCheckRepo.findById(record.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.task_id).toBe('task-sec-db-1');
    expect(retrieved?.audit_passed).toBe(true);
    expect(retrieved?.secret_passed).toBe(false);

    const findings = securityCheckRepo.findSecretFindingsByCheckId(record.id);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule_id).toBe('aws_access_key');
    expect(findings[0]?.file).toBe('src/aws.ts');
  });

  it('Nghiệm thu 9: Báo cáo kiểm định security_check tự động được lưu vào bảng reports', () => {
    taskRepo.create({ id: 'task-rep-check-1', title: 'Task with report verification' });
    runRepo.create({ id: 'run-sec-rep-1', task_id: 'task-rep-check-1', attempt: 1 });

    const record = securityCheckRepo.create({
      task_id: 'task-rep-check-1',
      run_id: 'run-sec-rep-1',
      repo_path: testRepoDir,
      passed: true,
      audit_passed: true,
      secret_passed: true,
      audit_high_critical_count: 0,
      secret_findings_count: 0,
    });

    const reports = reportRepo.findByRunId('run-sec-rep-1');
    const secReport = reports.find((r) => r.kind === 'security_check');
    expect(secReport).toBeDefined();

    const content = JSON.parse(secReport!.content);
    expect(content.security_check_id).toBe(record.id);
    expect(content.passed).toBe(true);
  });

  it('Nghiệm thu 10: Xóa Task tự động cascade xóa bản ghi security_checks và secret_findings', () => {
    taskRepo.create({ id: 'task-cascade-sec', title: 'Cascade Task' });

    const check = securityCheckRepo.create(
      {
        task_id: 'task-cascade-sec',
        repo_path: testRepoDir,
        passed: false,
        audit_passed: false,
        secret_passed: false,
        audit_high_critical_count: 1,
        secret_findings_count: 1,
      },
      [
        {
          rule_id: 'github_pat',
          description: 'Token',
          file: 'token.txt',
          line: 1,
          match_preview: 'ghp_***',
        },
      ],
    );

    expect(securityCheckRepo.findById(check.id)).not.toBeNull();
    taskRepo.delete('task-cascade-sec');
    expect(securityCheckRepo.findById(check.id)).toBeNull();
    expect(securityCheckRepo.findSecretFindingsByCheckId(check.id)).toHaveLength(0);
  });

  it('Nghiệm thu 11: REST API POST /api/quality/security-check và GET /api/quality/security-checks', async () => {
    const postRes = await app.inject({
      method: 'POST',
      url: '/api/quality/security-check',
      payload: {
        repoPath: testRepoDir,
        scanner: 'builtin',
      },
    });

    expect(postRes.statusCode).toBe(200);
    const postBody = JSON.parse(postRes.body);
    expect(postBody.data.id).toBeDefined();
    expect(postBody.data.passed).toBe(true);
    expect(postBody.data.audit.passed).toBe(true);
    expect(postBody.data.secrets.passed).toBe(true);

    const getRes = await app.inject({
      method: 'GET',
      url: '/api/quality/security-checks',
    });

    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.body);
    expect(getBody.data).toBeInstanceOf(Array);
    expect(getBody.data.length).toBeGreaterThanOrEqual(1);

    const singleRes = await app.inject({
      method: 'GET',
      url: `/api/quality/security-checks/${postBody.data.id}`,
    });
    expect(singleRes.statusCode).toBe(200);
    const singleBody = JSON.parse(singleRes.body);
    expect(singleBody.data.id).toBe(postBody.data.id);
  });

  it('Nghiệm thu 12: REST API POST /api/quality/audit và POST /api/quality/secrets/scan độc lập', async () => {
    const auditRes = await app.inject({
      method: 'POST',
      url: '/api/quality/audit',
      payload: {
        repoPath: testRepoDir,
      },
    });
    expect(auditRes.statusCode).toBe(200);
    const auditBody = JSON.parse(auditRes.body);
    expect(auditBody.data.passed).toBe(true);
    expect(auditBody.data.counts).toBeDefined();

    const secretRes = await app.inject({
      method: 'POST',
      url: '/api/quality/secrets/scan',
      payload: {
        diffContent: '+ const cleanVar = 42;\n',
      },
    });
    expect(secretRes.statusCode).toBe(200);
    const secretBody = JSON.parse(secretRes.body);
    expect(secretBody.data.passed).toBe(true);
    expect(secretBody.data.findings).toHaveLength(0);
  });

  it('Nghiệm thu 13: REST API POST /api/tasks/:id/security-check và GET /api/tasks/:id/security-checks', async () => {
    taskRepo.create({ id: 'task-api-sec-1', title: 'Task API Security Test' });

    const postTaskSec = await app.inject({
      method: 'POST',
      url: '/api/tasks/task-api-sec-1/security-check',
      payload: {
        repoPath: testRepoDir,
        scanner: 'builtin',
      },
    });

    expect(postTaskSec.statusCode).toBe(200);
    const postBody = JSON.parse(postTaskSec.body);
    expect(postBody.data.task_id).toBe('task-api-sec-1');
    expect(postBody.data.passed).toBe(true);

    const getTaskSec = await app.inject({
      method: 'GET',
      url: '/api/tasks/task-api-sec-1/security-checks',
    });

    expect(getTaskSec.statusCode).toBe(200);
    const getBody = JSON.parse(getTaskSec.body);
    expect(getBody.data).toBeInstanceOf(Array);
    expect(getBody.data).toHaveLength(1);
    expect(getBody.data[0]?.task_id).toBe('task-api-sec-1');
  });
});
