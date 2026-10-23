import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  SystemResourceRepository,
} from '../packages/db/src/index.js';
import {
  type TaskStatus,
  type SystemResourceMetricsSample,
} from '../packages/shared/src/index.js';
import { buildServer } from '../apps/orchestrator/src/server.js';
import { SystemResourceMonitor } from '../apps/orchestrator/src/services/system-resource-monitor.js';
import { ResourceQuotaManager } from '../apps/orchestrator/src/services/resource-quota-manager.js';
import { TaskScheduler } from '../apps/orchestrator/src/services/task-scheduler.js';
import { RunService } from '../apps/orchestrator/src/services/run-service.js';
import { ExecutionManager } from '../apps/orchestrator/src/adapters/execution-manager.js';

describe('OPS-005: Giám sát CPU/RAM/disk, ngưỡng cảnh báo/dừng — Vượt ngưỡng → dừng nhận task', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let resourceRepo: SystemResourceRepository;
  let simulatedTime: number;
  const mockClock = () => simulatedTime;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    resourceRepo = new SystemResourceRepository(db);
    simulatedTime = 1_700_000_000_000;

    // Helper tạo feature mẫu
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

  describe('1. Giám sát CPU/RAM/disk thực tế và thu thập số liệu', () => {
    it('1.1: Giám sát thực tế từ hệ điều hành với đầy đủ CPU, Memory và Disk', () => {
      const monitor = new SystemResourceMonitor({
        db,
        clock: mockClock,
      });

      const sample = monitor.sampleMetrics();
      expect(sample.cpu.cores).toBeGreaterThanOrEqual(1);
      expect(sample.cpu.usagePercent).toBeGreaterThanOrEqual(0);
      expect(sample.cpu.usagePercent).toBeLessThanOrEqual(100);

      expect(sample.memory.totalBytes).toBeGreaterThan(0);
      expect(sample.memory.freeBytes).toBeGreaterThan(0);
      expect(sample.memory.usedPercent).toBeGreaterThanOrEqual(0);

      expect(sample.disk.totalBytes).toBeGreaterThan(0);
      expect(sample.disk.usedPercent).toBeGreaterThanOrEqual(0);

      const snapshot = monitor.evaluate();
      expect(['OK', 'WARNING', 'CRITICAL']).toContain(snapshot.status);
      expect(snapshot.timestamp).toBe(new Date(simulatedTime).toISOString());
    });
  });

  describe('2. Ngưỡng cảnh báo (WARNING) — Phát hiện cảnh báo nhưng KHÔNG dừng nhận task', () => {
    it('2.1: Khi CPU vượt ngưỡng cảnh báo (82% >= 80% & < 90%), trạng thái là WARNING và VẪN cho phép nhận task', () => {
      const currentSample: SystemResourceMetricsSample = {
        cpu: { usagePercent: 82.0, loadAverage1m: 3.2, cores: 4 },
        memory: {
          totalBytes: 16 * 1024 * 1024 * 1024,
          freeBytes: 8 * 1024 * 1024 * 1024,
          usedBytes: 8 * 1024 * 1024 * 1024,
          usedPercent: 50.0,
        },
        disk: {
          path: '.',
          totalBytes: 500 * 1024 * 1024 * 1024,
          freeBytes: 300 * 1024 * 1024 * 1024,
          usedBytes: 200 * 1024 * 1024 * 1024,
          usedPercent: 40.0,
        },
      };

      const monitor = new SystemResourceMonitor({
        db,
        clock: mockClock,
        metricsSampler: () => currentSample,
      });

      const snapshot = monitor.evaluate();
      expect(snapshot.status).toBe('WARNING');
      expect(snapshot.breaches).toHaveLength(1);
      expect(snapshot.breaches[0]?.level).toBe('WARNING');
      expect(snapshot.breaches[0]?.resource).toBe('cpu');

      // Tiêu chí: cảnh báo không dừng nhận task
      const check = monitor.canAcquire();
      expect(check.allowed).toBe(true);

      // Lưu vết sự kiện RESOURCE_WARNING trong DB
      const events = resourceRepo.findAll({ status: 'WARNING' });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]?.event_type).toBe('RESOURCE_WARNING');
    });

    it('2.2: Khi Memory hoặc Disk chạm ngưỡng cảnh báo (86% >= 85%), hệ thống ghi nhận warning nhưng tiếp tục nhận task', () => {
      const warningSample: SystemResourceMetricsSample = {
        cpu: { usagePercent: 30.0, loadAverage1m: 1.0, cores: 4 },
        memory: {
          totalBytes: 16 * 1024 * 1024 * 1024,
          freeBytes: 2.2 * 1024 * 1024 * 1024,
          usedBytes: 13.8 * 1024 * 1024 * 1024,
          usedPercent: 86.2,
        },
        disk: {
          path: '.',
          totalBytes: 500 * 1024 * 1024 * 1024,
          freeBytes: 70 * 1024 * 1024 * 1024,
          usedBytes: 430 * 1024 * 1024 * 1024,
          usedPercent: 86.0,
        },
      };

      const monitor = new SystemResourceMonitor({
        db,
        clock: mockClock,
        metricsSampler: () => warningSample,
      });

      const snapshot = monitor.evaluate();
      expect(snapshot.status).toBe('WARNING');
      expect(snapshot.breaches).toHaveLength(2); // memory & disk warning

      const check = monitor.canAcquire();
      expect(check.allowed).toBe(true);
    });
  });

  describe('3. Ngưỡng dừng (CRITICAL) — Tiêu chí cốt lõi: "Vượt ngưỡng → dừng nhận task"', () => {
    it('3.1: Vượt ngưỡng CPU (94% >= 90%) → DỪNG nhận task ngay lập tức', () => {
      const highCpuSample: SystemResourceMetricsSample = {
        cpu: { usagePercent: 94.0, loadAverage1m: 5.5, cores: 4 },
        memory: {
          totalBytes: 16 * 1024 * 1024 * 1024,
          freeBytes: 8 * 1024 * 1024 * 1024,
          usedBytes: 8 * 1024 * 1024 * 1024,
          usedPercent: 50.0,
        },
        disk: {
          path: '.',
          totalBytes: 500 * 1024 * 1024 * 1024,
          freeBytes: 300 * 1024 * 1024 * 1024,
          usedBytes: 200 * 1024 * 1024 * 1024,
          usedPercent: 40.0,
        },
      };

      const monitor = new SystemResourceMonitor({
        db,
        clock: mockClock,
        metricsSampler: () => highCpuSample,
      });

      const check = monitor.canAcquire();
      expect(check.allowed).toBe(false);
      expect(check.reason).toBe('SYSTEM_RESOURCE_EXCEEDED');
      expect(check.message).toContain('CPU usage (94%) exceeded critical threshold (90%)');

      // Lưu vết sự kiện RESOURCE_CRITICAL
      const criticalEvents = resourceRepo.findAll({ status: 'CRITICAL' });
      expect(criticalEvents.length).toBeGreaterThanOrEqual(1);
      expect(criticalEvents[0]?.event_type).toBe('RESOURCE_CRITICAL');
    });

    it('3.2: Vượt ngưỡng Memory (93.5% >= 92% hoặc dung lượng trống < 256MB) → DỪNG nhận task', () => {
      const highMemSample: SystemResourceMetricsSample = {
        cpu: { usagePercent: 40.0, loadAverage1m: 1.5, cores: 4 },
        memory: {
          totalBytes: 16 * 1024 * 1024 * 1024,
          freeBytes: 150 * 1024 * 1024, // 150MB < 256MB
          usedBytes: 15.85 * 1024 * 1024 * 1024,
          usedPercent: 99.1,
        },
        disk: {
          path: '.',
          totalBytes: 500 * 1024 * 1024 * 1024,
          freeBytes: 300 * 1024 * 1024 * 1024,
          usedBytes: 200 * 1024 * 1024 * 1024,
          usedPercent: 40.0,
        },
      };

      const monitor = new SystemResourceMonitor({
        db,
        clock: mockClock,
        metricsSampler: () => highMemSample,
      });

      const check = monitor.canAcquire();
      expect(check.allowed).toBe(false);
      expect(check.reason).toBe('SYSTEM_RESOURCE_EXCEEDED');
      expect(check.message).toContain('Memory');
    });

    it('3.3: Vượt ngưỡng Disk (92% >= 90% hoặc dung lượng trống < 1GB) → DỪNG nhận task', () => {
      const lowDiskSample: SystemResourceMetricsSample = {
        cpu: { usagePercent: 25.0, loadAverage1m: 0.8, cores: 4 },
        memory: {
          totalBytes: 16 * 1024 * 1024 * 1024,
          freeBytes: 8 * 1024 * 1024 * 1024,
          usedBytes: 8 * 1024 * 1024 * 1024,
          usedPercent: 50.0,
        },
        disk: {
          path: '.',
          totalBytes: 500 * 1024 * 1024 * 1024,
          freeBytes: 800 * 1024 * 1024, // 800MB < 1GB
          usedBytes: 499.2 * 1024 * 1024 * 1024,
          usedPercent: 99.8,
        },
      };

      const monitor = new SystemResourceMonitor({
        db,
        clock: mockClock,
        metricsSampler: () => lowDiskSample,
      });

      const check = monitor.canAcquire();
      expect(check.allowed).toBe(false);
      expect(check.reason).toBe('SYSTEM_RESOURCE_EXCEEDED');
      expect(check.message).toContain('Disk');
    });
  });

  describe('4. Phục hồi khi tài nguyên hạ nhiệt / an toàn', () => {
    it('4.1: Hệ thống tự động phục hồi cho phép nhận task trở lại khi CPU/RAM/Disk giảm xuống dưới ngưỡng', () => {
      let currentSample: SystemResourceMetricsSample = {
        cpu: { usagePercent: 95.0, loadAverage1m: 5.0, cores: 4 },
        memory: {
          totalBytes: 16 * 1024 * 1024 * 1024,
          freeBytes: 8 * 1024 * 1024 * 1024,
          usedBytes: 8 * 1024 * 1024 * 1024,
          usedPercent: 50.0,
        },
        disk: {
          path: '.',
          totalBytes: 500 * 1024 * 1024 * 1024,
          freeBytes: 300 * 1024 * 1024 * 1024,
          usedBytes: 200 * 1024 * 1024 * 1024,
          usedPercent: 40.0,
        },
      };

      const monitor = new SystemResourceMonitor({
        db,
        clock: mockClock,
        metricsSampler: () => currentSample,
      });

      // Lần 1: Quá tải CPU -> Chặn
      expect(monitor.canAcquire().allowed).toBe(false);

      // Hạ nhiệt CPU xuống 35%
      currentSample = {
        ...currentSample,
        cpu: { usagePercent: 35.0, loadAverage1m: 1.1, cores: 4 },
      };
      simulatedTime += 60_000;

      // Lần 2: Đã an toàn -> Cho phép nhận task trở lại
      const recoveredCheck = monitor.canAcquire();
      expect(recoveredCheck.allowed).toBe(true);

      // Kiểm tra event phục hồi
      const recoveredEvents = resourceRepo.findAll({ eventType: 'RESOURCE_RECOVERED' });
      expect(recoveredEvents.length).toBeGreaterThanOrEqual(1);
      expect(recoveredEvents[0]?.status).toBe('OK');
    });
  });

  describe('5. Tích hợp TaskScheduler và ResourceQuotaManager', () => {
    it('5.1: TaskScheduler từ chối cấp task và giữ nguyên trạng thái READY khi tài nguyên vượt ngưỡng dừng', async () => {
      createTestTask('TSK-RES-1', 'READY', 20);

      const highCpuSample: SystemResourceMetricsSample = {
        cpu: { usagePercent: 96.0, loadAverage1m: 6.0, cores: 4 },
        memory: {
          totalBytes: 16 * 1024 * 1024 * 1024,
          freeBytes: 8 * 1024 * 1024 * 1024,
          usedBytes: 8 * 1024 * 1024 * 1024,
          usedPercent: 50.0,
        },
        disk: {
          path: '.',
          totalBytes: 500 * 1024 * 1024 * 1024,
          freeBytes: 300 * 1024 * 1024 * 1024,
          usedBytes: 200 * 1024 * 1024 * 1024,
          usedPercent: 40.0,
        },
      };

      const monitor = new SystemResourceMonitor({
        db,
        clock: mockClock,
        metricsSampler: () => highCpuSample,
      });

      const quotaManager = new ResourceQuotaManager({
        db,
        clock: mockClock,
        systemResourceMonitor: monitor,
      });

      const executionManager = new ExecutionManager();
      const runService = new RunService({ db, executionManager });

      const scheduler = new TaskScheduler({
        db,
        runService,
        resourceQuotaManager: quotaManager,
        systemResourceMonitor: monitor,
      });

      // Cố gắng acquire task tiếp theo
      const acquireResult = scheduler.acquireNextTask();
      expect(acquireResult.acquired).toBe(false);
      expect(acquireResult.reason).toBe('SYSTEM_RESOURCE_EXCEEDED');

      // Task vẫn giữ nguyên READY, không bị chiếm lock
      const taskInDb = taskRepo.findById('TSK-RES-1');
      expect(taskInDb?.status).toBe('READY');

      // scheduler.step() an toàn bỏ qua
      const stepResult = await scheduler.step();
      expect(stepResult.executed).toBe(false);
      expect(stepResult.reason).toBe('SYSTEM_RESOURCE_EXCEEDED');
    });

    it('5.2: Khi tài nguyên bình thường, TaskScheduler tiếp nhận và chuyển task READY sang RUNNING bình thường', () => {
      createTestTask('TSK-RES-2', 'READY', 30);

      const safeSample: SystemResourceMetricsSample = {
        cpu: { usagePercent: 30.0, loadAverage1m: 1.0, cores: 4 },
        memory: {
          totalBytes: 16 * 1024 * 1024 * 1024,
          freeBytes: 10 * 1024 * 1024 * 1024,
          usedBytes: 6 * 1024 * 1024 * 1024,
          usedPercent: 37.5,
        },
        disk: {
          path: '.',
          totalBytes: 500 * 1024 * 1024 * 1024,
          freeBytes: 300 * 1024 * 1024 * 1024,
          usedBytes: 200 * 1024 * 1024 * 1024,
          usedPercent: 40.0,
        },
      };

      const monitor = new SystemResourceMonitor({
        db,
        clock: mockClock,
        metricsSampler: () => safeSample,
      });

      const quotaManager = new ResourceQuotaManager({
        db,
        clock: mockClock,
        systemResourceMonitor: monitor,
      });

      const executionManager = new ExecutionManager();
      const runService = new RunService({ db, executionManager });

      const scheduler = new TaskScheduler({
        db,
        runService,
        resourceQuotaManager: quotaManager,
        systemResourceMonitor: monitor,
      });

      const acquireResult = scheduler.acquireNextTask();
      expect(acquireResult.acquired).toBe(true);
      expect(acquireResult.task?.id).toBe('TSK-RES-2');
      expect(acquireResult.task?.status).toBe('RUNNING');
    });
  });

  describe('6. REST API Quản trị Giám sát Tài nguyên (/system/resources)', () => {
    it('6.1: GET /system/resources trả về trạng thái, ngưỡng và snapshot số liệu', async () => {
      const safeSample: SystemResourceMetricsSample = {
        cpu: { usagePercent: 25.0, loadAverage1m: 0.5, cores: 4 },
        memory: {
          totalBytes: 16 * 1024 * 1024 * 1024,
          freeBytes: 10 * 1024 * 1024 * 1024,
          usedBytes: 6 * 1024 * 1024 * 1024,
          usedPercent: 37.5,
        },
        disk: {
          path: '.',
          totalBytes: 500 * 1024 * 1024 * 1024,
          freeBytes: 300 * 1024 * 1024 * 1024,
          usedBytes: 200 * 1024 * 1024 * 1024,
          usedPercent: 40.0,
        },
      };

      const customMonitor = new SystemResourceMonitor({
        db,
        metricsSampler: () => safeSample,
      });
      const server = await buildServer({ db, systemResourceMonitor: customMonitor });

      const res = await server.inject({
        method: 'GET',
        url: '/system/resources',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.data.snapshot).toBeDefined();
      expect(json.data.snapshot.cpu).toBeDefined();
      expect(json.data.snapshot.memory).toBeDefined();
      expect(json.data.snapshot.disk).toBeDefined();
      expect(json.data.thresholds).toBeDefined();
      expect(typeof json.data.canAcquire).toBe('boolean');
      expect(json.data.canAcquire).toBe(true);

      await server.close();
    });

    it('6.2: PATCH /system/resources/thresholds cập nhật ngưỡng giám sát tức thời', async () => {
      const server = await buildServer({ db });

      const res = await server.inject({
        method: 'PATCH',
        url: '/system/resources/thresholds',
        payload: {
          cpu_warning_percent: 75,
          cpu_critical_percent: 88,
          disk_critical_percent: 92,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.data.success).toBe(true);
      expect(json.data.thresholds.cpu_warning_percent).toBe(75);
      expect(json.data.thresholds.cpu_critical_percent).toBe(88);
      expect(json.data.thresholds.disk_critical_percent).toBe(92);

      await server.close();
    });

    it('6.3: POST /system/resources/sample & GET /system/resources/events lưu vết và truy vấn lịch sử kiểm toán', async () => {
      const server = await buildServer({ db });

      const sampleRes = await server.inject({
        method: 'POST',
        url: '/system/resources/sample',
      });

      expect(sampleRes.statusCode).toBe(200);
      const sampleJson = JSON.parse(sampleRes.payload);
      expect(sampleJson.data.success).toBe(true);
      expect(sampleJson.data.record.event_type).toBe('SAMPLE');

      const eventsRes = await server.inject({
        method: 'GET',
        url: '/system/resources/events',
      });

      expect(eventsRes.statusCode).toBe(200);
      const eventsJson = JSON.parse(eventsRes.payload);
      expect(eventsJson.data.events.length).toBeGreaterThanOrEqual(1);

      await server.close();
    });
  });
});
