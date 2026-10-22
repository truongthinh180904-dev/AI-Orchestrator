import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  AgentLockRepository,
} from '../packages/db/src/index.js';
import {
  buildServer,
  RunService,
  TaskScheduler,
  createExecutionManager,
  type ExecutionManager,
} from '../apps/orchestrator/src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mockCliPath = path.resolve(__dirname, '../fixtures/mock-agy-cli.cjs');

describe('ORC-003 Acceptance Tests: Scheduler tuần tự, lock 1 agent, chống chạy trùng (transaction SQLite)', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let taskRepo: TaskRepository;
  let lockRepo: AgentLockRepository;
  let executionManager: ExecutionManager;
  let runService: RunService;
  let scheduler: TaskScheduler;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    lockRepo = new AgentLockRepository(db);
    executionManager = createExecutionManager();

    runService = new RunService({
      db,
      executionManager,
      config: {
        AGY_BIN: 'node',
        AGY_ARGS: mockCliPath,
      },
    });

    scheduler = new TaskScheduler({
      db,
      runService,
      autoVerify: true,
    });

    server = await buildServer({
      db,
      executionManager,
      taskScheduler: scheduler,
      logger: false,
    });
    await server.ready();
  });

  afterEach(async () => {
    await scheduler.stop(true);
    await executionManager.stopAll();
    await server.close();
    db.close();
  });

  describe('Tiêu chí 1: Nghiệm thu ROADMAP — Test gọi đồng thời không chạy 2 task', () => {
    it('1.1: Gọi đồng thời acquireNextTask() trên nhiều task READY — Chỉ DUY NHẤT 1 task được acquire', async () => {
      taskRepo.create({
        id: 'CONC-TASK-1',
        title: 'Concurrent Task 1',
        priority: 100,
        status: 'READY',
      });
      taskRepo.create({
        id: 'CONC-TASK-2',
        title: 'Concurrent Task 2',
        priority: 90,
        status: 'READY',
      });
      taskRepo.create({
        id: 'CONC-TASK-3',
        title: 'Concurrent Task 3',
        priority: 80,
        status: 'READY',
      });

      // Bắn 10 lời gọi đồng thời
      const promises = Array.from({ length: 10 }, () =>
        Promise.resolve(scheduler.acquireNextTask()),
      );
      const results = await Promise.all(promises);

      const acquiredList = results.filter((r) => r.acquired);
      const rejectedList = results.filter((r) => !r.acquired);

      expect(acquiredList.length).toBe(1);
      expect(rejectedList.length).toBe(9);
      expect(acquiredList[0]?.task?.id).toBe('CONC-TASK-1');

      // Kiểm tra trong DB: chỉ có đúng 1 task có status = RUNNING
      const runningInDb = taskRepo.findAll({ status: 'RUNNING' });
      expect(runningInDb.length).toBe(1);
      expect(runningInDb[0]?.id).toBe('CONC-TASK-1');

      // Các task khác vẫn ở trạng thái READY
      expect(taskRepo.findById('CONC-TASK-2')?.status).toBe('READY');
      expect(taskRepo.findById('CONC-TASK-3')?.status).toBe('READY');
    });

    it('1.2: Gọi đồng thời step() — Chỉ 1 task được thực thi và hoàn thành, các lời gọi khác bị từ chối an toàn', async () => {
      taskRepo.create({
        id: 'STEP-PAR-1',
        title: 'Parallel Step 1',
        priority: 50,
        status: 'READY',
        repository: '.',
      });
      taskRepo.create({
        id: 'STEP-PAR-2',
        title: 'Parallel Step 2',
        priority: 40,
        status: 'READY',
        repository: '.',
      });

      // 4 lời gọi step() đồng thời
      const [res1, res2, res3, res4] = await Promise.all([
        scheduler.step(),
        scheduler.step(),
        scheduler.step(),
        scheduler.step(),
      ]);

      const executed = [res1, res2, res3, res4].filter((r) => r.executed);
      const rejected = [res1, res2, res3, res4].filter((r) => !r.executed);

      expect(executed.length).toBe(1);
      expect(rejected.length).toBe(3);
      expect(executed[0]?.taskId).toBe('STEP-PAR-1');
      expect(executed[0]?.status).toBe('DONE');

      // Sau khi STEP-PAR-1 hoàn thành, lock được tự động giải phóng
      expect(lockRepo.isLocked('default_agent')).toBe(false);

      // Lần gọi step tiếp theo sẽ chạy STEP-PAR-2 tuần tự
      const nextRes = await scheduler.step();
      expect(nextRes.executed).toBe(true);
      expect(nextRes.taskId).toBe('STEP-PAR-2');
      expect(nextRes.status).toBe('DONE');
    });

    it('1.3: Gọi đồng thời qua REST API POST /scheduler/next — Không bao giờ chạy trùng 2 task', async () => {
      taskRepo.create({
        id: 'API-CONC-1',
        title: 'API Concurrent 1',
        priority: 200,
        status: 'READY',
        repository: '.',
      });
      taskRepo.create({
        id: 'API-CONC-2',
        title: 'API Concurrent 2',
        priority: 100,
        status: 'READY',
        repository: '.',
      });

      // Bắn đồng thời 4 requests POST /scheduler/next
      const responses = await Promise.all([
        server.inject({ method: 'POST', url: '/scheduler/next' }),
        server.inject({ method: 'POST', url: '/scheduler/next' }),
        server.inject({ method: 'POST', url: '/scheduler/next' }),
        server.inject({ method: 'POST', url: '/scheduler/next' }),
      ]);

      expect(responses.every((res) => res.statusCode === 200)).toBe(true);

      const bodies = responses.map(
        (r) => JSON.parse(r.body) as { data: { executed: boolean; taskId?: string } },
      );
      const executed = bodies.filter((b) => b.data.executed);
      const rejected = bodies.filter((b) => !b.data.executed);

      expect(executed.length).toBe(1);
      expect(rejected.length).toBe(3);
      expect(executed[0]?.data.taskId).toBe('API-CONC-1');
    });

    it('1.4: Gọi trực tiếp POST /runs khi task đang chạy — Bị chặn với mã 409 CONCURRENCY_LIMIT_EXCEEDED', async () => {
      taskRepo.create({
        id: 'TASK-HOLD',
        title: 'Task holding lock',
        status: 'READY',
        repository: '.',
      });
      taskRepo.create({
        id: 'TASK-INTRUDER',
        title: 'Task trying to intrude',
        status: 'READY',
        repository: '.',
      });

      // Khóa agent bằng task thứ nhất
      const acquire = scheduler.acquireNextTask();
      expect(acquire.acquired).toBe(true);
      expect(acquire.task?.id).toBe('TASK-HOLD');

      // Cố tình gọi trực tiếp POST /runs với task khác
      const res = await server.inject({
        method: 'POST',
        url: '/runs',
        payload: {
          taskId: 'TASK-INTRUDER',
        },
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('AGENT_LOCK_HELD');
    });
  });

  describe('Tiêu chí 2: Scheduler tuần tự (Sequential Scheduling & Priority Ordering)', () => {
    it('2.1: Chạy tuần tự chuỗi phụ thuộc tuyến tính (T1 -> T2 -> T3)', async () => {
      taskRepo.create({
        id: 'CHAIN-1',
        title: 'Chain Step 1',
        status: 'READY',
        repository: '.',
      });
      taskRepo.create({
        id: 'CHAIN-2',
        title: 'Chain Step 2',
        dependencies: ['CHAIN-1'],
        status: 'TODO',
        repository: '.',
      });
      taskRepo.create({
        id: 'CHAIN-3',
        title: 'Chain Step 3',
        dependencies: ['CHAIN-2'],
        status: 'TODO',
        repository: '.',
      });

      const results = await scheduler.runUntilEmpty();

      expect(results.length).toBe(3);
      expect(results.map((r) => r.taskId)).toEqual(['CHAIN-1', 'CHAIN-2', 'CHAIN-3']);
      expect(results.every((r) => r.status === 'DONE')).toBe(true);

      expect(taskRepo.findById('CHAIN-1')?.status).toBe('DONE');
      expect(taskRepo.findById('CHAIN-2')?.status).toBe('DONE');
      expect(taskRepo.findById('CHAIN-3')?.status).toBe('DONE');
    });

    it('2.2: Sắp xếp theo mức độ ưu tiên Priority giảm dần', async () => {
      taskRepo.create({
        id: 'PRIO-LOW',
        title: 'Low Priority',
        priority: 10,
        status: 'READY',
        repository: '.',
      });
      taskRepo.create({
        id: 'PRIO-HIGH',
        title: 'High Priority',
        priority: 99,
        status: 'READY',
        repository: '.',
      });
      taskRepo.create({
        id: 'PRIO-MED',
        title: 'Medium Priority',
        priority: 50,
        status: 'READY',
        repository: '.',
      });

      const results = await scheduler.runUntilEmpty();

      expect(results.length).toBe(3);
      expect(results.map((r) => r.taskId)).toEqual(['PRIO-HIGH', 'PRIO-MED', 'PRIO-LOW']);
    });
  });

  describe('Tiêu chí 3: Lock 1 agent trong SQLite Transaction (Agent Lock & Durability)', () => {
    it('3.1: Bảng agent_locks lưu thông tin lock khi task đang chạy và xóa khi hoàn tất', async () => {
      taskRepo.create({
        id: 'LOCK-DURABLE',
        title: 'Durable Lock Test',
        status: 'READY',
        repository: '.',
      });

      expect(lockRepo.isLocked('default_agent')).toBe(false);

      const acquire = scheduler.acquireNextTask();
      expect(acquire.acquired).toBe(true);
      expect(lockRepo.isLocked('default_agent')).toBe(true);

      const currentLock = lockRepo.getCurrentLock('default_agent');
      expect(currentLock).not.toBeNull();
      expect(currentLock?.task_id).toBe('LOCK-DURABLE');
      expect(currentLock?.owner_pid).toBe(process.pid);
      expect(currentLock?.acquired_at).toBeTruthy();

      // Release lock
      lockRepo.release('default_agent', 'LOCK-DURABLE');
      expect(lockRepo.isLocked('default_agent')).toBe(false);
      expect(lockRepo.getCurrentLock('default_agent')).toBeNull();
    });

    it('3.2: Tự động phục hồi khi có Stale Lock mồ côi (Task không còn active)', () => {
      taskRepo.create({
        id: 'ORPHAN-TASK',
        title: 'Orphan Task',
        status: 'DONE', // Task đã DONE
      });
      taskRepo.create({
        id: 'ACTIVE-CANDIDATE',
        title: 'Active Candidate',
        status: 'READY',
      });

      // Giả lập lock bị sót lại do tiến trình trước bị crash
      lockRepo.acquire({
        id: 'default_agent',
        task_id: 'ORPHAN-TASK',
      });
      expect(lockRepo.isLocked('default_agent')).toBe(true);

      // acquireNextTask phát hiện ORPHAN-TASK không còn active, tự xóa lock và nhận ACTIVE-CANDIDATE
      const acquire = scheduler.acquireNextTask();
      expect(acquire.acquired).toBe(true);
      expect(acquire.task?.id).toBe('ACTIVE-CANDIDATE');
      expect(lockRepo.getCurrentLock('default_agent')?.task_id).toBe('ACTIVE-CANDIDATE');
    });
  });

  describe('Tiêu chí 4: Điều khiển REST API (/scheduler/status, /pause, /resume, /stop, /release-lock)', () => {
    it('4.1: GET /scheduler/status trả về trạng thái thời gian thực', async () => {
      taskRepo.create({
        id: 'STATUS-TASK',
        title: 'Status Task',
        status: 'READY',
      });

      const res = await server.inject({
        method: 'GET',
        url: '/scheduler/status',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as {
        data: { isRunning: boolean; isPaused: boolean; readyTasksCount: number };
      };
      expect(body.data.isRunning).toBe(false);
      expect(body.data.isPaused).toBe(false);
      expect(body.data.readyTasksCount).toBe(1);
    });

    it('4.2: POST /scheduler/pause và POST /scheduler/resume', async () => {
      taskRepo.create({
        id: 'PAUSE-TASK',
        title: 'Pause API Task',
        status: 'READY',
        repository: '.',
      });

      // Pause
      const pauseRes = await server.inject({ method: 'POST', url: '/scheduler/pause' });
      expect(pauseRes.statusCode).toBe(200);
      expect(scheduler.isPaused).toBe(true);

      // Gọi next khi paused: không chạy
      const nextRes = await server.inject({ method: 'POST', url: '/scheduler/next' });
      const nextBody = JSON.parse(nextRes.body) as { data: { executed: boolean; reason: string } };
      expect(nextBody.data.executed).toBe(false);
      expect(nextBody.data.reason).toBe('SCHEDULER_PAUSED');

      // Resume
      const resumeRes = await server.inject({ method: 'POST', url: '/scheduler/resume' });
      expect(resumeRes.statusCode).toBe(200);
      expect(scheduler.isPaused).toBe(false);

      // Gọi next khi resumed: chạy thành công
      const runRes = await server.inject({ method: 'POST', url: '/scheduler/next' });
      const runBody = JSON.parse(runRes.body) as { data: { executed: boolean; taskId: string } };
      expect(runBody.data.executed).toBe(true);
      expect(runBody.data.taskId).toBe('PAUSE-TASK');
    });

    it('4.3: POST /scheduler/release-lock cưỡng bức giải phóng lock', async () => {
      taskRepo.create({
        id: 'FORCE-TASK',
        title: 'Force Release Task',
        status: 'READY',
      });

      scheduler.acquireNextTask();
      expect(lockRepo.isLocked('default_agent')).toBe(true);

      const res = await server.inject({
        method: 'POST',
        url: '/scheduler/release-lock',
      });

      expect(res.statusCode).toBe(200);
      expect(lockRepo.isLocked('default_agent')).toBe(false);
    });
  });
});
