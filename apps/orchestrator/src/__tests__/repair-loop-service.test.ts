import { describe, expect, it, vi } from 'vitest';
import { createDatabase, runMigrations, TaskRepository } from '@ai-orchestrator/db';
import type { QualityPipelineResult, ReviewResult } from '@ai-orchestrator/shared';
import { RepairLoopService } from '../services/repair-loop-service.js';
import { QualityRunner } from '../services/quality-runner.js';
import { ReviewerService } from '../services/reviewer-service.js';

describe('RepairLoopService Unit Tests', () => {
  function setupTestEnv() {
    const db = createDatabase(':memory:');
    runMigrations(db);

    const taskRepo = new TaskRepository(db);
    const now = new Date().toISOString();
    taskRepo.create({
      id: 'TASK-REPAIR-1',
      title: 'Fix edge case in parser',
      acceptance_criteria: ['Unit test passes', 'No lint errors'],
      test_commands: ['pnpm test'],
      status: 'VERIFYING',
      created_at: now,
      updated_at: now,
    });

    const mockQualityRunner = new QualityRunner({ db });
    const mockReviewerService = new ReviewerService({ db });

    const service = new RepairLoopService({
      db,
      qualityRunner: mockQualityRunner,
      reviewerService: mockReviewerService,
      taskRepo,
    });

    return { db, taskRepo, service, mockQualityRunner, mockReviewerService };
  }

  it('Hết lượt thì dừng, FAILED: dừng chính xác khi hết max N lượt và đánh dấu task FAILED', async () => {
    const { db, taskRepo, service, mockReviewerService } = setupTestEnv();
    try {
      vi.spyOn(service, 'executeVerificationPipeline').mockResolvedValue({
        task_id: 'TASK-REPAIR-1',
        run_id: null,
        repo_path: '.',
        success: false,
        total_commands: 1,
        passed_commands: 0,
        failed_commands: 1,
        skipped_commands: 0,
        duration_ms: 20,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        records: [
          {
            id: 'rec-fail',
            task_id: 'TASK-REPAIR-1',
            run_id: null,
            stage: 'test',
            command_id: 'test-1',
            name: 'Unit test',
            command: 'pnpm test',
            exe: 'pnpm',
            args: ['test'],
            cwd: '.',
            exit_code: 1,
            signal: null,
            status: 'FAILURE',
            stdout: '',
            stderr: 'AssertionError: expected true to be false',
            duration_ms: 15,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      } as QualityPipelineResult);

      vi.spyOn(mockReviewerService, 'reviewTask').mockResolvedValue({
        id: 'rev-1',
        task_id: 'TASK-REPAIR-1',
        run_id: null,
        passed: true,
        stats: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        findings: [],
        summary: 'No review findings',
        raw_output: '[]',
        reviewed_at: new Date().toISOString(),
        reviewer_type: 'agy',
      } as ReviewResult);

      let fixAttemptCount = 0;
      const result = await service.runRepairCycle({
        taskId: 'TASK-REPAIR-1',
        maxIterations: 3,
        executeFix: async () => {
          fixAttemptCount++;
          return { success: true };
        },
      });

      // Assertions for Nghiệm thu: "Hết lượt thì dừng, FAILED"
      expect(result.passed).toBe(false);
      expect(result.status).toBe('FAILED');
      expect(result.totalIterations).toBe(3);
      expect(result.maxIterations).toBe(3);
      expect(result.finalReason).toBe('MAX_REPAIR_ITERATIONS_EXCEEDED');
      expect(fixAttemptCount).toBe(3); // Exactly 3 attempts, did not loop indefinitely

      // Task status must be FAILED
      const updatedTask = taskRepo.findById('TASK-REPAIR-1');
      expect(updatedTask?.status).toBe('FAILED');

      // Loop record in database
      const savedLoop = service.getRepairLoop(result.loopId);
      expect(savedLoop?.status).toBe('FAILED');
      expect(savedLoop?.passed).toBe(false);
      expect(savedLoop?.current_iteration).toBe(3);
      expect(savedLoop?.iterations).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it('Dừng sớm và PASSED khi vòng sửa giải quyết được lỗi trước khi hết lượt', async () => {
    const { db, taskRepo, service, mockReviewerService } = setupTestEnv();
    try {
      let iterationIndex = 0;

      vi.spyOn(service, 'executeVerificationPipeline').mockImplementation(async () => {
        iterationIndex++;
        if (iterationIndex <= 2) {
          // Initial check (1) and iteration 1 (2) fail
          return {
            task_id: 'TASK-REPAIR-1',
            run_id: null,
            repo_path: '.',
            success: false,
            total_commands: 1,
            passed_commands: 0,
            failed_commands: 1,
            skipped_commands: 0,
            duration_ms: 20,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            records: [
              {
                id: 'rec-fail-1',
                task_id: 'TASK-REPAIR-1',
                run_id: null,
                stage: 'test',
                command_id: 'test-1',
                name: 'Unit test',
                command: 'pnpm test',
                exe: 'pnpm',
                args: ['test'],
                cwd: '.',
                exit_code: 1,
                signal: null,
                status: 'FAILURE',
                stdout: '',
                stderr: 'Test failed',
                duration_ms: 10,
                started_at: new Date().toISOString(),
                finished_at: new Date().toISOString(),
                created_at: new Date().toISOString(),
              },
            ],
          } as QualityPipelineResult;
        } else {
          // Second attempt passes!
          return {
            task_id: 'TASK-REPAIR-1',
            run_id: null,
            repo_path: '.',
            success: true,
            total_commands: 1,
            passed_commands: 1,
            failed_commands: 0,
            skipped_commands: 0,
            duration_ms: 20,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            records: [
              {
                id: 'rec-pass-2',
                task_id: 'TASK-REPAIR-1',
                run_id: null,
                stage: 'test',
                command_id: 'test-1',
                name: 'Unit test',
                command: 'pnpm test',
                exe: 'pnpm',
                args: ['test'],
                cwd: '.',
                exit_code: 0,
                signal: null,
                status: 'SUCCESS',
                stdout: 'All tests passed',
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
        task_id: 'TASK-REPAIR-1',
        run_id: null,
        passed: true,
        stats: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        findings: [],
        summary: 'All checks passed',
        raw_output: '[]',
        reviewed_at: new Date().toISOString(),
        reviewer_type: 'agy',
      } as ReviewResult);

      let fixCount = 0;
      const result = await service.runRepairCycle({
        taskId: 'TASK-REPAIR-1',
        maxIterations: 5,
        executeFix: async () => {
          fixCount++;
          return { success: true };
        },
      });

      // Stopped on iteration 2, didn't run iterations 3, 4, 5
      expect(result.passed).toBe(true);
      expect(result.status).toBe('PASSED');
      expect(result.totalIterations).toBe(2);
      expect(fixCount).toBe(2);

      // Task status should be VERIFYING (not failed)
      const task = taskRepo.findById('TASK-REPAIR-1');
      expect(task?.status).toBe('VERIFYING');

      // Iterations recorded in DB
      const iterations = result.iterations;
      expect(iterations).toHaveLength(2);
      expect(iterations[0]?.passed).toBe(false);
      expect(iterations[1]?.passed).toBe(true);
    } finally {
      db.close();
    }
  });

  it('Tuân thủ giới hạn N tùy chỉnh (N = 1)', async () => {
    const { db, service, mockReviewerService } = setupTestEnv();
    try {
      vi.spyOn(service, 'executeVerificationPipeline').mockResolvedValue({
        task_id: 'TASK-REPAIR-1',
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
            id: 'rec-fail-n1',
            task_id: 'TASK-REPAIR-1',
            run_id: null,
            stage: 'lint',
            command_id: 'lint-1',
            name: 'Lint',
            command: 'pnpm lint',
            exe: 'pnpm',
            args: ['lint'],
            cwd: '.',
            exit_code: 1,
            signal: null,
            status: 'FAILURE',
            stdout: '',
            stderr: 'Lint error',
            duration_ms: 5,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      } as QualityPipelineResult);

      vi.spyOn(mockReviewerService, 'reviewTask').mockResolvedValue({
        id: 'rev-pass',
        task_id: 'TASK-REPAIR-1',
        run_id: null,
        passed: true,
        stats: { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        findings: [],
        summary: 'Review passed',
        raw_output: '[]',
        reviewed_at: new Date().toISOString(),
        reviewer_type: 'agy',
      } as ReviewResult);

      let count = 0;
      const result = await service.runRepairCycle({
        taskId: 'TASK-REPAIR-1',
        maxIterations: 1, // Only 1 attempt
        executeFix: async () => {
          count++;
          return { success: true };
        },
      });

      expect(count).toBe(1);
      expect(result.passed).toBe(false);
      expect(result.status).toBe('FAILED');
      expect(result.totalIterations).toBe(1);
    } finally {
      db.close();
    }
  });

  it('Xây dựng repair prompt chứa đầy đủ command failures và reviewer findings', async () => {
    const { db, service, mockReviewerService } = setupTestEnv();
    try {
      vi.spyOn(service, 'executeVerificationPipeline').mockResolvedValue({
        task_id: 'TASK-REPAIR-1',
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
            id: 'rec-fail-prompt',
            task_id: 'TASK-REPAIR-1',
            run_id: null,
            stage: 'typecheck',
            command_id: 'tc-1',
            name: 'Typecheck',
            command: 'pnpm typecheck',
            exe: 'pnpm',
            args: ['typecheck'],
            cwd: '.',
            exit_code: 2,
            signal: null,
            status: 'FAILURE',
            stdout: '',
            stderr: 'Property name does not exist on type User',
            duration_ms: 5,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          },
        ],
      } as QualityPipelineResult);

      vi.spyOn(mockReviewerService, 'reviewTask').mockResolvedValue({
        id: 'rev-fail',
        task_id: 'TASK-REPAIR-1',
        run_id: null,
        passed: false,
        stats: { total: 1, critical: 0, high: 1, medium: 0, low: 0, info: 0 },
        findings: [
          {
            severity: 'high',
            file: 'src/user.ts',
            line: 18,
            message: 'Unvalidated user input in query',
            suggestion: 'Use Zod schema parse',
          },
        ],
        summary: '1 high finding',
        raw_output: '[]',
        reviewed_at: new Date().toISOString(),
        reviewer_type: 'agy',
      } as ReviewResult);

      let capturedPrompt = '';
      await service.runRepairCycle({
        taskId: 'TASK-REPAIR-1',
        maxIterations: 1,
        executeFix: async (_iter, prompt) => {
          capturedPrompt = prompt;
          return { success: true };
        },
      });

      expect(capturedPrompt).toContain('REPAIR REQUEST');
      expect(capturedPrompt).toContain('TASK-REPAIR-1');
      expect(capturedPrompt).toContain('Property name does not exist on type User');
      expect(capturedPrompt).toContain('Unvalidated user input in query');
      expect(capturedPrompt).toContain('src/user.ts:18');
    } finally {
      db.close();
    }
  });
});
