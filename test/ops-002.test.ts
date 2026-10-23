import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
} from '../packages/db/src/index.js';
import type { TaskStatus } from '../packages/shared/src/index.js';
import { buildServer } from '../apps/orchestrator/src/server.js';
import { ExecutionScheduleManager } from '../apps/orchestrator/src/services/execution-schedule-manager.js';
import { TaskScheduler } from '../apps/orchestrator/src/services/task-scheduler.js';
import { RunService } from '../apps/orchestrator/src/services/run-service.js';
import { ExecutionManager } from '../apps/orchestrator/src/adapters/execution-manager.js';

describe('OPS-002: Lịch chạy theo khung giờ — Tuân thủ lịch', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let simulatedDate: Date;
  const mockClock = () => simulatedDate;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    // Baseline: 2026-10-26 (Monday) 10:00:00 UTC
    simulatedDate = new Date('2026-10-26T10:00:00.000Z');

    db.prepare(
      "INSERT INTO features (id, name, created_at, updated_at) VALUES ('FEAT-OPS', 'OPS Feature', datetime('now'), datetime('now'))",
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  function createTestTask(id: string, status: TaskStatus = 'READY', priority = 10) {
    return taskRepo.create({
      id,
      feature_id: 'FEAT-OPS',
      title: `Task ${id}`,
      status,
      priority,
    });
  }

  describe('1. Tuân thủ Khung Giờ Cho Phép (ALLOW mode)', () => {
    it('1.1: Trong khung giờ — cho phép chạy và cung cấp thông tin window + windowEnd', () => {
      const manager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          enabled: true,
          mode: 'ALLOW',
          timezone: 'UTC',
          windows: [
            {
              name: 'Morning Window',
              start: '09:00',
              end: '12:00',
              days: [1, 2, 3, 4, 5],
            },
          ],
        },
      });

      // 10:00 UTC Monday -> Trong khung giờ
      simulatedDate = new Date('2026-10-26T10:00:00.000Z');
      const evalResult = manager.canExecute();

      expect(evalResult.allowed).toBe(true);
      expect(evalResult.reason).toBe('INSIDE_ALLOWED_WINDOW');
      expect(evalResult.currentWindow?.name).toBe('Morning Window');
      expect(evalResult.windowEnd).toBeDefined();
      expect(manager.isAllowed()).toBe(true);
    });

    it('1.2: Ngoài khung giờ — từ chối chạy và tính toán thời gian tới window tiếp theo', () => {
      const manager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          enabled: true,
          mode: 'ALLOW',
          timezone: 'UTC',
          windows: [
            {
              name: 'Afternoon Window',
              start: '14:00',
              end: '18:00',
              days: [1, 2, 3, 4, 5],
            },
          ],
        },
      });

      // 10:00 UTC Monday -> Ngoài khung giờ (window mở lúc 14:00)
      simulatedDate = new Date('2026-10-26T10:00:00.000Z');
      const evalResult = manager.canExecute();

      expect(evalResult.allowed).toBe(false);
      expect(evalResult.reason).toBe('OUTSIDE_ALLOWED_WINDOW');
      expect(evalResult.nextWindowStart).toBeDefined();
      expect(evalResult.msUntilNextWindow).toBe(4 * 60 * 60 * 1000); // 4 giờ nữa
      expect(manager.isAllowed()).toBe(false);
    });

    it('1.3: Chặn chạy khi mode ALLOW nhưng chưa cấu hình bất kỳ window nào', () => {
      const manager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          enabled: true,
          mode: 'ALLOW',
          windows: [],
        },
      });

      const evalResult = manager.canExecute();
      expect(evalResult.allowed).toBe(false);
      expect(evalResult.reason).toBe('NO_WINDOWS_CONFIGURED');
    });
  });

  describe('2. Khung Giờ Xuyên Đêm (Overnight / Cross-midnight Window)', () => {
    it('2.1: Chạy lúc đêm (trước nửa đêm, cùng ngày) — Cho phép chạy', () => {
      const manager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          enabled: true,
          mode: 'ALLOW',
          timezone: 'Asia/Ho_Chi_Minh',
          windows: [
            {
              name: 'Overnight Batch',
              start: '22:00',
              end: '06:00',
              days: [1, 2, 3, 4, 5], // Thứ 2 đến thứ 6
            },
          ],
        },
      });

      // 2026-10-26 23:30 VN (Thứ 2) -> 16:30 UTC
      simulatedDate = new Date('2026-10-26T16:30:00.000Z');
      const result = manager.canExecute();
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('INSIDE_ALLOWED_WINDOW');
      expect(result.currentWindow?.name).toBe('Overnight Batch');
    });

    it('2.2: Chạy rạng sáng hôm sau (sau nửa đêm) — Cho phép chạy', () => {
      const manager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          enabled: true,
          mode: 'ALLOW',
          timezone: 'Asia/Ho_Chi_Minh',
          windows: [
            {
              name: 'Overnight Batch',
              start: '22:00',
              end: '06:00',
              days: [1, 2, 3, 4, 5],
            },
          ],
        },
      });

      // 2026-10-27 03:15 VN (Thứ 3 rạng sáng, bắt đầu từ đêm thứ 2) -> 20:15 UTC ngày 26
      simulatedDate = new Date('2026-10-26T20:15:00.000Z');
      const result = manager.canExecute();
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('INSIDE_ALLOWED_WINDOW');
    });

    it('2.3: Ban ngày ngoài khung giờ xuyên đêm — Chặn chạy', () => {
      const manager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          enabled: true,
          mode: 'ALLOW',
          timezone: 'Asia/Ho_Chi_Minh',
          windows: [
            {
              name: 'Overnight Batch',
              start: '22:00',
              end: '06:00',
              days: [1, 2, 3, 4, 5],
            },
          ],
        },
      });

      // 2026-10-27 11:00 VN (Thứ 3 trưa) -> 04:00 UTC
      simulatedDate = new Date('2026-10-27T04:00:00.000Z');
      const result = manager.canExecute();
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('OUTSIDE_ALLOWED_WINDOW');
    });
  });

  describe('3. Giờ Dừng Bắt Buộc / Deadline (stop_at_hour)', () => {
    it('3.1: Dừng chạy khi chạm mốc stop_at_hour (theo chuẩn run-agy.sh STOP_AT_HOUR)', () => {
      const manager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          enabled: true,
          mode: 'ALLOW',
          timezone: 'UTC',
          windows: [
            {
              name: 'Overnight Window',
              start: '00:00',
              end: '12:00',
              days: [0, 1, 2, 3, 4, 5, 6],
            },
          ],
          stop_at_hour: 7, // Tự dừng lúc 07:00 sáng
        },
      });

      // 06:59:00 -> Vẫn được chạy
      simulatedDate = new Date('2026-10-26T06:59:00.000Z');
      expect(manager.canExecute().allowed).toBe(true);

      // 07:00:00 -> Đạt mốc deadline, dừng nhận task mới
      simulatedDate = new Date('2026-10-26T07:00:00.000Z');
      const pastDeadline = manager.canExecute();
      expect(pastDeadline.allowed).toBe(false);
      expect(pastDeadline.reason).toBe('DEADLINE_REACHED');
      expect(pastDeadline.message).toContain('Past deadline hour (7:00)');
    });
  });

  describe('4. Khung Giờ Chặn (BLOCK mode)', () => {
    it('4.1: Chặn chạy trong giờ cao điểm, cho phép chạy ngoài giờ', () => {
      const manager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          enabled: true,
          mode: 'BLOCK',
          timezone: 'UTC',
          windows: [
            {
              name: 'Peak Business Hours',
              start: '09:00',
              end: '17:00',
              days: [1, 2, 3, 4, 5],
            },
          ],
        },
      });

      // 14:00 UTC Monday -> Trong giờ cao điểm -> Bị chặn
      simulatedDate = new Date('2026-10-26T14:00:00.000Z');
      const peakCheck = manager.canExecute();
      expect(peakCheck.allowed).toBe(false);
      expect(peakCheck.reason).toBe('INSIDE_BLOCKED_WINDOW');

      // 20:00 UTC Monday -> Ngoài giờ cao điểm -> Được phép
      simulatedDate = new Date('2026-10-26T20:00:00.000Z');
      const offPeakCheck = manager.canExecute();
      expect(offPeakCheck.allowed).toBe(true);
      expect(offPeakCheck.reason).toBe('OUTSIDE_BLOCKED_WINDOW');
    });
  });

  describe('5. Chế độ Không Giới Hạn (ALWAYS) & Tắt Lịch (enabled: false)', () => {
    it('5.1: Chế độ ALWAYS cho phép chạy 24/7 bất kể thời gian', () => {
      const manager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          enabled: true,
          mode: 'ALWAYS',
          windows: [{ start: '22:00', end: '06:00' }],
        },
      });

      simulatedDate = new Date('2026-10-26T12:00:00.000Z');
      const result = manager.canExecute();
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('MODE_ALWAYS');
    });

    it('5.2: Tắt lịch (enabled: false) tạm dừng kiểm tra lịch', () => {
      const manager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          enabled: false,
          mode: 'ALLOW',
          windows: [{ start: '22:00', end: '06:00' }],
        },
      });

      simulatedDate = new Date('2026-10-26T12:00:00.000Z');
      const result = manager.canExecute();
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('SCHEDULE_DISABLED');
    });
  });

  describe('6. Tích Hợp TaskScheduler Tuân Thủ Lịch', () => {
    it('6.1: acquireNextTask từ chối khi ngoài khung giờ cho phép', () => {
      createTestTask('TSK-SCHED-1', 'READY');

      const scheduleManager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          enabled: true,
          mode: 'ALLOW',
          timezone: 'UTC',
          windows: [{ start: '22:00', end: '06:00' }],
        },
      });

      // Clock đang 10:00 UTC (ngoài khung 22:00 - 06:00)
      simulatedDate = new Date('2026-10-26T10:00:00.000Z');

      const executionManager = new ExecutionManager();
      const runService = new RunService({ db, executionManager });
      const scheduler = new TaskScheduler({
        db,
        runService,
        executionScheduleManager: scheduleManager,
      });

      const acquireResult = scheduler.acquireNextTask();
      expect(acquireResult.acquired).toBe(false);
      expect(acquireResult.reason).toBe('OUTSIDE_SCHEDULE_WINDOW');
      expect(acquireResult.scheduleResult?.allowed).toBe(false);
      expect(acquireResult.scheduleResult?.reason).toBe('OUTSIDE_ALLOWED_WINDOW');

      // Task trong DB vẫn giữ nguyên trạng thái READY, không bị chuyển bậy sang RUNNING
      const task = taskRepo.findById('TSK-SCHED-1');
      expect(task?.status).toBe('READY');
      expect(task?.attempts).toBe(0);
    });

    it('6.2: acquireNextTask thành công khi trong khung giờ cho phép', () => {
      createTestTask('TSK-SCHED-2', 'READY');

      const scheduleManager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          enabled: true,
          mode: 'ALLOW',
          timezone: 'UTC',
          windows: [{ start: '22:00', end: '06:00' }],
        },
      });

      // Chuyển clock tới 23:00 UTC (trong khung 22:00 - 06:00)
      simulatedDate = new Date('2026-10-26T23:00:00.000Z');

      const executionManager = new ExecutionManager();
      const runService = new RunService({ db, executionManager });
      const scheduler = new TaskScheduler({
        db,
        runService,
        executionScheduleManager: scheduleManager,
      });

      const acquireResult = scheduler.acquireNextTask();
      expect(acquireResult.acquired).toBe(true);
      expect(acquireResult.task?.id).toBe('TSK-SCHED-2');
      expect(acquireResult.task?.status).toBe('RUNNING');

      // Giải phóng lock để dọn dẹp
      scheduler.releaseLock();
    });

    it('6.3: step() từ chối thực thi khi ngoài khung giờ', async () => {
      createTestTask('TSK-SCHED-3', 'READY');

      const scheduleManager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          enabled: true,
          mode: 'ALLOW',
          windows: [{ start: '22:00', end: '06:00' }],
        },
      });

      simulatedDate = new Date('2026-10-26T10:00:00.000Z');

      const executionManager = new ExecutionManager();
      const runService = new RunService({ db, executionManager });
      const scheduler = new TaskScheduler({
        db,
        runService,
        executionScheduleManager: scheduleManager,
      });

      const stepResult = await scheduler.step();
      expect(stepResult.executed).toBe(false);
      expect(stepResult.reason).toBe('OUTSIDE_SCHEDULE_WINDOW');
    });

    it('6.4: runUntilEmpty() tự động dừng loop khi hết khung giờ', async () => {
      createTestTask('TSK-SCHED-4', 'READY');

      const scheduleManager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          enabled: true,
          mode: 'ALLOW',
          windows: [{ start: '22:00', end: '06:00' }],
        },
      });

      // Ngoài khung giờ
      simulatedDate = new Date('2026-10-26T10:00:00.000Z');

      const executionManager = new ExecutionManager();
      const runService = new RunService({ db, executionManager });
      const scheduler = new TaskScheduler({
        db,
        runService,
        executionScheduleManager: scheduleManager,
      });

      const loopResults = await scheduler.runUntilEmpty();
      expect(loopResults.length).toBe(0);
      expect(scheduler.isRunning).toBe(false);
    });

    it('6.5: getStatus() phản ánh scheduleStatus thời gian thực', () => {
      const scheduleManager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          name: 'Production Overnight',
          enabled: true,
          mode: 'ALLOW',
          windows: [{ start: '22:00', end: '06:00' }],
        },
      });

      simulatedDate = new Date('2026-10-26T10:00:00.000Z');

      const executionManager = new ExecutionManager();
      const runService = new RunService({ db, executionManager });
      const scheduler = new TaskScheduler({
        db,
        runService,
        executionScheduleManager: scheduleManager,
      });

      const status = scheduler.getStatus();
      expect(status.scheduleStatus).toBeDefined();
      expect(status.scheduleStatus.config.name).toBe('Production Overnight');
      expect(status.scheduleStatus.evaluation.allowed).toBe(false);
      expect(status.scheduleStatus.evaluation.reason).toBe('OUTSIDE_ALLOWED_WINDOW');
    });
  });

  describe('7. REST API Endpoints (/system/schedule)', () => {
    it('7.1: GET /system/schedule trả về HTTP 200 kèm cấu hình và đánh giá hiện tại', async () => {
      const scheduleManager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          id: 'test_sched',
          name: 'API Test Schedule',
          enabled: true,
          mode: 'ALLOW',
          windows: [{ start: '20:00', end: '04:00' }],
        },
      });

      simulatedDate = new Date('2026-10-26T10:00:00.000Z');

      const server = await buildServer({
        db,
        executionScheduleManager: scheduleManager,
      });

      try {
        const response = await server.inject({
          method: 'GET',
          url: '/system/schedule',
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.data.config.id).toBe('test_sched');
        expect(body.data.config.name).toBe('API Test Schedule');
        expect(body.data.evaluation.allowed).toBe(false);
        expect(body.data.evaluation.reason).toBe('OUTSIDE_ALLOWED_WINDOW');
      } finally {
        await server.close();
      }
    });

    it('7.2: PATCH /system/schedule cập nhật cấu hình khung giờ tức thì', async () => {
      const scheduleManager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          id: 'test_sched',
          enabled: true,
          mode: 'ALLOW',
          windows: [{ start: '20:00', end: '04:00' }],
        },
      });

      simulatedDate = new Date('2026-10-26T10:00:00.000Z');

      const server = await buildServer({
        db,
        executionScheduleManager: scheduleManager,
      });

      try {
        const patchRes = await server.inject({
          method: 'PATCH',
          url: '/system/schedule',
          payload: {
            mode: 'ALWAYS',
            stop_at_hour: 8,
          },
        });

        expect(patchRes.statusCode).toBe(200);
        const body = JSON.parse(patchRes.body);
        expect(body.data.success).toBe(true);
        expect(body.data.config.mode).toBe('ALWAYS');
        expect(body.data.config.stop_at_hour).toBe(8);

        // Đánh giá mới cho phép ngay lập tức
        expect(body.data.status.evaluation.allowed).toBe(true);
        expect(body.data.status.evaluation.reason).toBe('MODE_ALWAYS');
      } finally {
        await server.close();
      }
    });

    it('7.3: POST /system/schedule/evaluate kiểm tra một mốc thời gian bất kỳ', async () => {
      const scheduleManager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          enabled: true,
          mode: 'ALLOW',
          windows: [
            {
              name: 'Night',
              start: '22:00',
              end: '06:00',
            },
          ],
        },
      });

      const server = await buildServer({
        db,
        executionScheduleManager: scheduleManager,
      });

      try {
        // Kiểm tra mốc 23:30 (trong window)
        const resIn = await server.inject({
          method: 'POST',
          url: '/system/schedule/evaluate',
          payload: {
            timestamp: '2026-10-26T23:30:00.000Z',
          },
        });
        expect(resIn.statusCode).toBe(200);
        const bodyIn = JSON.parse(resIn.body);
        expect(bodyIn.data.allowed).toBe(true);
        expect(bodyIn.data.reason).toBe('INSIDE_ALLOWED_WINDOW');

        // Kiểm tra mốc 14:00 (ngoài window)
        const resOut = await server.inject({
          method: 'POST',
          url: '/system/schedule/evaluate',
          payload: {
            timestamp: '2026-10-26T14:00:00.000Z',
          },
        });
        expect(resOut.statusCode).toBe(200);
        const bodyOut = JSON.parse(resOut.body);
        expect(bodyOut.data.allowed).toBe(false);
        expect(bodyOut.data.reason).toBe('OUTSIDE_ALLOWED_WINDOW');
      } finally {
        await server.close();
      }
    });

    it('7.4: GET /system/schedule/events trả về danh sách sự kiện audit', async () => {
      const scheduleManager = new ExecutionScheduleManager({
        db,
        clock: mockClock,
        config: {
          id: 'audit_sched',
          enabled: true,
          mode: 'ALLOW',
          windows: [{ start: '22:00', end: '06:00' }],
        },
      });

      // Tạo một số sự kiện
      scheduleManager.recordEvent('WINDOW_ENTERED', { window: 'Overnight' });
      scheduleManager.recordEvent('DEADLINE_REACHED', { hour: 7 });

      const server = await buildServer({
        db,
        executionScheduleManager: scheduleManager,
      });

      try {
        const res = await server.inject({
          method: 'GET',
          url: '/system/schedule/events',
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.data.count).toBeGreaterThanOrEqual(2);
        expect(body.data.events.some((e: { event_type: string }) => e.event_type === 'WINDOW_ENTERED')).toBe(true);
        expect(body.data.events.some((e: { event_type: string }) => e.event_type === 'DEADLINE_REACHED')).toBe(true);
      } finally {
        await server.close();
      }
    });
  });
});
