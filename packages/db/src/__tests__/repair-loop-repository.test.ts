import { describe, expect, it } from 'vitest';
import { createDatabase } from '../connection.js';
import { runMigrations } from '../migrator.js';
import { RepairLoopRepository } from '../repositories/repair-loop-repository.js';
import { TaskRepository } from '../repositories/task-repository.js';

describe('RepairLoopRepository', () => {
  function setupTestDb() {
    const db = createDatabase(':memory:');
    runMigrations(db);
    const taskRepo = new TaskRepository(db);
    const repairRepo = new RepairLoopRepository(db);

    const now = new Date().toISOString();
    taskRepo.create({
      id: 'TASK-LOOP-TEST',
      title: 'Test repair loop task',
      acceptance_criteria: ['All tests pass'],
      test_commands: ['pnpm test'],
      status: 'VERIFYING',
      created_at: now,
      updated_at: now,
    });

    return { db, taskRepo, repairRepo };
  }

  it('creates and retrieves a repair loop record', () => {
    const { db, repairRepo } = setupTestDb();
    try {
      const loop = repairRepo.createLoop({
        task_id: 'TASK-LOOP-TEST',
        max_iterations: 3,
        feedback_summary: 'Linter and reviewer errors found',
      });

      expect(loop.id).toBeTruthy();
      expect(loop.task_id).toBe('TASK-LOOP-TEST');
      expect(loop.max_iterations).toBe(3);
      expect(loop.current_iteration).toBe(0);
      expect(loop.status).toBe('RUNNING');
      expect(loop.passed).toBe(false);
      expect(loop.feedback_summary).toBe('Linter and reviewer errors found');

      const fetched = repairRepo.getLoopById(loop.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(loop.id);
    } finally {
      db.close();
    }
  });

  it('updates repair loop status and fields', () => {
    const { db, repairRepo } = setupTestDb();
    try {
      const loop = repairRepo.createLoop({
        task_id: 'TASK-LOOP-TEST',
        max_iterations: 2,
      });

      const updated = repairRepo.updateLoop(loop.id, {
        status: 'FAILED',
        passed: false,
        current_iteration: 2,
        final_reason: 'MAX_REPAIR_ITERATIONS_EXCEEDED',
        finished_at: new Date().toISOString(),
      });

      expect(updated.status).toBe('FAILED');
      expect(updated.passed).toBe(false);
      expect(updated.current_iteration).toBe(2);
      expect(updated.final_reason).toBe('MAX_REPAIR_ITERATIONS_EXCEEDED');
      expect(updated.finished_at).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it('creates and updates iterations within a repair loop', () => {
    const { db, repairRepo } = setupTestDb();
    try {
      const loop = repairRepo.createLoop({
        task_id: 'TASK-LOOP-TEST',
        max_iterations: 3,
      });

      const iter1 = repairRepo.createIteration({
        repair_loop_id: loop.id,
        iteration_number: 1,
        prompt: 'Fix eslint issue',
        feedback: {
          command_failures: [
            {
              command_id: 'cmd-1',
              stage: 'lint',
              command: 'pnpm lint',
              exit_code: 1,
              status: 'FAILURE',
              error_snippet: 'Lint failed',
            },
          ],
          review_findings: [],
          summary: '1 command failed',
        },
        command_failures_count: 1,
        review_findings_count: 0,
      });

      expect(iter1.id).toBeTruthy();
      expect(iter1.repair_loop_id).toBe(loop.id);
      expect(iter1.iteration_number).toBe(1);
      expect(iter1.status).toBe('IN_PROGRESS');
      expect(iter1.passed).toBe(false);

      const updatedIter = repairRepo.updateIteration(iter1.id, {
        status: 'PASSED',
        passed: true,
        command_failures_count: 0,
        duration_ms: 125,
      });

      expect(updatedIter.status).toBe('PASSED');
      expect(updatedIter.passed).toBe(true);
      expect(updatedIter.duration_ms).toBe(125);

      const loopWithIterations = repairRepo.getLoopWithIterations(loop.id);
      expect(loopWithIterations?.iterations).toHaveLength(1);
      expect(loopWithIterations?.iterations?.[0]?.id).toBe(iter1.id);
    } finally {
      db.close();
    }
  });

  it('cascades delete when task is deleted', () => {
    const { db, taskRepo, repairRepo } = setupTestDb();
    try {
      const loop = repairRepo.createLoop({
        task_id: 'TASK-LOOP-TEST',
        max_iterations: 3,
      });

      repairRepo.createIteration({
        repair_loop_id: loop.id,
        iteration_number: 1,
      });

      expect(repairRepo.getLoopById(loop.id)).not.toBeNull();
      expect(repairRepo.getIterationsByLoopId(loop.id)).toHaveLength(1);

      // Delete task
      taskRepo.delete('TASK-LOOP-TEST');

      // Loop and iteration should be deleted via ON DELETE CASCADE
      expect(repairRepo.getLoopById(loop.id)).toBeNull();
      expect(repairRepo.getIterationsByLoopId(loop.id)).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
