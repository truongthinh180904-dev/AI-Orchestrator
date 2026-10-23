import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrator.js';
import { SecurityCheckRepository } from '../repositories/security-check-repository.js';
import { TaskRepository } from '../repositories/task-repository.js';
import { FeatureRepository } from '../repositories/feature-repository.js';
import { RunRepository } from '../repositories/run-repository.js';
import { ReportRepository } from '../repositories/report-repository.js';
import type { SecretFinding } from '@ai-orchestrator/shared';

describe('SecurityCheckRepository (packages/db)', () => {
  let db: Database.Database;
  let repo: SecurityCheckRepository;
  let taskRepo: TaskRepository;
  let featureRepo: FeatureRepository;
  let runRepo: RunRepository;
  let reportRepo: ReportRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);

    repo = new SecurityCheckRepository(db);
    taskRepo = new TaskRepository(db);
    featureRepo = new FeatureRepository(db);
    runRepo = new RunRepository(db);
    reportRepo = new ReportRepository(db);
  });

  it('runs migrations idempotently including migration 009', () => {
    // Running a second time should not throw
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('creates and retrieves a clean security check record', () => {
    const created = repo.create({
      repo_path: '/repos/test-project',
      passed: true,
      audit_passed: true,
      secret_passed: true,
      audit_high_critical_count: 0,
      secret_findings_count: 0,
      audit_summary: JSON.stringify({ total: 0 }),
      secret_summary: JSON.stringify({ scanner: 'builtin', files_scanned: 15 }),
      raw_details: JSON.stringify({ summary: 'All clean' }),
      duration_ms: 125,
    });

    expect(created.id).toBeDefined();
    expect(created.passed).toBe(true);
    expect(created.audit_passed).toBe(true);
    expect(created.secret_passed).toBe(true);
    expect(created.repo_path).toBe('/repos/test-project');

    const found = repo.findById(created.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(created.id);
    expect(found?.passed).toBe(true);
  });

  it('stores secret findings linked to security check and task', () => {
    featureRepo.create({ id: 'feat-sec-1', name: 'Security Feature' });
    taskRepo.create({ id: 'task-sec-1', feature_id: 'feat-sec-1', title: 'Task with secrets' });

    const findings: SecretFinding[] = [
      {
        rule_id: 'aws_access_key',
        description: 'AWS key detected',
        file: 'src/aws.ts',
        line: 12,
        match_preview: 'AKIA************3456',
        secret_hash: 'abc123hash',
      },
      {
        rule_id: 'github_pat',
        description: 'GitHub token detected',
        file: 'src/github.ts',
        line: 25,
        match_preview: 'ghp_************xyz1',
      },
    ];

    const check = repo.create(
      {
        task_id: 'task-sec-1',
        repo_path: '/repos/test-project',
        passed: false,
        audit_passed: true,
        secret_passed: false,
        audit_high_critical_count: 0,
        secret_findings_count: 2,
      },
      findings,
    );

    expect(check.passed).toBe(false);
    expect(check.secret_findings_count).toBe(2);

    const storedFindings = repo.findSecretFindingsByCheckId(check.id);
    expect(storedFindings).toHaveLength(2);
    expect(storedFindings[0]?.rule_id).toBe('aws_access_key');
    expect(storedFindings[0]?.file).toBe('src/aws.ts');
    expect(storedFindings[1]?.rule_id).toBe('github_pat');

    const taskFindings = repo.findSecretFindingsByTaskId('task-sec-1');
    expect(taskFindings).toHaveLength(2);
  });

  it('automatically creates a report entry in reports table when run_id is supplied', () => {
    featureRepo.create({ id: 'feat-rep-1', name: 'Reporting Feature' });
    taskRepo.create({ id: 'task-rep-1', feature_id: 'feat-rep-1', title: 'Reporting Task' });
    runRepo.create({ id: 'run-rep-1', task_id: 'task-rep-1', attempt: 1 });

    const check = repo.create({
      task_id: 'task-rep-1',
      run_id: 'run-rep-1',
      repo_path: '/repos/test-project',
      passed: true,
      audit_passed: true,
      secret_passed: true,
      audit_high_critical_count: 0,
      secret_findings_count: 0,
    });

    const reports = reportRepo.findByRunId('run-rep-1');
    const secReport = reports.find((r) => r.kind === 'security_check');
    expect(secReport).toBeDefined();

    const parsed = JSON.parse(secReport!.content);
    expect(parsed.security_check_id).toBe(check.id);
    expect(parsed.passed).toBe(true);
  });

  it('cascades deletion when parent task is deleted', () => {
    featureRepo.create({ id: 'feat-cas-1', name: 'Cascade Feature' });
    taskRepo.create({ id: 'task-cas-1', feature_id: 'feat-cas-1', title: 'Cascade Task' });

    const check = repo.create(
      {
        task_id: 'task-cas-1',
        repo_path: '/repos/test',
        passed: false,
        audit_passed: true,
        secret_passed: false,
        audit_high_critical_count: 0,
        secret_findings_count: 1,
      },
      [
        {
          rule_id: 'private_key',
          description: 'Key',
          file: 'key.pem',
          line: 1,
          match_preview: '---***---',
        },
      ],
    );

    expect(repo.findById(check.id)).not.toBeNull();
    expect(repo.findSecretFindingsByCheckId(check.id)).toHaveLength(1);

    // Delete the task
    taskRepo.delete('task-cas-1');

    expect(repo.findById(check.id)).toBeNull();
    expect(repo.findSecretFindingsByCheckId(check.id)).toHaveLength(0);
  });

  it('supports filtering and counting security checks', () => {
    repo.create({
      repo_path: '/repos/test-1',
      passed: true,
      audit_passed: true,
      secret_passed: true,
    });

    repo.create({
      repo_path: '/repos/test-2',
      passed: false,
      audit_passed: false,
      secret_passed: true,
    });

    expect(repo.count()).toBe(2);
    expect(repo.count({ passed: true })).toBe(1);
    expect(repo.count({ passed: false })).toBe(1);

    const passedChecks = repo.find({ passed: true });
    expect(passedChecks).toHaveLength(1);
    expect(passedChecks[0]?.passed).toBe(true);
  });
});
