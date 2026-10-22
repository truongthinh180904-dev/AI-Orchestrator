import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  RunRepository,
  EventRepository,
} from '@ai-orchestrator/db';
import { createProcessAdapter } from '../adapters/process-adapter.js';
import { attachExecutionStream } from '../adapters/execution-stream.js';

describe('AGY-003: ExecutionStreamRecorder Unit Tests', () => {
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
      id: 'TASK-STREAM',
      title: 'Stream Task',
    });

    runRepo.create({
      id: 'run-stream-1',
      task_id: 'TASK-STREAM',
      attempt: 1,
      status: 'RUNNING',
    });
  });

  it('records process start, raw stdout, ndjson parsed event, stderr, and process exit', async () => {
    // A script that outputs:
    // 1. NDJSON valid object
    // 2. Non-JSON text (causing parse_error)
    // 3. Stderr warning
    // 4. NDJSON result object
    const script = `
      console.log(JSON.stringify({ type: "init", message: "Starting" }));
      console.log("plain raw text line");
      console.error("this is a stderr warning");
      console.log(JSON.stringify({ type: "result", status: "SUCCESS", value: 42 }));
    `;

    const handle = adapter.spawn('node', ['-e', script], process.cwd());
    const recorder = attachExecutionStream({
      runId: 'run-stream-1',
      handle,
      eventRepository: eventRepo,
      runRepository: runRepo,
    });

    const completion = await recorder.waitForCompletion();
    expect(completion.exitCode).toBe(0);

    // Verify events stored in DB
    const events = eventRepo.findByRunId('run-stream-1');
    expect(events.length).toBeGreaterThan(0);

    // Verify monotonic seq
    for (let i = 0; i < events.length; i++) {
      expect(events[i]?.seq).toBe(i + 1);
    }

    // Verify event types
    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain('process_start');
    expect(eventTypes).toContain('stdout');
    expect(eventTypes).toContain('init');
    expect(eventTypes).toContain('parse_error');
    expect(eventTypes).toContain('stderr');
    expect(eventTypes).toContain('result');
    expect(eventTypes).toContain('process_exit');

    // Verify process_start payload
    const startEvent = events.find((e) => e.type === 'process_start');
    expect(startEvent).toBeDefined();
    expect((startEvent?.payload as Record<string, unknown>).pid).toBe(handle.pid);

    // Verify init event payload
    const initEvent = events.find((e) => e.type === 'init');
    expect(initEvent?.payload).toEqual({ type: 'init', message: 'Starting' });

    // Verify parse_error payload
    const parseErrorEvent = events.find((e) => e.type === 'parse_error');
    expect((parseErrorEvent?.payload as Record<string, unknown>).raw).toBe('plain raw text line');

    // Verify stderr payload
    const stderrEvent = events.find((e) => e.type === 'stderr');
    expect((stderrEvent?.payload as Record<string, unknown>).text).toBe('this is a stderr warning');

    // Verify result event payload
    const resultEvent = events.find((e) => e.type === 'result');
    expect(resultEvent?.payload).toEqual({ type: 'result', status: 'SUCCESS', value: 42 });

    // Verify process_exit payload
    const exitEvent = events.find((e) => e.type === 'process_exit');
    expect((exitEvent?.payload as Record<string, unknown>).exitCode).toBe(0);

    // Verify run repository status was updated
    const updatedRun = runRepo.getById('run-stream-1');
    expect(updatedRun?.status).toBe('SUCCESS');
    expect(updatedRun?.exit_code).toBe(0);
    expect(updatedRun?.finished_at).toBeDefined();
  });

  it('preserves logs in database after process exits with non-zero exit code', async () => {
    runRepo.create({
      id: 'run-fail',
      task_id: 'TASK-STREAM',
    });

    const script = `
      console.log("About to fail with code 42");
      console.error("Critical failure explanation");
      process.exit(42);
    `;

    const handle = adapter.spawn('node', ['-e', script], process.cwd());
    const recorder = attachExecutionStream({
      runId: 'run-fail',
      handle,
      eventRepository: eventRepo,
      runRepository: runRepo,
    });

    const completion = await recorder.waitForCompletion();
    expect(completion.exitCode).toBe(42);

    // Process is DEAD now
    expect(handle.isRunning()).toBe(false);

    // Logs MUST still be present in the database!
    const events = eventRepo.findByRunId('run-fail');
    expect(events.length).toBeGreaterThan(0);

    const rawLogs = eventRepo.getRawLogs('run-fail');
    const texts = rawLogs.map((l) => l.text);
    expect(texts).toContain('About to fail with code 42');
    expect(texts).toContain('Critical failure explanation');

    const exitEvent = events.find((e) => e.type === 'process_exit');
    expect((exitEvent?.payload as Record<string, unknown>).exitCode).toBe(42);

    const runRecord = runRepo.getById('run-fail');
    expect(runRecord?.status).toBe('ERROR');
    expect(runRecord?.exit_code).toBe(42);
  });

  it('preserves logs in database after process is forcefully killed (SIGKILL)', async () => {
    runRepo.create({
      id: 'run-kill',
      task_id: 'TASK-STREAM',
    });

    // A process that writes a message then sleeps indefinitely
    const script = `
      console.log("Logged before forced termination");
      setInterval(() => {}, 1000);
    `;

    const handle = adapter.spawn('node', ['-e', script], process.cwd());
    const recorder = attachExecutionStream({
      runId: 'run-kill',
      handle,
      eventRepository: eventRepo,
      runRepository: runRepo,
    });

    // Wait until the stdout event is recorded in DB
    await new Promise<void>((resolve) => {
      recorder.on('stdout', (evt) => {
        if ((evt.payload as Record<string, unknown>).text === 'Logged before forced termination') {
          resolve();
        }
      });
    });

    // Forcefully kill the process with SIGKILL
    handle.kill('SIGKILL');
    await recorder.waitForCompletion();

    // Verify process is dead
    expect(handle.isRunning()).toBe(false);

    // Verify logs remain intact in SQLite after process killed!
    const events = eventRepo.findByRunId('run-kill');
    const rawLogs = eventRepo.getRawLogs('run-kill');
    expect(rawLogs.map((l) => l.text)).toContain('Logged before forced termination');

    const exitEvent = events.find((e) => e.type === 'process_exit');
    expect(exitEvent).toBeDefined();
    expect((exitEvent?.payload as Record<string, unknown>).signal).toBe('SIGKILL');
  });

  it('allows manual recording of custom events alongside process output', async () => {
    runRepo.create({
      id: 'run-custom',
      task_id: 'TASK-STREAM',
    });

    const handle = adapter.spawn('node', ['-e', 'console.log("hello")'], process.cwd());
    const recorder = attachExecutionStream({
      runId: 'run-custom',
      handle,
      eventRepository: eventRepo,
      runRepository: runRepo,
    });

    recorder.recordEvent('checkpoint', { step: 1, note: 'custom mark' });

    await recorder.waitForCompletion();

    const checkpoint = eventRepo.findByRunId('run-custom', { type: 'checkpoint' });
    expect(checkpoint).toHaveLength(1);
    expect(checkpoint[0]?.payload).toEqual({ step: 1, note: 'custom mark' });
  });

  describe('AGY-004: Run Status Resolution (SUCCESS, ERROR, INVALID_OUTPUT)', () => {
    it('sets run status to SUCCESS when process exits 0 with a valid SUCCESS result event', async () => {
      runRepo.create({
        id: 'run-res-success',
        task_id: 'TASK-STREAM',
      });

      const script = `
        console.log(JSON.stringify({ type: "result", status: "SUCCESS", summary: "Task finished" }));
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-res-success',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();
      expect(completion.exitCode).toBe(0);
      expect(completion.status).toBe('SUCCESS');
      expect(completion.resolution.status).toBe('SUCCESS');

      const runInDb = runRepo.getById('run-res-success');
      expect(runInDb?.status).toBe('SUCCESS');
    });

    it('sets run status to ERROR when process exits 0 but result event reports ERROR', async () => {
      runRepo.create({
        id: 'run-res-error-event',
        task_id: 'TASK-STREAM',
      });

      const script = `
        console.log(JSON.stringify({ type: "result", status: "ERROR", message: "Step 3 failed" }));
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-res-error-event',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();
      expect(completion.exitCode).toBe(0);
      expect(completion.status).toBe('ERROR');
      expect(completion.resolution.status).toBe('ERROR');
      expect(completion.resolution.reason).toContain('Step 3 failed');

      const runInDb = runRepo.getById('run-res-error-event');
      expect(runInDb?.status).toBe('ERROR');
    });

    it('sets run status to ERROR when process exits with non-zero exit code', async () => {
      runRepo.create({
        id: 'run-res-error-exit',
        task_id: 'TASK-STREAM',
      });

      const script = `
        process.exit(1);
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-res-error-exit',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();
      expect(completion.exitCode).toBe(1);
      expect(completion.status).toBe('ERROR');

      const runInDb = runRepo.getById('run-res-error-exit');
      expect(runInDb?.status).toBe('ERROR');
    });

    it('sets run status to INVALID_OUTPUT when process exits 0 without emitting any result event', async () => {
      runRepo.create({
        id: 'run-res-invalid-no-result',
        task_id: 'TASK-STREAM',
      });

      const script = `
        console.log("Just plain stdout text, no result event");
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-res-invalid-no-result',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();
      expect(completion.exitCode).toBe(0);
      expect(completion.status).toBe('INVALID_OUTPUT');
      expect(completion.resolution.status).toBe('INVALID_OUTPUT');
      expect(completion.resolution.reason).toContain('emitted no result event');

      const runInDb = runRepo.getById('run-res-invalid-no-result');
      expect(runInDb?.status).toBe('INVALID_OUTPUT');
    });

    it('sets run status to INVALID_OUTPUT when result event payload is malformed/invalid schema', async () => {
      runRepo.create({
        id: 'run-res-invalid-schema',
        task_id: 'TASK-STREAM',
      });

      const script = `
        console.log(JSON.stringify({ type: "result", status: "NON_EXISTENT_STATUS" }));
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-res-invalid-schema',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const completion = await recorder.waitForCompletion();
      expect(completion.exitCode).toBe(0);
      expect(completion.status).toBe('INVALID_OUTPUT');

      const runInDb = runRepo.getById('run-res-invalid-schema');
      expect(runInDb?.status).toBe('INVALID_OUTPUT');
    });

    it('sets run status to TIMEOUT when markTimeout is called', async () => {
      runRepo.create({
        id: 'run-res-timeout',
        task_id: 'TASK-STREAM',
      });

      const handle = adapter.spawn('node', ['-e', 'setTimeout(() => {}, 500)'], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-res-timeout',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      recorder.markTimeout();
      handle.kill('SIGKILL');

      const completion = await recorder.waitForCompletion();
      expect(completion.status).toBe('TIMEOUT');

      const runInDb = runRepo.getById('run-res-timeout');
      expect(runInDb?.status).toBe('TIMEOUT');
    });

    it('sets run status to CANCELLED when markCancelled is called', async () => {
      runRepo.create({
        id: 'run-res-cancelled',
        task_id: 'TASK-STREAM',
      });

      const handle = adapter.spawn('node', ['-e', 'setTimeout(() => {}, 500)'], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-res-cancelled',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      recorder.markCancelled();
      handle.kill('SIGTERM');

      const completion = await recorder.waitForCompletion();
      expect(completion.status).toBe('CANCELLED');

      const runInDb = runRepo.getById('run-res-cancelled');
      expect(runInDb?.status).toBe('CANCELLED');
    });
  });
});
