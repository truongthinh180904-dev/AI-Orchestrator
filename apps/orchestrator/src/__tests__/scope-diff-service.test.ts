import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  PlanRepository,
  ReportRepository,
  RunRepository,
} from '@ai-orchestrator/db';
import { ScopeDiffService } from '../services/scope-diff-service.js';

describe('ScopeDiffService & Task Scope Verification (Unit Tests)', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let planRepo: PlanRepository;
  let reportRepo: ReportRepository;
  let runRepo: RunRepository;
  let service: ScopeDiffService;
  let tmpRepoDir: string;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    planRepo = new PlanRepository(db);
    reportRepo = new ReportRepository(db);
    runRepo = new RunRepository(db);

    service = new ScopeDiffService({
      db,
      taskRepo,
      planRepo,
      reportRepo,
    });

    // Create real temporary git repo
    tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-diff-repo-'));
    execSync('git init -b main', { cwd: tmpRepoDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tmpRepoDir, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: tmpRepoDir, stdio: 'ignore' });

    fs.mkdirSync(path.join(tmpRepoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepoDir, 'src', 'allowed.ts'), 'export const initial = 1;\n');
    fs.writeFileSync(path.join(tmpRepoDir, 'src', 'other.ts'), 'export const other = 2;\n');
    execSync('git add . && git commit -m "initial commit"', { cwd: tmpRepoDir, stdio: 'ignore' });
  });

  afterEach(() => {
    fs.rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  describe('resolveTaskScope', () => {
    it('throws TASK_NOT_FOUND when task does not exist', () => {
      expect(() => service.resolveTaskScope('NON_EXISTENT')).toThrow(/not found/i);
    });

    it('resolves explicit task scope_files directly', () => {
      taskRepo.create({
        id: 'TASK-DIRECT',
        title: 'Direct Scope Task',
        repository: tmpRepoDir,
        scope_files: ['src/allowed.ts'],
      });

      const resolved = service.resolveTaskScope('TASK-DIRECT');
      expect(resolved.scopeFiles).toEqual(['src/allowed.ts']);
      expect(resolved.repoPath).toBe(path.resolve(tmpRepoDir));
    });

    it('resolves scope_files from plan when task scope_files is empty', () => {
      const plan = planRepo.create({
        id: 'PLAN-SCOPE-1',
        title: 'Plan with scopes',
        repository: tmpRepoDir,
        tasks: [
          {
            id: 'TASK-FROM-PLAN',
            title: 'Task from plan',
            scope_files: ['src/from-plan.ts', 'src/allowed.ts'],
            acceptance_criteria: ['Check scope'],
          },
        ],
      });

      taskRepo.create({
        id: 'TASK-FROM-PLAN',
        plan_id: plan.id,
        title: 'Task from plan',
        repository: tmpRepoDir,
        scope_files: [], // empty on task
      });

      const resolved = service.resolveTaskScope('TASK-FROM-PLAN');
      expect(resolved.scopeFiles).toEqual(['src/from-plan.ts', 'src/allowed.ts']);
    });
  });

  describe('compareScope & checkTaskScope', () => {
    it('returns clean scope when only allowed files are modified', async () => {
      taskRepo.create({
        id: 'TASK-CLEAN',
        title: 'Clean Task',
        repository: tmpRepoDir,
        scope_files: ['src/allowed.ts'],
      });

      // Modify allowed file
      fs.writeFileSync(
        path.join(tmpRepoDir, 'src', 'allowed.ts'),
        'export const initial = 1;\nexport const updated = 2;\n',
      );

      const result = await service.checkTaskScope('TASK-CLEAN');
      expect(result.isScopeClean).toBe(true);
      expect(result.outOfScopeFiles).toEqual([]);
      expect(result.inScopeFiles).toEqual(['src/allowed.ts']);
      expect(result.stats.totalChanged).toBe(1);
      expect(result.stats.inScopeCount).toBe(1);
      expect(result.stats.outOfScopeCount).toBe(0);
    });

    it('báo đúng file lạ khi có file sửa hoặc file mới ngoài phạm vi task', async () => {
      taskRepo.create({
        id: 'TASK-DIRTY',
        title: 'Dirty Task',
        repository: tmpRepoDir,
        scope_files: ['src/allowed.ts'],
      });

      // Sửa file trong phạm vi
      fs.writeFileSync(path.join(tmpRepoDir, 'src', 'allowed.ts'), 'export const modified = true;\n');

      // Sửa file ngoài phạm vi (file lạ 1)
      fs.writeFileSync(path.join(tmpRepoDir, 'src', 'other.ts'), 'export const hacked = true;\n');

      // Tạo file untracked mới ngoài phạm vi (file lạ 2)
      fs.writeFileSync(path.join(tmpRepoDir, 'alien.env'), 'SECRET_TOKEN=xyz\n');

      const result = await service.checkTaskScope('TASK-DIRTY');

      // Tiêu chí nghiệm thu cốt lõi: Báo đúng file lạ
      expect(result.isScopeClean).toBe(false);
      expect(result.outOfScopeFiles).toEqual(['alien.env', 'src/other.ts']);
      expect(result.inScopeFiles).toEqual(['src/allowed.ts']);
      expect(result.stats.totalChanged).toBe(3);
      expect(result.stats.inScopeCount).toBe(1);
      expect(result.stats.outOfScopeCount).toBe(2);
    });

    it('persists scope_diff report into database when runId is provided', async () => {
      taskRepo.create({
        id: 'TASK-WITH-RUN',
        title: 'Task with run',
        repository: tmpRepoDir,
        scope_files: ['src/allowed.ts'],
      });

      const run = runRepo.create({
        id: 'RUN-SCOPE-001',
        task_id: 'TASK-WITH-RUN',
        attempt: 1,
        status: 'RUNNING',
      });

      fs.writeFileSync(path.join(tmpRepoDir, 'src', 'allowed.ts'), 'updated\n');
      fs.writeFileSync(path.join(tmpRepoDir, 'alien.txt'), 'alien\n');

      const result = await service.checkTaskScope('TASK-WITH-RUN', { runId: run.id });
      expect(result.isScopeClean).toBe(false);
      expect(result.outOfScopeFiles).toEqual(['alien.txt']);

      // Kiểm tra bản ghi report trong SQLite
      const reports = reportRepo.findByRunId(run.id, { kind: 'scope_diff' });
      expect(reports).toHaveLength(1);
      expect(reports[0]?.kind).toBe('scope_diff');

      const parsedContent = JSON.parse(reports[0]!.content);
      expect(parsedContent.isScopeClean).toBe(false);
      expect(parsedContent.outOfScopeFiles).toEqual(['alien.txt']);
    });
  });

  describe('getTaskDiff', () => {
    it('returns raw unified diff and parsed file diffs for task UI viewer', async () => {
      taskRepo.create({
        id: 'TASK-VIEWER',
        title: 'Diff Viewer Task',
        repository: tmpRepoDir,
        scope_files: ['src/allowed.ts'],
      });

      fs.writeFileSync(path.join(tmpRepoDir, 'src', 'allowed.ts'), 'added line\n');

      const diff = await service.getTaskDiff('TASK-VIEWER');
      expect(diff.taskId).toBe('TASK-VIEWER');
      expect(diff.rawDiff).toContain('diff --git');
      expect(diff.rawDiff).toContain('src/allowed.ts');
      expect(diff.changedFiles).toEqual(['src/allowed.ts']);
      expect(diff.isScopeClean).toBe(true);
      expect(diff.fileDiffs).toHaveLength(1);
      expect(diff.fileDiffs[0]?.path).toBe('src/allowed.ts');
    });
  });
});
