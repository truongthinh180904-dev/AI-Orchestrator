import { describe, expect, it, vi } from 'vitest';
import { createDatabase, runMigrations, TaskRepository, ReportRepository, RunRepository } from '../packages/db/src/index.js';
import type { QualityPipelineResult, ReviewResult } from '../packages/shared/src/index.js';
import { RepairLoopService } from '../apps/orchestrator/src/services/repair-loop-service.js';
import { QualityRunner } from '../apps/orchestrator/src/services/quality-runner.js';
import { ReviewerService } from '../apps/orchestrator/src/services/reviewer-service.js';
import { buildServer } from '../apps/orchestrator/src/server.js';

describe('QLT-006: Vòng sửa có giới hạn (max N) — Hết lượt thì dừng, FAILED', () => {
  function setupTestEnv() {
    const db = createDatabase(':memory:');
    runMigrations(db);

    const taskRepo = new TaskRepository(db);
    const reportRepo = new ReportRepository(db);

    const now = new Date().toISOString();
    taskRepo.create({
      id: 'TASK-QLT6-TEST',
      title: 'Fix edge case in calculation logic',
      acceptance_criteria: ['All unit tests pass', 'Code review has no critical/high issues'],
      test_commands: ['pnpm test'],
      status: 'VERIFYING',
      created_at: now,
      updated_at: now,
    });

    const mockQualityRunner = new QualityRunner({ db });
    const mockReviewerService = new ReviewerService({ db });

    const repairLoopService = new RepairLoopService({
      db,
      qualityRunner: mockQualityRunner,
      reviewerService: mockReviewerService,
    });

    return { db, taskRepo, reportRepo, repairLoopService, mockQualityRunner, mockReviewerService };
  }

  it('Nghiệm thu 1: Hết lượt thì dừng, FAILED — dừng chính xác khi hết max N lượt và chuyển trạng thái task FAILED', async () => {
    const { db, taskRepo, repairLoopService, mockReviewerService } = setupTestEnv();
    try {
      // Mock verification pipeline to always fail
      vi.spyOn(repairLoopService, 'executeVerificationPipeline').mockResolvedValue({
        task_id: 'TASK-QLT6-TEST',
        run_id: null,
        repo_path: '.',
        success: false,
        total_commands: 1,
        passed_commands: 0,
        failed_commands: 1,
        skipped_commands: 0,
        duration_ms: 15,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        records: [
          {
            id: 'rec-test-failed',
            task_id: 'TASK-QLT6-TEST',
            run_id: null,
            stage: 'test',
            command_id: 'cmd-test',
            name: 'Unit Tests',
            command: 'pnpm test',
            exe: 'pnpm',
            args: ['test'],
            cwd: '.',
            exit_code: 1,
            signal: null,
            status: 'FAILURE',
            stdout: '',
            stderr: 'FAIL src/math.test.ts: Expected 42 but received 41',
            duration_ms: 12,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      } as QualityPipelineResult);

      vi.spyOn(mockReviewerService, 'reviewTask').mockResolvedValue({
        id: 'rev-pass',
        task_id: 'TASK-QLT6-TEST',
        run_id: null,
        passed: true,
        stats: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        findings: [],
        summary: 'No issues found',
        raw_output: '[]',
        reviewed_at: new Date().toISOString(),
        reviewer_type: 'agy',
      } as ReviewResult);

      let attemptsCount = 0;
      const result = await repairLoopService.runRepairCycle({
        taskId: 'TASK-QLT6-TEST',
        maxIterations: 3,
        executeFix: async () => {
          attemptsCount++;
          return { success: true };
        },
      });

      // Verification of acceptance criteria: "Hết lượt thì dừng, FAILED"
      expect(result.passed).toBe(false);
      expect(result.status).toBe('FAILED');
      expect(result.totalIterations).toBe(3);
      expect(result.maxIterations).toBe(3);
      expect(result.finalReason).toBe('MAX_REPAIR_ITERATIONS_EXCEEDED');
      expect(attemptsCount).toBe(3); // Stopped after 3 attempts without looping infinitely

      // Task status must be FAILED
      const task = taskRepo.findById('TASK-QLT6-TEST');
      expect(task?.status).toBe('FAILED');

      // Repair loop status in SQLite
      const loop = repairLoopService.getRepairLoop(result.loopId);
      expect(loop?.status).toBe('FAILED');
      expect(loop?.passed).toBe(false);
      expect(loop?.current_iteration).toBe(3);
      expect(loop?.iterations).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it('Nghiệm thu 2: Dừng sớm và PASSED khi một iteration sửa thành công lỗi trước khi hết lượt', async () => {
    const { db, taskRepo, repairLoopService, mockReviewerService } = setupTestEnv();
    try {
      let callCount = 0;
      vi.spyOn(repairLoopService, 'executeVerificationPipeline').mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          // Initial check (1) and iteration 1 (2) fail
          return {
            task_id: 'TASK-QLT6-TEST',
            run_id: null,
            repo_path: '.',
            success: false,
            total_commands: 1,
            passed_commands: 0,
            failed_commands: 1,
            skipped_commands: 0,
            duration_ms: 10,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            records: [
              {
                id: 'rec-fail-1',
                task_id: 'TASK-QLT6-TEST',
                run_id: null,
                stage: 'test',
                command_id: 'cmd-test',
                name: 'Unit Tests',
                command: 'pnpm test',
                exe: 'pnpm',
                args: ['test'],
                cwd: '.',
                exit_code: 1,
                signal: null,
                status: 'FAILURE',
                stdout: '',
                stderr: 'Assertion failed',
                duration_ms: 10,
                started_at: new Date().toISOString(),
                finished_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
              },
            ],
          } as QualityPipelineResult;
        } else {
          // Iteration 2 passes!
          return {
            task_id: 'TASK-QLT6-TEST',
            run_id: null,
            repo_path: '.',
            success: true,
            total_commands: 1,
            passed_commands: 1,
            failed_commands: 0,
            skipped_commands: 0,
            duration_ms: 10,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            records: [
              {
                id: 'rec-pass-2',
                task_id: 'TASK-QLT6-TEST',
                run_id: null,
                stage: 'test',
                command_id: 'cmd-test',
                name: 'Unit Tests',
                command: 'pnpm test',
                exe: 'pnpm',
                args: ['test'],
                cwd: '.',
                exit_code: 0,
                signal: null,
                status: 'SUCCESS',
                stdout: 'All 12 tests passed',
                stderr: '',
                duration_ms: 10,
                started_at: new Date().toISOString(),
                finished_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
              },
            ],
          } as QualityPipelineResult;
        }
      });

      vi.spyOn(mockReviewerService, 'reviewTask').mockResolvedValue({
        id: 'rev-pass',
        task_id: 'TASK-QLT6-TEST',
        run_id: null,
        passed: true,
        stats: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        findings: [],
        summary: 'Clean diff',
        raw_output: '[]',
        reviewed_at: new Date().toISOString(),
        reviewer_type: 'agy',
      } as ReviewResult);

      let fixCalls = 0;
      const result = await repairLoopService.runRepairCycle({
        taskId: 'TASK-QLT6-TEST',
        maxIterations: 5, // Allowed up to 5
        executeFix: async () => {
          fixCalls++;
          return { success: true };
        },
      });

      // Stopped cleanly at iteration 2; did not run iterations 3, 4, 5
      expect(result.passed).toBe(true);
      expect(result.status).toBe('PASSED');
      expect(result.totalIterations).toBe(2);
      expect(fixCalls).toBe(2);

      // Task status should remain VERIFYING (not FAILED)
      const task = taskRepo.findById('TASK-QLT6-TEST');
      expect(task?.status).toBe('VERIFYING');
    } finally {
      db.close();
    }
  });

  it('Nghiệm thu 3: Cấu hình giới hạn số lượt N linh hoạt (N = 1, N = 2)', async () => {
    const { db, repairLoopService, mockReviewerService } = setupTestEnv();
    try {
      vi.spyOn(repairLoopService, 'executeVerificationPipeline').mockResolvedValue({
        task_id: 'TASK-QLT6-TEST',
        run_id: null,
        repo_path: '.',
        success: false,
        total_commands: 1,
        passed_commands: 0,
        failed_commands: 1,
        skipped_commands: 0,
        duration_ms: 5,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        records: [
          {
            id: 'rec-fail-const',
            task_id: 'TASK-QLT6-TEST',
            run_id: null,
            stage: 'lint',
            command_id: 'cmd-lint',
            name: 'Lint',
            command: 'pnpm lint',
            exe: 'pnpm',
            args: ['lint'],
            cwd: '.',
            exit_code: 1,
            signal: null,
            status: 'FAILURE',
            stdout: '',
            stderr: 'Lint failure',
            duration_ms: 5,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      } as QualityPipelineResult);

      vi.spyOn(mockReviewerService, 'reviewTask').mockResolvedValue({
        id: 'rev-pass',
        task_id: 'TASK-QLT6-TEST',
        run_id: null,
        passed: true,
        stats: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        findings: [],
        summary: 'Review OK',
        raw_output: '[]',
        reviewed_at: new Date().toISOString(),
        reviewer_type: 'agy',
      } as ReviewResult);

      // Test with maxIterations = 1
      let count1 = 0;
      const res1 = await repairLoopService.runRepairCycle({
        taskId: 'TASK-QLT6-TEST',
        maxIterations: 1,
        executeFix: async () => {
          count1++;
          return { success: true };
        },
      });
      expect(count1).toBe(1);
      expect(res1.totalIterations).toBe(1);
      expect(res1.status).toBe('FAILED');

      // Test with maxIterations = 2
      let count2 = 0;
      const res2 = await repairLoopService.runRepairCycle({
        taskId: 'TASK-QLT6-TEST',
        maxIterations: 2,
        executeFix: async () => {
          count2++;
          return { success: true };
        },
      });
      expect(count2).toBe(2);
      expect(res2.totalIterations).toBe(2);
      expect(res2.status).toBe('FAILED');
    } finally {
      db.close();
    }
  });

  it('Nghiệm thu 4: Bóc tách và truyền tải đầy đủ command failures và reviewer findings vào repair prompt', async () => {
    const { db, repairLoopService, mockReviewerService } = setupTestEnv();
    try {
      vi.spyOn(repairLoopService, 'executeVerificationPipeline').mockResolvedValue({
        task_id: 'TASK-QLT6-TEST',
        run_id: null,
        repo_path: '.',
        success: false,
        total_commands: 1,
        passed_commands: 0,
        failed_commands: 1,
        skipped_commands: 0,
        duration_ms: 5,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        records: [
          {
            id: 'rec-tc',
            task_id: 'TASK-QLT6-TEST',
            run_id: null,
            stage: 'typecheck',
            command_id: 'tc-1',
            name: 'TypeScript',
            command: 'tsc --noEmit',
            exe: 'tsc',
            args: ['--noEmit'],
            cwd: '.',
            exit_code: 2,
            signal: null,
            status: 'FAILURE',
            stdout: '',
            stderr: 'src/calc.ts:24: Argument of type string is not assignable to number',
            duration_ms: 5,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      } as QualityPipelineResult);

      vi.spyOn(mockReviewerService, 'reviewTask').mockResolvedValue({
        id: 'rev-fail',
        task_id: 'TASK-QLT6-TEST',
        run_id: null,
        passed: false,
        stats: { total: 1, critical: 1, high: 0, medium: 0, low: 0, info: 0 },
        findings: [
          {
            severity: 'critical',
            file: 'src/calc.ts',
            line: 45,
            message: 'Division by zero without guard clause',
            suggestion: 'Add if (denominator === 0) throw new AppError(...)',
          },
        ],
        summary: '1 critical finding',
        raw_output: '[]',
        reviewed_at: new Date().toISOString(),
        reviewer_type: 'agy',
      } as ReviewResult);

      let promptReceived = '';
      await repairLoopService.runRepairCycle({
        taskId: 'TASK-QLT6-TEST',
        maxIterations: 1,
        executeFix: async (_iter, prompt) => {
          promptReceived = prompt;
          return { success: true };
        },
      });

      expect(promptReceived).toContain('REPAIR REQUEST (Iteration 1 of 1)');
      expect(promptReceived).toContain('tsc --noEmit');
      expect(promptReceived).toContain('Argument of type string is not assignable to number');
      expect(promptReceived).toContain('**[CRITICAL]** at `src/calc.ts:45`: Division by zero without guard clause');
      expect(promptReceived).toContain('Add if (denominator === 0) throw new AppError(...)');
    } finally {
      db.close();
    }
  });

  it('Nghiệm thu 5: Tuân thủ chính sách Quality Gate (SKILL-testing): không pass nếu còn finding high/critical', async () => {
    const { db, repairLoopService, mockReviewerService } = setupTestEnv();
    try {
      // All commands pass
      vi.spyOn(repairLoopService, 'executeVerificationPipeline').mockResolvedValue({
        task_id: 'TASK-QLT6-TEST',
        run_id: null,
        repo_path: '.',
        success: true,
        total_commands: 1,
        passed_commands: 1,
        failed_commands: 0,
        skipped_commands: 0,
        duration_ms: 5,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        records: [
          {
            id: 'rec-test-pass',
            task_id: 'TASK-QLT6-TEST',
            run_id: null,
            stage: 'test',
            command_id: 'cmd-test',
            name: 'Unit Test',
            command: 'pnpm test',
            exe: 'pnpm',
            args: ['test'],
            cwd: '.',
            exit_code: 0,
            signal: null,
            status: 'SUCCESS',
            stdout: 'OK',
            stderr: '',
            duration_ms: 5,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      } as QualityPipelineResult);

      // But reviewer reports a HIGH severity finding
      vi.spyOn(mockReviewerService, 'reviewTask').mockResolvedValue({
        id: 'rev-high',
        task_id: 'TASK-QLT6-TEST',
        run_id: null,
        passed: false,
        stats: { total: 1, critical: 0, high: 1, medium: 0, low: 0, info: 0 },
        findings: [
          {
            severity: 'high',
            file: 'src/auth.ts',
            line: 12,
            message: 'Insecure cookie configuration missing HttpOnly flag',
          },
        ],
        summary: '1 high finding',
        raw_output: '[]',
        reviewed_at: new Date().toISOString(),
        reviewer_type: 'agy',
      } as ReviewResult);

      const result = await repairLoopService.runRepairCycle({
        taskId: 'TASK-QLT6-TEST',
        maxIterations: 1,
        executeFix: async () => ({ success: true }),
      });

      // Must FAIL because high severity finding exists
      expect(result.passed).toBe(false);
      expect(result.status).toBe('FAILED');
    } finally {
      db.close();
    }
  });

  it('Nghiệm thu 6: Lưu vết toàn diện vào SQLite (repair_loops, repair_iterations, reports)', async () => {
    const { db, repairLoopService, reportRepo, mockReviewerService } = setupTestEnv();
    try {
      vi.spyOn(repairLoopService, 'executeVerificationPipeline').mockResolvedValue({
        task_id: 'TASK-QLT6-TEST',
        run_id: null,
        repo_path: '.',
        success: false,
        total_commands: 1,
        passed_commands: 0,
        failed_commands: 1,
        skipped_commands: 0,
        duration_ms: 10,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        records: [
          {
            id: 'rec-test-f',
            task_id: 'TASK-QLT6-TEST',
            run_id: null,
            stage: 'test',
            command_id: 't-1',
            name: 'Test',
            command: 'pnpm test',
            exe: 'pnpm',
            args: ['test'],
            cwd: '.',
            exit_code: 1,
            signal: null,
            status: 'FAILURE',
            stdout: '',
            stderr: 'Fail',
            duration_ms: 5,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      } as QualityPipelineResult);

      vi.spyOn(mockReviewerService, 'reviewTask').mockResolvedValue({
        id: 'rev-p',
        task_id: 'TASK-QLT6-TEST',
        run_id: null,
        passed: true,
        stats: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        findings: [],
        summary: 'OK',
        raw_output: '[]',
        reviewed_at: new Date().toISOString(),
        reviewer_type: 'agy',
      } as ReviewResult);

      const runRepo = new RunRepository(db);
      runRepo.create({
        id: 'RUN-QLT6-AUDIT',
        task_id: 'TASK-QLT6-TEST',
        status: 'RUNNING',
        started_at: new Date().toISOString(),
      });

      const result = await repairLoopService.runRepairCycle({
        taskId: 'TASK-QLT6-TEST',
        runId: 'RUN-QLT6-AUDIT',
        maxIterations: 2,
        executeFix: async () => ({ success: true }),
      });

      // 1. Check repair_loops record in DB
      const loop = repairLoopService.getRepairLoop(result.loopId);
      expect(loop).not.toBeNull();
      expect(loop?.id).toBe(result.loopId);
      expect(loop?.task_id).toBe('TASK-QLT6-TEST');
      expect(loop?.status).toBe('FAILED');
      expect(loop?.current_iteration).toBe(2);

      // 2. Check repair_iterations records in DB
      const iterations = loop?.iterations ?? [];
      expect(iterations).toHaveLength(2);
      expect(iterations[0]?.iteration_number).toBe(1);
      expect(iterations[1]?.iteration_number).toBe(2);
      expect(iterations[0]?.status).toBe('FAILED');

      // 3. Check reports record
      const reports = reportRepo.findByRunId('RUN-QLT6-AUDIT');
      const repairReport = reports.find((r) => r.kind === 'repair_loop');
      expect(repairReport).toBeDefined();
      const reportData = JSON.parse(repairReport!.content) as { loop_id: string; status: string };
      expect(reportData.loop_id).toBe(result.loopId);
      expect(reportData.status).toBe('FAILED');
    } finally {
      db.close();
    }
  });

  it('Nghiệm thu 7: Ràng buộc toàn vẹn & Cascade Delete khi xóa task', async () => {
    const { db, taskRepo, repairLoopService, mockReviewerService } = setupTestEnv();
    try {
      vi.spyOn(repairLoopService, 'executeVerificationPipeline').mockResolvedValue({
        task_id: 'TASK-QLT6-TEST',
        run_id: null,
        repo_path: '.',
        success: false,
        total_commands: 1,
        passed_commands: 0,
        failed_commands: 1,
        skipped_commands: 0,
        duration_ms: 5,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        records: [],
      } as QualityPipelineResult);

      vi.spyOn(mockReviewerService, 'reviewTask').mockResolvedValue({
        id: 'rev-p',
        task_id: 'TASK-QLT6-TEST',
        run_id: null,
        passed: true,
        stats: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        findings: [],
        summary: 'OK',
        raw_output: '[]',
        reviewed_at: new Date().toISOString(),
        reviewer_type: 'agy',
      } as ReviewResult);

      const result = await repairLoopService.runRepairCycle({
        taskId: 'TASK-QLT6-TEST',
        maxIterations: 1,
        executeFix: async () => ({ success: true }),
      });

      expect(repairLoopService.getRepairLoop(result.loopId)).not.toBeNull();

      // Delete task
      taskRepo.delete('TASK-QLT6-TEST');

      // Loop record and iteration records should be deleted via cascade
      expect(repairLoopService.getRepairLoop(result.loopId)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('Nghiệm thu 8: REST API endpoints POST /api/quality/repair-loop và GET /api/quality/repair-loops/:id', async () => {
    const { db, repairLoopService, mockReviewerService } = setupTestEnv();
    const server = await buildServer({
      db,
      repairLoopService,
    });

    try {
      vi.spyOn(repairLoopService, 'executeVerificationPipeline').mockResolvedValue({
        task_id: 'TASK-QLT6-TEST',
        run_id: null,
        repo_path: '.',
        success: true,
        total_commands: 1,
        passed_commands: 1,
        failed_commands: 0,
        skipped_commands: 0,
        duration_ms: 10,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        records: [
          {
            id: 'rec-api-pass',
            task_id: 'TASK-QLT6-TEST',
            run_id: null,
            stage: 'test',
            command_id: 'api-cmd',
            name: 'API Test',
            command: 'pnpm test',
            exe: 'pnpm',
            args: ['test'],
            cwd: '.',
            exit_code: 0,
            signal: null,
            status: 'SUCCESS',
            stdout: 'Pass',
            stderr: '',
            duration_ms: 5,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      } as QualityPipelineResult);

      vi.spyOn(mockReviewerService, 'reviewTask').mockResolvedValue({
        id: 'rev-api-pass',
        task_id: 'TASK-QLT6-TEST',
        run_id: null,
        passed: true,
        stats: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        findings: [],
        summary: 'All pass',
        raw_output: '[]',
        reviewed_at: new Date().toISOString(),
        reviewer_type: 'agy',
      } as ReviewResult);

      // 1. POST /api/quality/repair-loop
      const postRes = await server.inject({
        method: 'POST',
        url: '/api/quality/repair-loop',
        payload: {
          taskId: 'TASK-QLT6-TEST',
          maxIterations: 2,
        },
      });

      expect(postRes.statusCode).toBe(200);
      const postBody = JSON.parse(postRes.body) as { data: { loopId: string; passed: boolean; status: string } };
      expect(postBody.data.passed).toBe(true);
      expect(postBody.data.status).toBe('PASSED');
      const loopId = postBody.data.loopId;

      // 2. GET /api/quality/repair-loops/:id
      const getRes = await server.inject({
        method: 'GET',
        url: `/api/quality/repair-loops/${loopId}`,
      });

      expect(getRes.statusCode).toBe(200);
      const getBody = JSON.parse(getRes.body) as { data: { id: string; status: string } };
      expect(getBody.data.id).toBe(loopId);
      expect(getBody.data.status).toBe('PASSED');

      // 3. GET /api/tasks/:id/repair-loops
      const getTaskLoopsRes = await server.inject({
        method: 'GET',
        url: '/api/tasks/TASK-QLT6-TEST/repair-loops',
      });
      expect(getTaskLoopsRes.statusCode).toBe(200);
      const taskLoops = JSON.parse(getTaskLoopsRes.body) as { data: Array<{ id: string }> };
      expect(taskLoops.data.some((l) => l.id === loopId)).toBe(true);

      // 4. GET nonexistent loop returns 404
      const notFoundRes = await server.inject({
        method: 'GET',
        url: '/api/quality/repair-loops/non-existent-loop',
      });
      expect(notFoundRes.statusCode).toBe(404);
    } finally {
      await server.close();
      db.close();
    }
  });
});
