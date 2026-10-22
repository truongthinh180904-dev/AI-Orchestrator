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

describe('AGY-003 Acceptance Tests: Chuẩn hóa event stream + lưu bảng events — Log còn sau khi process chết', () => {
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
      id: 'TASK-AGY-003',
      title: 'AGY-003 Acceptance Task',
    });
  });

  describe('Nghiệm thu 1: Chuẩn hóa event stream với run_id, seq, type, payload, ts', () => {
    it('ghi nhận stream sự kiện với seq tăng dần đơn điệu và payload có cấu trúc', async () => {
      runRepo.create({
        id: 'run-seq-test',
        task_id: 'TASK-AGY-003',
        status: 'RUNNING',
      });

      const script = `
        console.log(JSON.stringify({ type: "step", stepIndex: 1, action: "analyze" }));
        console.log(JSON.stringify({ type: "step", stepIndex: 2, action: "execute" }));
        console.log(JSON.stringify({ type: "result", status: "SUCCESS" }));
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-seq-test',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      await recorder.waitForCompletion();

      const events = eventRepo.findByRunId('run-seq-test');
      expect(events.length).toBeGreaterThanOrEqual(5);

      // seq phải tăng dần liên tục không ngắt quãng (1, 2, 3, 4...)
      for (let i = 0; i < events.length; i++) {
        const evt = events[i]!;
        expect(evt.seq).toBe(i + 1);
        expect(evt.run_id).toBe('run-seq-test');
        expect(typeof evt.type).toBe('string');
        expect(evt.payload).toBeDefined();
        expect(evt.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      }

      // Kiểm tra sự kiện process_start và process_exit
      expect(events[0]?.type).toBe('process_start');
      expect(events[events.length - 1]?.type).toBe('process_exit');
    });
  });

  describe('Nghiệm thu 2: Lưu đầy đủ stdout và stderr thô (raw)', () => {
    it('lưu cả stdout thô và stderr thô kèm khả năng trích xuất toàn bộ log theo thời gian', async () => {
      runRepo.create({
        id: 'run-raw-logs',
        task_id: 'TASK-AGY-003',
      });

      const script = `
        console.log("Stdout line 1");
        console.error("Stderr warning 1");
        console.log("Stdout line 2");
        console.error("Stderr warning 2");
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-raw-logs',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      await recorder.waitForCompletion();

      const rawLogs = eventRepo.getRawLogs('run-raw-logs');
      expect(rawLogs).toHaveLength(4);

      const stdoutTexts = rawLogs.filter((l) => l.type === 'stdout').map((l) => l.text);
      const stderrTexts = rawLogs.filter((l) => l.type === 'stderr').map((l) => l.text);

      expect(stdoutTexts).toEqual(['Stdout line 1', 'Stdout line 2']);
      expect(stderrTexts).toEqual(['Stderr warning 1', 'Stderr warning 2']);

      // Thứ tự seq của log thô được bảo toàn đơn điệu tăng dần
      for (let i = 1; i < rawLogs.length; i++) {
        expect(rawLogs[i]!.seq).toBeGreaterThan(rawLogs[i - 1]!.seq);
      }
    });
  });

  describe('Nghiệm thu 3: Xử lý NDJSON và parse_error không làm đứt đoạn stream', () => {
    it('lưu sự kiện NDJSON hợp lệ đồng thời lưu parse_error cho dòng không hợp lệ', async () => {
      runRepo.create({
        id: 'run-ndjson-mixed',
        task_id: 'TASK-AGY-003',
      });

      const script = `
        console.log(JSON.stringify({ type: "valid_event", data: { count: 10 } }));
        console.log("INVALID_JSON_RAW_LINE");
        console.log(JSON.stringify({ type: "final_event", data: { done: true } }));
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-ndjson-mixed',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const result = await recorder.waitForCompletion();
      expect(result.exitCode).toBe(0);

      const events = eventRepo.findByRunId('run-ndjson-mixed');

      const validEvents = events.filter((e) => e.type === 'valid_event');
      expect(validEvents).toHaveLength(1);
      expect(validEvents[0]?.payload).toEqual({ type: 'valid_event', data: { count: 10 } });

      const parseErrors = events.filter((e) => e.type === 'parse_error');
      expect(parseErrors).toHaveLength(1);
      expect((parseErrors[0]?.payload as Record<string, unknown> | undefined)?.raw).toBe(
        'INVALID_JSON_RAW_LINE',
      );

      const finalEvents = events.filter((e) => e.type === 'final_event');
      expect(finalEvents).toHaveLength(1);
      expect(finalEvents[0]?.payload).toEqual({ type: 'final_event', data: { done: true } });
    });
  });

  describe('Nghiệm thu 4: Log còn sau khi process chết (Tiêu chí cốt lõi)', () => {
    it('Tình huống 1: Process hoàn tất bình thường (exit 0) — log tồn tại nguyên vẹn trong DB', async () => {
      runRepo.create({
        id: 'run-normal-exit',
        task_id: 'TASK-AGY-003',
      });

      const script = `
        console.log("Success message 1");
        console.log("Success message 2");
        console.log(JSON.stringify({ type: "result", status: "SUCCESS" }));
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());

      const recorder = attachExecutionStream({
        runId: 'run-normal-exit',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      await recorder.waitForCompletion();

      // Tiến trình đã kết thúc hoàn toàn
      expect(handle.isRunning()).toBe(false);

      // Truy vấn trực tiếp từ bảng events trong SQLite
      const logs = eventRepo.getRawLogs('run-normal-exit');
      expect(logs.map((l) => l.text)).toEqual([
        'Success message 1',
        'Success message 2',
        JSON.stringify({ type: 'result', status: 'SUCCESS' }),
      ]);

      const run = runRepo.getById('run-normal-exit');
      expect(run?.status).toBe('SUCCESS');
      expect(run?.exit_code).toBe(0);
    });

    it('Tình huống 2: Process kết thúc với mã lỗi (exit != 0) — log và stderr còn nguyên trong DB', async () => {
      runRepo.create({
        id: 'run-error-exit',
        task_id: 'TASK-AGY-003',
      });

      const script = `
        console.log("Running before failure");
        console.error("Fatal error message on stderr");
        process.exit(17);
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-error-exit',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      await recorder.waitForCompletion();

      // Tiến trình đã chết
      expect(handle.isRunning()).toBe(false);

      // Log vẫn nằm trong SQLite
      const rawLogs = eventRepo.getRawLogs('run-error-exit');
      const texts = rawLogs.map((l) => l.text);
      expect(texts).toContain('Running before failure');
      expect(texts).toContain('Fatal error message on stderr');

      const events = eventRepo.findByRunId('run-error-exit');
      const exitEvent = events.find((e) => e.type === 'process_exit');
      expect((exitEvent?.payload as Record<string, unknown>).exitCode).toBe(17);

      const run = runRepo.getById('run-error-exit');
      expect(run?.status).toBe('ERROR');
      expect(run?.exit_code).toBe(17);
    });

    it('Tình huống 3: Process bị kill cưỡng bức (SIGTERM/SIGKILL) — dữ liệu log trước khi kill vẫn còn trong DB', async () => {
      runRepo.create({
        id: 'run-killed-process',
        task_id: 'TASK-AGY-003',
      });

      const script = `
        console.log("Log 1 before signal");
        console.log("Log 2 before signal");
        setInterval(() => {}, 5000);
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-killed-process',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      // Chờ cho đến khi log thứ 2 đã được ghi nhận vào DB
      await new Promise<void>((resolve) => {
        recorder.on('stdout', (record) => {
          if ((record.payload as Record<string, unknown>).text === 'Log 2 before signal') {
            resolve();
          }
        });
      });

      // Cưỡng bức kill tiến trình
      handle.kill('SIGKILL');
      await recorder.waitForCompletion();

      // Tiến trình đã chết
      expect(handle.isRunning()).toBe(false);

      // Bảng events trong SQLite vẫn lưu trọn vẹn các log trước thời điểm bị kill
      const rawLogs = eventRepo.getRawLogs('run-killed-process');
      const texts = rawLogs.map((l) => l.text);
      expect(texts).toContain('Log 1 before signal');
      expect(texts).toContain('Log 2 before signal');
    });

    it('Tình huống 4: Process bị crash do uncaught exception — log crash vẫn nằm trong DB', async () => {
      runRepo.create({
        id: 'run-crash-exception',
        task_id: 'TASK-AGY-003',
      });

      const script = `
        console.log("Log before unhandled exception");
        throw new Error("UNCAUGHT_FATAL_EXCEPTION");
      `;

      const handle = adapter.spawn('node', ['-e', script], process.cwd());
      const recorder = attachExecutionStream({
        runId: 'run-crash-exception',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      await recorder.waitForCompletion();

      // Tiến trình đã chết
      expect(handle.isRunning()).toBe(false);

      // Log và stderr chứa stack trace ngoại lệ vẫn còn nguyên trong SQLite
      const rawLogs = eventRepo.getRawLogs('run-crash-exception');
      const stdoutLogs = rawLogs.filter((l) => l.type === 'stdout');
      const stderrLogs = rawLogs.filter((l) => l.type === 'stderr');

      expect(stdoutLogs.map((l) => l.text)).toContain('Log before unhandled exception');
      expect(stderrLogs.some((l) => l.text.includes('UNCAUGHT_FATAL_EXCEPTION'))).toBe(true);
    });
  });

  describe('Nghiệm thu 5: Độc lập sau khi ProcessAdapter giải phóng bộ nhớ', () => {
    it('truy vấn trực tiếp DB từ kết nối mới vẫn đọc được đầy đủ sự kiện', async () => {
      runRepo.create({
        id: 'run-memory-test',
        task_id: 'TASK-AGY-003',
      });

      const handle = adapter.spawn(
        'node',
        ['-e', 'console.log(JSON.stringify({ type: "persistent_event", value: 999 }));'],
        process.cwd(),
      );

      const recorder = attachExecutionStream({
        runId: 'run-memory-test',
        handle,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      await recorder.waitForCompletion();

      // Tạo một EventRepository instance hoàn toàn mới trên cùng DB
      const freshEventRepo = new EventRepository(db);
      const events = freshEventRepo.findByRunId('run-memory-test');

      const found = events.find((e) => e.type === 'persistent_event');
      expect(found).toBeDefined();
      expect(found?.payload).toEqual({ type: 'persistent_event', value: 999 });
    });
  });
});
