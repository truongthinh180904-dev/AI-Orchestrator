import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  RunRepository,
  EventRepository,
} from '../packages/db/src/index.js';
import {
  createProcessAdapter,
  attachExecutionStream,
} from '../apps/orchestrator/src/adapters/index.js';
import { resolveRunStatus } from '../packages/shared/src/index.js';

describe('AGY-004 Acceptance Tests: Xử lý exit code + event result → SUCCESS / ERROR / INVALID_OUTPUT', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let runRepo: RunRepository;
  let eventRepo: EventRepository;
  const adapter = createProcessAdapter();

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    runRepo = new RunRepository(db);
    eventRepo = new EventRepository(db);

    taskRepo.create({
      id: 'TASK-AGY-004',
      title: 'AGY-004 Result Processing Acceptance Task',
    });
  });

  // ==========================================================================
  // TRƯỜNG HỢP 1: SUCCESS
  // Điều kiện: exit 0 + có event result hợp lệ báo SUCCESS
  // ==========================================================================
  describe('Trường hợp 1: SUCCESS (exit 0 + có event result hợp lệ)', () => {
    it('1.1: xác nhận status SUCCESS khi exit 0 và event result có status "SUCCESS"', async () => {
      runRepo.create({
        id: 'run-success-1',
        task_id: 'TASK-AGY-004',
        status: 'RUNNING',
      });

      const script = `
        console.log(JSON.stringify({ type: "step", name: "prepare", ok: true }));
        console.log(JSON.stringify({ type: "step", name: "compile", ok: true }));
        console.log(JSON.stringify({
          type: "result",
          status: "SUCCESS",
          summary: "All compilation targets built successfully"
        }));
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-success-1',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();

      expect(completion.exitCode).toBe(0);
      expect(completion.status).toBe('SUCCESS');
      expect(completion.resolution.status).toBe('SUCCESS');
      expect(completion.resolution.reason).toContain('valid success result event');
      expect(completion.resolution.parsedResult?.status).toBe('SUCCESS');
      expect(completion.resolution.parsedResult?.summary).toBe(
        'All compilation targets built successfully',
      );

      // Xác nhận DB đã ghi nhận status SUCCESS
      const runRecord = runRepo.getById('run-success-1');
      expect(runRecord).toBeDefined();
      expect(runRecord?.status).toBe('SUCCESS');
      expect(runRecord?.exit_code).toBe(0);
      expect(runRecord?.finished_at).not.toBeNull();
    });

    it('1.2: xác nhận status SUCCESS khi exit 0 và event result có success: true', async () => {
      runRepo.create({
        id: 'run-success-2',
        task_id: 'TASK-AGY-004',
        status: 'RUNNING',
      });

      const script = `
        console.log(JSON.stringify({
          type: "result",
          success: true,
          data: { filesModified: 3 }
        }));
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-success-2',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();

      expect(completion.exitCode).toBe(0);
      expect(completion.status).toBe('SUCCESS');
      expect(completion.resolution.parsedResult?.success).toBe(true);

      const runRecord = runRepo.getById('run-success-2');
      expect(runRecord?.status).toBe('SUCCESS');
    });

    it('1.3: xác nhận status SUCCESS khi status là chữ thường "success" (chuẩn hóa tự động)', async () => {
      runRepo.create({
        id: 'run-success-3',
        task_id: 'TASK-AGY-004',
        status: 'RUNNING',
      });

      const script = `
        console.log(JSON.stringify({ type: "result", status: "success" }));
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-success-3',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();

      expect(completion.exitCode).toBe(0);
      expect(completion.status).toBe('SUCCESS');
      expect(completion.resolution.parsedResult?.status).toBe('SUCCESS');
    });

    it('1.4: phân biệt CLI thành công (run SUCCESS) với đạt acceptance criteria (task chưa DONE)', async () => {
      // Đảm bảo theo SKILL-process-ndjson.md: CLI SUCCESS không tự ý đánh dấu task là DONE
      const taskBefore = taskRepo.findById('TASK-AGY-004');
      expect(taskBefore?.status).toBe('TODO');

      runRepo.create({
        id: 'run-success-task-check',
        task_id: 'TASK-AGY-004',
        status: 'RUNNING',
      });

      const script = `
        console.log(JSON.stringify({ type: "result", status: "SUCCESS" }));
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-success-task-check',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();
      expect(completion.status).toBe('SUCCESS');

      const runRecord = runRepo.getById('run-success-task-check');
      expect(runRecord?.status).toBe('SUCCESS');

      // Task status vẫn là TODO (chưa qua Quality Gate / Verifier của GĐ 3/4)
      const taskAfter = taskRepo.findById('TASK-AGY-004');
      expect(taskAfter?.status).toBe('TODO');
    });
  });

  // ==========================================================================
  // TRƯỜNG HỢP 2: ERROR
  // Điều kiện: exit ≠ 0 hoặc event result báo lỗi
  // ==========================================================================
  describe('Trường hợp 2: ERROR (exit ≠ 0 hoặc event result báo lỗi)', () => {
    it('2.1: xác nhận status ERROR khi tiến trình thoát với exit code khác 0 (exit 1)', async () => {
      runRepo.create({
        id: 'run-err-exit-1',
        task_id: 'TASK-AGY-004',
        status: 'RUNNING',
      });

      const script = `
        console.error("Fatal error: Unhandled exception");
        process.exit(1);
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-err-exit-1',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();

      expect(completion.exitCode).toBe(1);
      expect(completion.status).toBe('ERROR');
      expect(completion.resolution.status).toBe('ERROR');
      expect(completion.resolution.reason).toContain('non-zero exit code: 1');

      const runRecord = runRepo.getById('run-err-exit-1');
      expect(runRecord?.status).toBe('ERROR');
      expect(runRecord?.exit_code).toBe(1);
    });

    it('2.2: xác nhận status ERROR khi exit ≠ 0 dù trước đó có in event result SUCCESS', async () => {
      runRepo.create({
        id: 'run-err-exit-override',
        task_id: 'TASK-AGY-004',
        status: 'RUNNING',
      });

      const script = `
        console.log(JSON.stringify({ type: "result", status: "SUCCESS" }));
        console.error("Post-result crash!");
        process.exit(2);
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-err-exit-override',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();

      expect(completion.exitCode).toBe(2);
      expect(completion.status).toBe('ERROR');
      expect(completion.resolution.reason).toContain('non-zero exit code: 2');

      const runRecord = runRepo.getById('run-err-exit-override');
      expect(runRecord?.status).toBe('ERROR');
      expect(runRecord?.exit_code).toBe(2);
    });

    it('2.3: xác nhận status ERROR khi exit 0 nhưng event result mang status "ERROR"', async () => {
      runRepo.create({
        id: 'run-err-event-error',
        task_id: 'TASK-AGY-004',
        status: 'RUNNING',
      });

      const script = `
        console.log(JSON.stringify({
          type: "result",
          status: "ERROR",
          message: "Typecheck failed on src/index.ts"
        }));
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-err-event-error',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();

      expect(completion.exitCode).toBe(0);
      expect(completion.status).toBe('ERROR');
      expect(completion.resolution.status).toBe('ERROR');
      expect(completion.resolution.reason).toContain('Typecheck failed on src/index.ts');

      const runRecord = runRepo.getById('run-err-event-error');
      expect(runRecord?.status).toBe('ERROR');
      expect(runRecord?.exit_code).toBe(0);
    });

    it('2.4: xác nhận status ERROR khi exit 0 nhưng event result mang status "FAILED"', async () => {
      runRepo.create({
        id: 'run-err-event-failed',
        task_id: 'TASK-AGY-004',
        status: 'RUNNING',
      });

      const script = `
        console.log(JSON.stringify({
          type: "result",
          status: "FAILED",
          summary: "Could not satisfy acceptance criteria"
        }));
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-err-event-failed',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();

      expect(completion.exitCode).toBe(0);
      expect(completion.status).toBe('ERROR');
      expect(completion.resolution.status).toBe('ERROR');
      expect(completion.resolution.reason).toContain('Could not satisfy acceptance criteria');

      const runRecord = runRepo.getById('run-err-event-failed');
      expect(runRecord?.status).toBe('ERROR');
    });

    it('2.5: xác nhận status ERROR khi exit 0 nhưng event result có success: false', async () => {
      runRepo.create({
        id: 'run-err-event-success-false',
        task_id: 'TASK-AGY-004',
        status: 'RUNNING',
      });

      const script = `
        console.log(JSON.stringify({
          type: "result",
          success: false,
          error: "Permission denied while writing output"
        }));
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-err-event-success-false',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();

      expect(completion.exitCode).toBe(0);
      expect(completion.status).toBe('ERROR');
      expect(completion.resolution.reason).toContain('Permission denied while writing output');

      const runRecord = runRepo.getById('run-err-event-success-false');
      expect(runRecord?.status).toBe('ERROR');
    });

    it('2.6: xác nhận status ERROR khi tiến trình bị tiêu diệt bởi tín hiệu SIGKILL', async () => {
      runRepo.create({
        id: 'run-err-signal-kill',
        task_id: 'TASK-AGY-004',
        status: 'RUNNING',
      });

      const script = `
        setInterval(() => {}, 1000);
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-err-signal-kill',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      handle.kill('SIGKILL');
      const completion = await recorder.waitForCompletion();

      expect(completion.exitCode).toBeNull();
      expect(completion.signal).toBe('SIGKILL');
      expect(completion.status).toBe('ERROR');
      expect(completion.resolution.reason).toContain('SIGKILL');

      const runRecord = runRepo.getById('run-err-signal-kill');
      expect(runRecord?.status).toBe('ERROR');
    });
  });

  // ==========================================================================
  // TRƯỜNG HỢP 3: INVALID_OUTPUT
  // Điều kiện: exit 0 nhưng không có/sai result
  // ==========================================================================
  describe('Trường hợp 3: INVALID_OUTPUT (exit 0 nhưng không có/sai result)', () => {
    it('3.1: xác nhận status INVALID_OUTPUT khi exit 0 nhưng không có output nào (empty output)', async () => {
      runRepo.create({
        id: 'run-inv-empty',
        task_id: 'TASK-AGY-004',
        status: 'RUNNING',
      });

      // Script không in gì ra stdout/stderr và exit 0
      const script = `process.exit(0);`;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-inv-empty',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();

      expect(completion.exitCode).toBe(0);
      expect(completion.status).toBe('INVALID_OUTPUT');
      expect(completion.resolution.status).toBe('INVALID_OUTPUT');
      expect(completion.resolution.reason).toContain('emitted no result event');

      const runRecord = runRepo.getById('run-inv-empty');
      expect(runRecord?.status).toBe('INVALID_OUTPUT');
      expect(runRecord?.exit_code).toBe(0);
    });

    it('3.2: xác nhận status INVALID_OUTPUT khi exit 0 nhưng chỉ in log văn bản thô không có event result', async () => {
      runRepo.create({
        id: 'run-inv-plain-stdout',
        task_id: 'TASK-AGY-004',
        status: 'RUNNING',
      });

      const script = `
        console.log("Starting task...");
        console.log("Doing some work...");
        console.log("Done with work!");
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-inv-plain-stdout',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();

      expect(completion.exitCode).toBe(0);
      expect(completion.status).toBe('INVALID_OUTPUT');
      expect(completion.resolution.reason).toContain('emitted no result event');

      const runRecord = runRepo.getById('run-inv-plain-stdout');
      expect(runRecord?.status).toBe('INVALID_OUTPUT');
    });

    it('3.3: xác nhận status INVALID_OUTPUT khi dòng result bị lỗi cú pháp JSON (parse_error)', async () => {
      runRepo.create({
        id: 'run-inv-json-syntax-error',
        task_id: 'TASK-AGY-004',
        status: 'RUNNING',
      });

      const script = `
        console.log("Starting work");
        // In dòng result nhưng bị cắt cụt cú pháp JSON
        console.log('{"type": "result", "status": "SUCCESS", "incomplete": ');
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-inv-json-syntax-error',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();

      expect(completion.exitCode).toBe(0);
      expect(completion.status).toBe('INVALID_OUTPUT');
      expect(completion.resolution.reason).toContain('emitted no result event');

      // Xác nhận parse_error được ghi nhận trong bảng events
      const parseErrors = eventRepo.findByRunId('run-inv-json-syntax-error', {
        type: 'parse_error',
      });
      expect(parseErrors.length).toBeGreaterThanOrEqual(1);

      const runRecord = runRepo.getById('run-inv-json-syntax-error');
      expect(runRecord?.status).toBe('INVALID_OUTPUT');
    });

    it('3.4: xác nhận status INVALID_OUTPUT khi event result thiếu cả 2 trường status và success', async () => {
      runRepo.create({
        id: 'run-inv-missing-fields',
        task_id: 'TASK-AGY-004',
        status: 'RUNNING',
      });

      const script = `
        console.log(JSON.stringify({
          type: "result",
          summary: "I forgot status and success fields",
          metadata: { a: 1 }
        }));
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-inv-missing-fields',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();

      expect(completion.exitCode).toBe(0);
      expect(completion.status).toBe('INVALID_OUTPUT');
      expect(completion.resolution.reason).toContain('result event payload was invalid');

      const runRecord = runRepo.getById('run-inv-missing-fields');
      expect(runRecord?.status).toBe('INVALID_OUTPUT');
    });

    it('3.5: xác nhận status INVALID_OUTPUT khi event result có status không hợp lệ', async () => {
      runRepo.create({
        id: 'run-inv-bad-status-enum',
        task_id: 'TASK-AGY-004',
        status: 'RUNNING',
      });

      const script = `
        console.log(JSON.stringify({
          type: "result",
          status: "COMPLETED_UNOFFICIAL"
        }));
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-inv-bad-status-enum',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();

      expect(completion.exitCode).toBe(0);
      expect(completion.status).toBe('INVALID_OUTPUT');
      expect(completion.resolution.reason).toContain('result event payload was invalid');

      const runRecord = runRepo.getById('run-inv-bad-status-enum');
      expect(runRecord?.status).toBe('INVALID_OUTPUT');
    });

    it('3.6: xác nhận status INVALID_OUTPUT qua resolveRunStatus khi payload của event result là null hoặc chuỗi', () => {
      const resolutionNull = resolveRunStatus({
        exitCode: 0,
        events: [{ type: 'result', payload: null }],
      });
      expect(resolutionNull.status).toBe('INVALID_OUTPUT');

      const resolutionString = resolveRunStatus({
        exitCode: 0,
        events: [{ type: 'result', payload: 'not-json-object' }],
      });
      expect(resolutionString.status).toBe('INVALID_OUTPUT');

      const resolutionNumber = resolveRunStatus({
        exitCode: 0,
        events: [{ type: 'result', payload: 12345 }],
      });
      expect(resolutionNumber.status).toBe('INVALID_OUTPUT');
    });
  });

  // ==========================================================================
  // TRƯỜNG HỢP MỞ RỘNG: TIMEOUT & CANCELLED
  // ==========================================================================
  describe('Trường hợp mở rộng: TIMEOUT & CANCELLED', () => {
    it('xác nhận status TIMEOUT khi đánh dấu markTimeout', async () => {
      runRepo.create({
        id: 'run-timeout-check',
        task_id: 'TASK-AGY-004',
        status: 'RUNNING',
      });

      const script = `setTimeout(() => {}, 5000);`;
      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-timeout-check',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      recorder.markTimeout();
      handle.kill('SIGTERM');

      const completion = await recorder.waitForCompletion();
      expect(completion.status).toBe('TIMEOUT');
      expect(completion.resolution.status).toBe('TIMEOUT');
      expect(completion.resolution.reason).toContain('timed out');

      const runRecord = runRepo.getById('run-timeout-check');
      expect(runRecord?.status).toBe('TIMEOUT');
    });

    it('xác nhận status CANCELLED khi đánh dấu markCancelled', async () => {
      runRepo.create({
        id: 'run-cancel-check',
        task_id: 'TASK-AGY-004',
        status: 'RUNNING',
      });

      const script = `setTimeout(() => {}, 5000);`;
      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-cancel-check',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      recorder.markCancelled();
      handle.kill('SIGTERM');

      const completion = await recorder.waitForCompletion();
      expect(completion.status).toBe('CANCELLED');
      expect(completion.resolution.status).toBe('CANCELLED');
      expect(completion.resolution.reason).toContain('cancelled by user');

      const runRecord = runRepo.getById('run-cancel-check');
      expect(runRecord?.status).toBe('CANCELLED');
    });
  });
});
