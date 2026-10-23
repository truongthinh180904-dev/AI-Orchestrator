import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  RunRepository,
  EventRepository,
} from '@ai-orchestrator/db';
import { TaskHistoryService } from '../services/task-history-service.js';
import { AppError } from '@ai-orchestrator/shared';

describe('TaskHistoryService (ORC-005)', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let runRepo: RunRepository;
  let eventRepo: EventRepository;
  let historyService: TaskHistoryService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    runRepo = new RunRepository(db);
    eventRepo = new EventRepository(db);
    historyService = new TaskHistoryService({ db });

    taskRepo.create({
      id: 'TASK-HIST-1',
      title: 'Historical Task Test',
      max_attempts: 3,
    });
  });

  describe('Checkpoint Management', () => {
    it('creates and retrieves checkpoints for a task and run', () => {
      const run = runRepo.create({
        id: 'run-cp-1',
        task_id: 'TASK-HIST-1',
        attempt: 1,
        status: 'RUNNING',
      });

      const cp = historyService.createCheckpoint({
        task_id: 'TASK-HIST-1',
        run_id: run.id,
        attempt: 1,
        step: 'init_workspace',
        status: 'COMPLETED',
        data: { commit: 'abc1234', branch: 'feat/test' },
      });

      expect(cp.id).toBeDefined();
      expect(cp.task_id).toBe('TASK-HIST-1');
      expect(cp.run_id).toBe(run.id);
      expect(cp.step).toBe('init_workspace');
      expect(cp.status).toBe('COMPLETED');
      expect(cp.data).toEqual({ commit: 'abc1234', branch: 'feat/test' });

      const checkpoints = historyService.getCheckpoints({ task_id: 'TASK-HIST-1' });
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0]?.id).toBe(cp.id);

      const runCheckpoints = historyService.getCheckpoints({ run_id: run.id });
      expect(runCheckpoints).toHaveLength(1);
      expect(runCheckpoints[0]?.id).toBe(cp.id);
    });

    it('retrieves the latest checkpoint for a task', () => {
      const run = runRepo.create({
        id: 'run-cp-2',
        task_id: 'TASK-HIST-1',
        attempt: 1,
        status: 'RUNNING',
      });

      historyService.createCheckpoint({
        task_id: 'TASK-HIST-1',
        run_id: run.id,
        attempt: 1,
        step: 'step_1',
        created_at: '2026-10-23T01:00:00.000Z',
      });

      historyService.createCheckpoint({
        task_id: 'TASK-HIST-1',
        run_id: run.id,
        attempt: 1,
        step: 'step_2',
        created_at: '2026-10-23T01:05:00.000Z',
      });

      const latest = historyService.getLatestCheckpoint('TASK-HIST-1');
      expect(latest).not.toBeNull();
      expect(latest?.step).toBe('step_2');
    });

    it('rejects checkpoint creation with non-existent task or run', () => {
      expect(() =>
        historyService.createCheckpoint({
          task_id: 'NON-EXISTENT',
          step: 'invalid',
        }),
      ).toThrow(AppError);

      expect(() =>
        historyService.createCheckpoint({
          task_id: 'TASK-HIST-1',
          run_id: 'non-existent-run',
          step: 'invalid',
        }),
      ).toThrow(AppError);
    });
  });

  describe('Report Management', () => {
    it('creates and lists reports for a run', () => {
      const run = runRepo.create({
        id: 'run-rep-1',
        task_id: 'TASK-HIST-1',
        attempt: 1,
        status: 'SUCCESS',
      });

      const report = historyService.createReport({
        run_id: run.id,
        kind: 'vitest_summary',
        content: '# 100% Passed',
      });

      expect(report.id).toBeDefined();
      expect(report.kind).toBe('vitest_summary');
      expect(report.content).toBe('# 100% Passed');

      const reports = historyService.getReports(run.id);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.id).toBe(report.id);
    });
  });

  describe('Lịch sử lần chạy (Attempt, Run, Kết quả)', () => {
    it('computes accurate run result summary for success and failure', () => {
      const successRun = runRepo.create({
        id: 'run-summary-success',
        task_id: 'TASK-HIST-1',
        attempt: 1,
        status: 'SUCCESS',
        exit_code: 0,
        started_at: '2026-10-23T02:00:00.000Z',
        finished_at: '2026-10-23T02:00:10.000Z',
      });

      eventRepo.create({
        run_id: successRun.id,
        seq: 1,
        type: 'stdout',
        payload: { text: 'All good' },
      });

      const result = historyService.computeRunResult(successRun);
      expect(result.outcome).toBe('SUCCESS');
      expect(result.success).toBe(true);
      expect(result.exit_code).toBe(0);
      expect(result.duration_ms).toBe(10000);
      expect(result.event_count).toBe(1);

      const failRun = runRepo.create({
        id: 'run-summary-fail',
        task_id: 'TASK-HIST-1',
        attempt: 2,
        status: 'ERROR',
        exit_code: 1,
        started_at: '2026-10-23T02:05:00.000Z',
        finished_at: '2026-10-23T02:05:05.000Z',
      });

      eventRepo.create({
        run_id: failRun.id,
        seq: 1,
        type: 'stderr',
        payload: { text: 'Fatal error: syntax error' },
      });

      const failResult = historyService.computeRunResult(failRun);
      expect(failResult.outcome).toBe('ERROR');
      expect(failResult.success).toBe(false);
      expect(failResult.exit_code).toBe(1);
      expect(failResult.duration_ms).toBe(5000);
      expect(failResult.error_message).toBe('Fatal error: syntax error');
    });

    it('getTaskRunHistory compiles multi-attempt chronological history', () => {
      // Attempt 1: Failed
      const run1 = runRepo.create({
        id: 'run-hist-attempt-1',
        task_id: 'TASK-HIST-1',
        attempt: 1,
        status: 'ERROR',
        exit_code: 1,
        started_at: '2026-10-23T01:00:00.000Z',
        finished_at: '2026-10-23T01:00:05.000Z',
      });

      historyService.createCheckpoint({
        task_id: 'TASK-HIST-1',
        run_id: run1.id,
        attempt: 1,
        step: 'step_attempt_1',
      });

      // Attempt 2: Success
      const run2 = runRepo.create({
        id: 'run-hist-attempt-2',
        task_id: 'TASK-HIST-1',
        attempt: 2,
        status: 'SUCCESS',
        exit_code: 0,
        started_at: '2026-10-23T01:10:00.000Z',
        finished_at: '2026-10-23T01:10:15.000Z',
      });

      historyService.createCheckpoint({
        task_id: 'TASK-HIST-1',
        run_id: run2.id,
        attempt: 2,
        step: 'step_attempt_2',
      });

      historyService.createReport({
        run_id: run2.id,
        kind: 'completion_report',
        content: 'Task completed successfully in attempt 2',
      });

      taskRepo.update('TASK-HIST-1', {
        status: 'DONE',
        attempts: 2,
      });

      const fullHistory = historyService.getTaskRunHistory('TASK-HIST-1');
      expect(fullHistory.taskId).toBe('TASK-HIST-1');
      expect(fullHistory.attempts).toBe(2);
      expect(fullHistory.maxAttempts).toBe(3);
      expect(fullHistory.latestRun?.id).toBe(run2.id);
      expect(fullHistory.history).toHaveLength(2);

      // Attempt 1 item
      const item1 = fullHistory.history[0];
      expect(item1?.attempt).toBe(1);
      expect(item1?.run.id).toBe(run1.id);
      expect(item1?.result.success).toBe(false);
      expect(item1?.result.outcome).toBe('ERROR');
      expect(item1?.checkpoints).toHaveLength(1);
      expect(item1?.checkpoints[0]?.step).toBe('step_attempt_1');

      // Attempt 2 item
      const item2 = fullHistory.history[1];
      expect(item2?.attempt).toBe(2);
      expect(item2?.run.id).toBe(run2.id);
      expect(item2?.result.success).toBe(true);
      expect(item2?.result.outcome).toBe('SUCCESS');
      expect(item2?.checkpoints).toHaveLength(1);
      expect(item2?.checkpoints[0]?.step).toBe('step_attempt_2');
      expect(item2?.reports).toHaveLength(1);
      expect(item2?.reports[0]?.kind).toBe('completion_report');
    });
  });

  describe('Nghiệm thu: "Truy lại từng run"', () => {
    it('getRunDetail retrieves complete deep run inspection for any specific run ID', () => {
      const run = runRepo.create({
        id: 'run-deep-inspect',
        task_id: 'TASK-HIST-1',
        attempt: 2,
        status: 'SUCCESS',
        exit_code: 0,
        pid: 12345,
        started_at: '2026-10-23T03:00:00.000Z',
        finished_at: '2026-10-23T03:00:20.000Z',
        branch: 'dev',
        commit_sha: 'commit_sha_xyz',
      });

      // Add checkpoints
      historyService.createCheckpoint({
        task_id: 'TASK-HIST-1',
        run_id: run.id,
        attempt: 2,
        step: 'deep_step_1',
        data: { phase: 'preparation' },
      });
      historyService.createCheckpoint({
        task_id: 'TASK-HIST-1',
        run_id: run.id,
        attempt: 2,
        step: 'deep_step_2',
        data: { phase: 'execution' },
      });

      // Add report
      historyService.createReport({
        run_id: run.id,
        kind: 'code_quality_report',
        content: 'No issues found',
      });

      // Add events
      eventRepo.create({ run_id: run.id, seq: 1, type: 'init', payload: { started: true } });
      eventRepo.create({ run_id: run.id, seq: 2, type: 'stdout', payload: { text: 'Running tests' } });
      eventRepo.create({ run_id: run.id, seq: 3, type: 'stdout', payload: { text: 'Passed 5 tests' } });
      eventRepo.create({ run_id: run.id, seq: 4, type: 'result', payload: { status: 'SUCCESS' } });

      // Truy lại run
      const detail = historyService.getRunDetail(run.id);

      expect(detail.run.id).toBe('run-deep-inspect');
      expect(detail.run.attempt).toBe(2);
      expect(detail.run.status).toBe('SUCCESS');
      expect(detail.run.exit_code).toBe(0);
      expect(detail.run.pid).toBe(12345);
      expect(detail.run.commit_sha).toBe('commit_sha_xyz');

      expect(detail.task?.id).toBe('TASK-HIST-1');
      expect(detail.task?.title).toBe('Historical Task Test');

      expect(detail.result.outcome).toBe('SUCCESS');
      expect(detail.result.success).toBe(true);
      expect(detail.result.duration_ms).toBe(20000);
      expect(detail.result.checkpoint_count).toBe(2);
      expect(detail.result.report_count).toBe(1);
      expect(detail.result.event_count).toBe(4);

      expect(detail.checkpoints).toHaveLength(2);
      expect(detail.checkpoints.map((c) => c.step)).toEqual(['deep_step_1', 'deep_step_2']);

      expect(detail.reports).toHaveLength(1);
      expect(detail.reports[0]?.kind).toBe('code_quality_report');

      expect(detail.events).toHaveLength(4);
      expect(detail.eventStats.total).toBe(4);
      expect(detail.eventStats.byType).toEqual({
        init: 1,
        stdout: 2,
        result: 1,
      });
    });

    it('throws RUN_NOT_FOUND when inspecting non-existent run', () => {
      expect(() => historyService.getRunDetail('non-existent-run-id')).toThrow(AppError);
    });
  });
});
