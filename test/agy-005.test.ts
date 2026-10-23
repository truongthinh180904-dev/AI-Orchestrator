import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  RunRepository,
  EventRepository,
} from '../packages/db/src/index.js';
import {
  type EventRecord,
} from '../packages/shared/src/index.js';
import {
  processAdapter,
  createExecutionManager,
  stop,
  defaultExecutionManager,
} from '../apps/orchestrator/src/adapters/index.js';
import type Database from 'better-sqlite3';

async function waitForFile(filePath: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for file: ${filePath}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('AGY-005 Acceptance Tests: Timeout: SIGTERM → chờ grace → SIGKILL; hàm stop(runId) — Process treo bị dừng đúng hạn', () => {
  let tmpDir: string;
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let runRepo: RunRepository;
  let eventRepo: EventRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy005-acceptance-'));
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    runRepo = new RunRepository(db);
    eventRepo = new EventRepository(db);

    taskRepo.create({
      id: 'TASK-001',
      title: 'Acceptance Task 1',
    });

    defaultExecutionManager.clearAll();
  });

  afterEach(async () => {
    await defaultExecutionManager.stopAll({ gracePeriodMs: 50 });
    defaultExecutionManager.clearAll();
    db.close();
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('Nghiệm thu 1: Cơ chế dừng tiến trình SIGTERM → chờ grace → SIGKILL (ProcessHandle.terminate)', () => {
    it('1.1: Tiến trình hợp tác kết thúc bằng SIGTERM trong thời gian grace mà không cần gửi SIGKILL', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'setInterval(() => {}, 1000);'],
        cwd: tmpDir,
      });

      expect(handle.isRunning()).toBe(true);

      const startTime = Date.now();
      const exitResult = await handle.terminate({
        gracePeriodMs: 500,
        signal: 'SIGTERM',
      });
      const elapsed = Date.now() - startTime;

      expect(handle.isRunning()).toBe(false);
      expect(exitResult.signal).toBe('SIGTERM');
      // Thoát ngay khi nhận SIGTERM, không phải chờ hết 500ms grace
      expect(elapsed).toBeLessThan(350);
    });

    it('1.2: Tiến trình ngoan cố (bỏ qua SIGTERM) bị SIGKILL tiêu diệt ngay sau khi thời gian grace kết thúc', async () => {
      const readyFile = path.join(tmpDir, `ready-acceptance-1.txt`);
      // Mock script bắt SIGTERM và không thoát (simulate hung/frozen process)
      const handle = processAdapter.spawn({
        exe: 'node',
        args: [
          '-e',
          `const fs = require('fs'); process.on("SIGTERM", () => { console.log("IGNORING_SIGTERM"); }); fs.writeFileSync(${JSON.stringify(readyFile)}, '1'); setInterval(() => {}, 1000);`,
        ],
        cwd: tmpDir,
      });

      await waitForFile(readyFile);
      expect(handle.isRunning()).toBe(true);

      const startTime = Date.now();
      const exitResult = await handle.terminate({
        gracePeriodMs: 100,
        signal: 'SIGTERM',
        forceSignal: 'SIGKILL',
      });
      const elapsed = Date.now() - startTime;

      // Phải chờ đủ ít nhất 100ms grace period trước khi phát SIGKILL
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(handle.isRunning()).toBe(false);
      expect(exitResult.signal).toBe('SIGKILL');
    });

    it('1.3: Dọn dẹp timer khi tiến trình thoát sớm, không rò rỉ timer hay zombie process', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'setTimeout(() => process.exit(0), 30);'],
        cwd: tmpDir,
      });

      // Gặp gracePeriodMs lớn (10 giây) nhưng tiến trình kết thúc tự nhiên
      const exitResult = await handle.terminate({
        gracePeriodMs: 10_000,
      });

      expect(handle.isRunning()).toBe(false);
      expect(exitResult.exitCode !== null || exitResult.signal !== null).toBe(true);
    });

    it('1.4: Hỗ trợ tiêu diệt nhóm tiến trình con khi detached: true (process group kill)', async () => {
      const handle = processAdapter.spawn({
        exe: 'node',
        args: ['-e', 'setInterval(() => {}, 1000);'],
        cwd: tmpDir,
        detached: true,
      });

      expect(handle.command.detached).toBe(true);
      expect(handle.isRunning()).toBe(true);

      const exitResult = await handle.terminate({
        gracePeriodMs: 100,
        signal: 'SIGTERM',
      });

      expect(handle.isRunning()).toBe(false);
      expect(exitResult.signal).toBe('SIGTERM');
    });
  });

  describe('Nghiệm thu 2: Timeout tự động — Process treo bị dừng đúng hạn', () => {
    it('2.1: Tiến trình treo quá hạn timeoutMs bị ngắt tự động và cập nhật trạng thái TIMEOUT trong DB', async () => {
      const manager = createExecutionManager({ defaultGracePeriodMs: 80 });
      const runId = 'acceptance-timeout-normal';

      runRepo.create({
        id: runId,
        task_id: 'TASK-001',
        status: 'RUNNING',
      });

      const managed = manager.startRun({
        runId,
        taskId: 'TASK-TIMEOUT-1',
        command: {
          exe: 'node',
          args: ['-e', 'setInterval(() => {}, 1000);'],
          cwd: tmpDir,
        },
        timeoutMs: 100,
        gracePeriodMs: 80,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const startTime = Date.now();
      const result = await managed.waitForCompletion();
      const elapsed = Date.now() - startTime;

      // Tiến trình bị dừng đúng hạn sau khoảng timeoutMs (100ms)
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(managed.isTimeout).toBe(true);
      expect(managed.isRunning()).toBe(false);
      expect('status' in result && result.status).toBe('TIMEOUT');

      // Kiểm tra trạng thái trong SQLite DB
      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('TIMEOUT');
      expect(dbRun?.finished_at).toBeTruthy();

      // Kiểm tra event log trong DB
      const events = eventRepo.findByRunId(runId);
      const timeoutEvent = events.find((e: EventRecord) => e.type === 'process_timeout');
      expect(timeoutEvent).toBeDefined();
    });

    it('2.2: Tiến trình treo ngoan cố (bỏ qua SIGTERM) bị SIGKILL dừng đúng hạn sau khi hết grace', async () => {
      const manager = createExecutionManager();
      const runId = 'acceptance-timeout-stubborn';
      const readyFile = path.join(tmpDir, `ready-acceptance-2.txt`);

      runRepo.create({
        id: runId,
        task_id: 'TASK-001',
        status: 'RUNNING',
      });

      const managed = manager.startRun({
        runId,
        taskId: 'TASK-001',
        command: {
          exe: 'node',
          args: [
            '-e',
            `const fs = require('fs'); process.on("SIGTERM", () => {}); fs.writeFileSync(${JSON.stringify(readyFile)}, '1'); setInterval(() => {}, 1000);`,
          ],
          cwd: tmpDir,
        },
        timeoutMs: 500,
        gracePeriodMs: 200,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      await waitForFile(readyFile);
      const startTime = Date.now();
      const result = await managed.waitForCompletion();
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeGreaterThanOrEqual(100);
      expect(managed.isTimeout).toBe(true);
      expect(managed.isRunning()).toBe(false);
      expect('status' in result && result.status).toBe('TIMEOUT');
      expect('signal' in result && result.signal).toBe('SIGKILL');

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('TIMEOUT');
    });

    it('2.3: Tiến trình hoàn tất bình thường trước timeout không bị ngắt và hủy timer timeout', async () => {
      const manager = createExecutionManager();
      const runId = 'acceptance-timeout-normal-ok';

      runRepo.create({
        id: runId,
        task_id: 'TASK-001',
        status: 'RUNNING',
      });

      const managed = manager.startRun({
        runId,
        taskId: 'TASK-TIMEOUT-3',
        command: {
          exe: 'node',
          args: [
            '-e',
            'console.log(JSON.stringify({ type: "result", status: "SUCCESS" }));',
          ],
          cwd: tmpDir,
        },
        timeoutMs: 2000,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const result = await managed.waitForCompletion();
      expect(managed.isTimeout).toBe(false);
      expect('status' in result && result.status).toBe('SUCCESS');

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('SUCCESS');

      // Chờ một khoảng sau để chắc chắn timer timeout đã bị hủy và không kích hoạt sai
      await new Promise((r) => setTimeout(r, 50));
      expect(managed.isTimeout).toBe(false);
    });
  });

  describe('Nghiệm thu 3: Hàm stop(runId) dừng tiến trình theo yêu cầu', () => {
    it('3.1: Gọi stop(runId) dừng tiến trình đang chạy và cập nhật CANCELLED trong DB', async () => {
      const manager = createExecutionManager();
      const runId = 'acceptance-stop-1';

      runRepo.create({
        id: runId,
        task_id: 'TASK-001',
        status: 'RUNNING',
      });

      const managed = manager.startRun({
        runId,
        taskId: 'TASK-STOP-1',
        command: {
          exe: 'node',
          args: ['-e', 'setInterval(() => {}, 1000);'],
          cwd: tmpDir,
        },
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      expect(manager.isRunning(runId)).toBe(true);

      const stopped = await manager.stop(runId, {
        reason: 'User pressed abort button in dashboard',
        gracePeriodMs: 80,
      });

      expect(stopped).toBe(true);
      expect(managed.isCancelled).toBe(true);
      expect(managed.isRunning()).toBe(false);

      const result = await managed.waitForCompletion();
      expect('status' in result && result.status).toBe('CANCELLED');

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('CANCELLED');

      const events = eventRepo.findByRunId(runId);
      const stopEvent = events.find((e: EventRecord) => e.type === 'process_stopped');
      expect(stopEvent).toBeDefined();
      expect((stopEvent?.payload as Record<string, unknown>)?.reason).toBe(
        'User pressed abort button in dashboard',
      );
    });

    it('3.2: stop(runId) đối với tiến trình ngoan cố: SIGTERM → chờ grace → SIGKILL', async () => {
      const manager = createExecutionManager();
      const runId = 'acceptance-stop-stubborn';
      const readyFile = path.join(tmpDir, `ready-acceptance-3.txt`);

      runRepo.create({
        id: runId,
        task_id: 'TASK-001',
        status: 'RUNNING',
      });

      const managed = manager.startRun({
        runId,
        taskId: 'TASK-001',
        command: {
          exe: 'node',
          args: [
            '-e',
            `const fs = require('fs'); process.on("SIGTERM", () => {}); fs.writeFileSync(${JSON.stringify(readyFile)}, '1'); setInterval(() => {}, 1000);`,
          ],
          cwd: tmpDir,
        },
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      await waitForFile(readyFile);
      const startTime = Date.now();
      const stopped = await manager.stop(runId, { gracePeriodMs: 90 });
      const elapsed = Date.now() - startTime;

      expect(stopped).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(managed.isRunning()).toBe(false);

      const result = await managed.waitForCompletion();
      expect('status' in result && result.status).toBe('CANCELLED');
      expect('signal' in result && result.signal).toBe('SIGKILL');

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('CANCELLED');
    });

    it('3.3: stop(runId) hủy timer timeout trước đó để không bị kích hoạt timeout', async () => {
      const manager = createExecutionManager();
      const runId = 'acceptance-stop-cancel-timeout';

      runRepo.create({
        id: runId,
        task_id: 'TASK-001',
        status: 'RUNNING',
      });

      const managed = manager.startRun({
        runId,
        taskId: 'TASK-STOP-3',
        command: {
          exe: 'node',
          args: ['-e', 'setInterval(() => {}, 1000);'],
          cwd: tmpDir,
        },
        timeoutMs: 400,
        gracePeriodMs: 60,
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      const stopped = await manager.stop(runId, { gracePeriodMs: 50 });
      expect(stopped).toBe(true);

      // Chờ qua mốc timeout 400ms ban đầu
      await new Promise((r) => setTimeout(r, 450));

      expect(managed.isTimeout).toBe(false);
      expect(managed.isCancelled).toBe(true);

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('CANCELLED');
    });

    it('3.4: stop(runId) trả về false khi runId không tồn tại hoặc tiến trình đã kết thúc', async () => {
      const manager = createExecutionManager();

      const notFound = await manager.stop('unknown-run-id');
      expect(notFound).toBe(false);

      const runId = 'acceptance-stop-already-dead';
      const managed = manager.startRun({
        runId,
        command: {
          exe: 'node',
          args: ['-e', 'process.exit(0);'],
          cwd: tmpDir,
        },
      });

      await managed.waitForCompletion();
      const deadStop = await manager.stop(runId);
      expect(deadStop).toBe(false);
    });

    it('3.5: Gọi hàm stop(runId) độc lập cấp module (default execution manager)', async () => {
      const runId = 'acceptance-standalone-stop';

      runRepo.create({
        id: runId,
        task_id: 'TASK-001',
        status: 'RUNNING',
      });

      const managed = defaultExecutionManager.startRun({
        runId,
        taskId: 'TASK-STANDALONE',
        command: {
          exe: 'node',
          args: ['-e', 'setInterval(() => {}, 1000);'],
          cwd: tmpDir,
        },
        eventRepository: eventRepo,
        runRepository: runRepo,
      });

      expect(defaultExecutionManager.isRunning(runId)).toBe(true);

      const stopped = await stop(runId, { gracePeriodMs: 60 });
      expect(stopped).toBe(true);

      const result = await managed.waitForCompletion();
      expect('status' in result && result.status).toBe('CANCELLED');

      const dbRun = runRepo.getById(runId);
      expect(dbRun?.status).toBe('CANCELLED');
    });
  });
});
