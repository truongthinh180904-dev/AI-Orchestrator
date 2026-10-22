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
});
