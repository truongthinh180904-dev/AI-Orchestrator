import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ChildProcess } from 'node:child_process';
import type { AgentCommandInput } from '@ai-orchestrator/shared';
import { createDatabase, runMigrations, TaskRepository, FeatureRepository } from '@ai-orchestrator/db';
import { SecurityCheckService } from '../services/security-check-service.js';
import { ProcessAdapter, type ProcessHandle } from '../adapters/process-adapter.js';
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

describe('SecurityCheckService (apps/orchestrator)', () => {
  let db: ReturnType<typeof createDatabase>;
  let taskRepo: TaskRepository;
  let featureRepo: FeatureRepository;
  let tempDir: string;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    featureRepo = new FeatureRepository(db);

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-check-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs audit using ProcessAdapter and parses clean audit (PASS)', async () => {
    const mockAdapter = new MockProcessAdapter((cmd) => {
      expect(cmd.exe).toBe('pnpm');
      expect(cmd.args).toEqual(['audit', '--json']);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          advisories: {},
          metadata: {
            vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
          },
        }),
      };
    });

    const service = new SecurityCheckService({
      db,
      processAdapter: mockAdapter,
      defaultRepoPath: tempDir,
    });

    const audit = await service.runAudit({ repoPath: tempDir });
    expect(audit.passed).toBe(true);
    expect(audit.highOrCriticalCount).toBe(0);
    expect(audit.counts.total).toBe(0);
  });

  it('runs audit and detects high/critical vulnerabilities (FAIL)', async () => {
    const mockAdapter = new MockProcessAdapter(() => {
      return {
        exitCode: 1,
        stdout: JSON.stringify({
          advisories: {
            '1': {
              id: 1,
              title: 'Critical RCE vulnerability',
              module_name: 'bad-pkg',
              severity: 'critical',
            },
          },
          metadata: {
            vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1 },
          },
        }),
      };
    });

    const service = new SecurityCheckService({
      db,
      processAdapter: mockAdapter,
      defaultRepoPath: tempDir,
    });

    const audit = await service.runAudit({ repoPath: tempDir });
    expect(audit.passed).toBe(false);
    expect(audit.counts.critical).toBe(1);
    expect(audit.highOrCriticalCount).toBe(1);
  });

  it('detects gitleaks availability accurately', async () => {
    const mockAvailable = new MockProcessAdapter((cmd) => {
      if (cmd.exe === 'gitleaks' && cmd.args[0] === 'version') {
        return { exitCode: 0, stdout: 'v8.18.0' };
      }
      return { exitCode: 1 };
    });

    const service1 = new SecurityCheckService({ processAdapter: mockAvailable });
    expect(await service1.isGitleaksAvailable()).toBe(true);

    const mockUnavailable = new MockProcessAdapter(() => {
      throw new Error('spawn ENOENT');
    });

    const service2 = new SecurityCheckService({ processAdapter: mockUnavailable });
    expect(await service2.isGitleaksAvailable()).toBe(false);
  });

  it('scans diff content directly with built-in secret scanner', async () => {
    const service = new SecurityCheckService({ db });

    const diffClean = `
      + export function add(a: number, b: number) {
      +   return a + b;
      + }
    `;
    const cleanScan = await service.runSecretScan({ diffContent: diffClean });
    expect(cleanScan.passed).toBe(true);
    expect(cleanScan.findings).toHaveLength(0);

    const diffWithSecret = `
      + const AWS_TOKEN = "AKIA1234567890EXAMPLE";
      + const GITHUB_TOKEN = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    `;
    const dirtyScan = await service.runSecretScan({ diffContent: diffWithSecret });
    expect(dirtyScan.passed).toBe(false);
    expect(dirtyScan.findings.length).toBeGreaterThanOrEqual(2);
    expect(dirtyScan.findings[0]?.match_preview).toContain('*');
  });

  it('runs full security check, combines audit and secrets, and persists to SQLite', async () => {
    // Write clean file to tempDir
    fs.writeFileSync(path.join(tempDir, 'index.ts'), 'export const hello = "world";\n');

    const mockAdapter = new MockProcessAdapter((cmd) => {
      if (cmd.exe === 'gitleaks') {
        return { exitCode: 0, stdout: 'v8.0.0' };
      }
      // pnpm audit
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          advisories: {},
          metadata: {
            vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
          },
        }),
      };
    });

    const service = new SecurityCheckService({
      db,
      processAdapter: mockAdapter,
      defaultRepoPath: tempDir,
    });

    const result = await service.runSecurityCheck({
      repoPath: tempDir,
      scanner: 'builtin',
    });

    expect(result.passed).toBe(true);
    expect(result.audit_passed).toBe(true);
    expect(result.secret_passed).toBe(true);

    // Verify stored record in database
    const stored = service.getSecurityChecks();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe(result.id);
    expect(stored[0]?.passed).toBe(true);
  });

  it('executes checkTask and links security check result to task ID', async () => {
    featureRepo.create({ id: 'feat-svc-1', name: 'Task Security Feature' });
    taskRepo.create({ id: 'task-sec-svc-1', feature_id: 'feat-svc-1', title: 'Task Under Test' });

    fs.writeFileSync(path.join(tempDir, 'main.ts'), 'console.log("secure code");');

    const mockAdapter = new MockProcessAdapter(() => ({
      exitCode: 0,
      stdout: JSON.stringify({
        advisories: {},
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
        },
      }),
    }));

    const service = new SecurityCheckService({
      db,
      processAdapter: mockAdapter,
      defaultRepoPath: tempDir,
    });

    const result = await service.checkTask('task-sec-svc-1', {
      repoPath: tempDir,
      scanner: 'builtin',
    });

    expect(result.task_id).toBe('task-sec-svc-1');
    expect(result.passed).toBe(true);

    const taskChecks = service.getSecurityChecks({ task_id: 'task-sec-svc-1' });
    expect(taskChecks).toHaveLength(1);
    expect(taskChecks[0]?.task_id).toBe('task-sec-svc-1');
  });
});
