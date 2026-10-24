import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  AgentLockRepository,
  RecoveryAuditRepository,
  SoakTestRepository,
} from '../packages/db/src/index.js';
import { buildServer } from '../apps/orchestrator/src/server.js';
import { TaskScheduler } from '../apps/orchestrator/src/services/task-scheduler.js';
import { RunService } from '../apps/orchestrator/src/services/run-service.js';
import { RecoveryService } from '../apps/orchestrator/src/services/recovery-service.js';
import { ProcessMonitorService } from '../apps/orchestrator/src/services/process-monitor-service.js';
import { ResourceQuotaManager } from '../apps/orchestrator/src/services/resource-quota-manager.js';
import { SystemResourceMonitor } from '../apps/orchestrator/src/services/system-resource-monitor.js';
import { SoakTestRunner } from '../apps/orchestrator/src/services/soak-test-runner.js';
import { ExecutionManager } from '../apps/orchestrator/src/adapters/execution-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mockCliPath = path.resolve(__dirname, '../fixtures/mock-agy-cli.cjs');

describe('OPS-007: Soak test + mô phỏng lỗi xuyên đêm (Đạt thời lượng, không mất dữ liệu)', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let lockRepo: AgentLockRepository;
  let auditRepo: RecoveryAuditRepository;
  let soakTestRepo: SoakTestRepository;

  let executionManager: ExecutionManager;
  let runService: RunService;
  let systemMonitor: SystemResourceMonitor;
  let quotaManager: ResourceQuotaManager;
  let recoveryService: RecoveryService;
  let processMonitor: ProcessMonitorService;
  let scheduler: TaskScheduler;
  let soakRunner: SoakTestRunner;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);

    taskRepo = new TaskRepository(db);
    lockRepo = new AgentLockRepository(db);
    auditRepo = new RecoveryAuditRepository(db);
    soakTestRepo = new SoakTestRepository(db);

    db.prepare(
      "INSERT INTO features (id, name, created_at, updated_at) VALUES ('FEAT-SOAK', 'Overnight Soak Test Feature', datetime('now'), datetime('now'))",
    ).run();

    executionManager = new ExecutionManager();
    runService = new RunService({
      db,
      executionManager,
      config: {
        AGY_BIN: 'node',
        AGY_ARGS: mockCliPath,
      },
    });
    systemMonitor = new SystemResourceMonitor({
      db,
      thresholds: {
        memory_warning_percent: 95,
        memory_critical_percent: 98,
        cpu_warning_percent: 95,
        cpu_critical_percent: 98,
        disk_warning_percent: 95,
        disk_critical_percent: 98,
      },
    });
    quotaManager = new ResourceQuotaManager({ db, systemResourceMonitor: systemMonitor });
    recoveryService = new RecoveryService({ db, resourceQuotaManager: quotaManager });
    processMonitor = new ProcessMonitorService({
      db,
      resourceQuotaManager: quotaManager,
      executionManager,
    });

    scheduler = new TaskScheduler({
      db,
      runService,
      recoveryService,
      resourceQuotaManager: quotaManager,
      systemResourceMonitor: systemMonitor,
    });

    soakRunner = new SoakTestRunner({
      db,
      taskScheduler: scheduler,
      recoveryService,
      processMonitor,
      quotaManager,
      systemMonitor,
    });
  });

  afterEach(() => {
    db.close();
  });

  describe('1. Tiêu chí: Đạt thời lượng (Duration & Iteration Target Achieved)', () => {
    it('1.1: Chạy mô phỏng xuyên đêm nhiều giờ ở chế độ virtual đạt thời lượng yêu cầu', async () => {
      // 8 virtual hours = 28,800,000ms
      const targetDurationMs = 28800000;
      const virtualStepMs = 600000; // 10 minutes per step => 48 steps to reach 8h
      const result = await soakRunner.run({
        mode: 'virtual',
        target_duration_ms: targetDurationMs,
        virtual_step_ms: virtualStepMs,
        max_iterations: 50,
        task_count: 10,
        fault_config: {
          rate_limit: { enabled: true, probability: 0.2, backoffMs: 20, maxHits: 3 },
          process_crash: { enabled: true, probability: 0.15, exitCode: 1 },
          unresponsive_process: { enabled: true, probability: 0.1, staleDurationMs: 1000 },
          resource_spike: { enabled: true, probability: 0.15, metric: 'cpu', durationMs: 50 },
          service_restart: { enabled: true, probability: 0.1 },
        },
      });

      expect(result.duration_achieved).toBe(true);
      expect(result.duration_ms).toBeGreaterThanOrEqual(targetDurationMs);
      expect(result.iterations_completed).toBeGreaterThanOrEqual(48);
      expect(result.status).toMatch(/SUCCESS|PARTIAL/);
      expect(result.summary).toContain('Duration achieved: true');
    });

    it('1.2: Chạy kiểm định ở chế độ realtime đạt thời lượng định sẵn', async () => {
      const targetDurationMs = 150; // 150ms realtime
      const result = await soakRunner.run({
        mode: 'realtime',
        target_duration_ms: targetDurationMs,
        realtime_interval_ms: 20,
        max_iterations: 15,
        task_count: 5,
        fault_config: {
          rate_limit: { enabled: true, probability: 0.3, backoffMs: 10, maxHits: 2 },
          process_crash: { enabled: false, probability: 0, exitCode: 1 },
          unresponsive_process: { enabled: false, probability: 0, staleDurationMs: 1000 },
          resource_spike: { enabled: false, probability: 0, metric: 'cpu', durationMs: 10 },
          service_restart: { enabled: false, probability: 0 },
        },
      });

      expect(result.duration_achieved).toBe(true);
      expect(result.duration_ms).toBeGreaterThanOrEqual(targetDurationMs);
      expect(result.data_integrity.zero_data_loss).toBe(true);
    });

    it('1.3: Theo dõi bộ nhớ heap qua các lượt lặp, không rò rỉ bộ nhớ (leak_suspected = false)', async () => {
      const result = await soakRunner.run({
        mode: 'virtual',
        target_duration_ms: 3600000,
        virtual_step_ms: 120000, // 30 steps
        max_iterations: 30,
        task_count: 8,
      });

      expect(result.memory_report.leak_suspected).toBe(false);
      expect(result.memory_report.start_heap_used_bytes).toBeGreaterThan(0);
      expect(result.memory_report.end_heap_used_bytes).toBeGreaterThan(0);
      expect(result.memory_report.heap_growth_ratio).toBeLessThan(5.0);
    });
  });

  describe('2. Tiêu chí: Không mất dữ liệu (Zero Data Loss & Consistency)', () => {
    it('2.1: PRAGMA integrity_check luôn trả về ok sau khi kết thúc soak test', async () => {
      const result = await soakRunner.run({
        mode: 'virtual',
        target_duration_ms: 7200000,
        virtual_step_ms: 360000,
        max_iterations: 20,
        task_count: 8,
      });

      expect(result.data_integrity.db_integrity_ok).toBe(true);
      expect(result.data_integrity.integrity_check_output).toBe('ok');
      expect(result.data_integrity.zero_data_loss).toBe(true);
    });

    it('2.2: Không còn task RUNNING mồ côi (orphaned_running_tasks = 0) và không có dangling locks', async () => {
      const result = await soakRunner.run({
        mode: 'virtual',
        target_duration_ms: 3600000,
        virtual_step_ms: 180000,
        max_iterations: 20,
        task_count: 6,
      });

      expect(result.data_integrity.orphaned_running_tasks).toBe(0);
      expect(result.data_integrity.dangling_locks).toBe(0);
      expect(result.data_integrity.anomalies).toHaveLength(0);
    });

    it('2.3: checkDataIntegrity phát hiện đúng bất thường khi có task RUNNING mồ côi hoặc lock treo', () => {
      // Create orphaned running task
      taskRepo.create({
        id: 'TASK-ORPHAN',
        feature_id: 'FEAT-SOAK',
        title: 'Orphan Task',
        worker_type: 'coding',
        priority: 1,
        status: 'RUNNING',
        attempts: 1,
        max_attempts: 3,
      });

      // Create dangling lock
      lockRepo.acquire({
        id: 'default_agent',
        task_id: 'TASK-ORPHAN',
        owner_pid: 99999999, // Dead PID
      });

      const report = soakRunner.checkDataIntegrity();
      expect(report.zero_data_loss).toBe(false);
      expect(report.orphaned_running_tasks).toBe(1);
      expect(report.dangling_locks).toBe(1);
      expect(report.anomalies.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('3. Mô phỏng lỗi xuyên đêm (Overnight Fault Injection & Recovery)', () => {
    it('3.1: Mô phỏng Rate limit (429 / RESOURCE_EXHAUSTED) kích hoạt backoff và hồi phục', async () => {
      const event = await soakRunner.simulateRateLimit(1, 'TASK-RL-1');

      expect(event.fault_type).toBe('RATE_LIMIT');
      expect(event.recovered).toBe(true);
      expect(event.recovery_details?.['consecutiveQuotaHits']).toBe(1);
      expect(event.recovery_details?.['isThrottled']).toBe(true);

      // Quota manager reflects hit
      const quotaStatus = quotaManager.getStatus();
      expect(quotaStatus.consecutiveQuotaHits).toBe(1);
      expect(quotaStatus.isThrottled).toBe(true);
    });

    it('3.2: Mô phỏng Process crash (PID chết đột ngột / SIGKILL) được phát hiện và thu dọn sạch', async () => {
      const event = await soakRunner.simulateProcessCrash(5, 'TASK-CRASH-5');

      expect(event.fault_type).toBe('PROCESS_CRASH');
      expect(event.recovered).toBe(true);
      expect(event.recovery_details?.['runStatus']).toBe('ERROR');
      expect(event.recovery_details?.['taskStatus']).toBe('READY');

      // Verify no dangling locks
      expect(lockRepo.findAll()).toHaveLength(0);

      // Task can be safely acquired again
      const task = taskRepo.findById('TASK-CRASH-5');
      expect(task?.status).toBe('READY');
    });

    it('3.3: Mô phỏng Unresponsive process với heartbeat quá hạn', async () => {
      const event = await soakRunner.simulateUnresponsiveProcess(7, 'RUN-STALL-7');

      expect(event.fault_type).toBe('UNRESPONSIVE_PROCESS');
      expect(event.recovered).toBe(true);
      expect(event.recovery_details?.['inspectionState']).toBe('UNRESPONSIVE');
    });

    it('3.4: Mô phỏng Quá tải tài nguyên (CPU spike) kích hoạt dừng nhận task và tự động tiếp tục khi hạ nhiệt', async () => {
      // Seed a ready task
      taskRepo.create({
        id: 'TASK-SPIKE-READY',
        feature_id: 'FEAT-SOAK',
        title: 'Task for resource spike',
        worker_type: 'coding',
        priority: 5,
        status: 'READY',
        attempts: 0,
        max_attempts: 3,
      });

      const event = await soakRunner.simulateResourceSpike(9, 'cpu');

      expect(event.fault_type).toBe('RESOURCE_SPIKE');
      expect(event.recovered).toBe(true);
      expect(event.recovery_details?.['criticalDetected']).toBe(true);
      expect(event.recovery_details?.['acquisitionHalted']).toBe(true);
      expect(event.recovery_details?.['recoveredToOk']).toBe(true);

      // Scheduler can now acquire tasks normally
      const acquisition = scheduler.acquireNextTask();
      expect(acquisition.acquired).toBe(true);
      expect(acquisition.task?.id).toBe('TASK-SPIKE-READY');
    });

    it('3.5: Mô phỏng Service restart đột ngột: khôi phục sạch sẽ, không mất dữ liệu', async () => {
      const event = await soakRunner.simulateServiceRestart(12);

      expect(event.fault_type).toBe('SERVICE_RESTART');
      expect(event.recovered).toBe(true);
      expect(event.recovery_details?.['runStatus']).toBe('ERROR');
      expect(event.recovery_details?.['taskStatus']).toBe('READY');
      expect(event.recovery_details?.['locksHeld']).toBe(0);

      // Audit repository has recorded the event
      expect(auditRepo.count()).toBeGreaterThan(0);
    });
  });

  describe('4. REST API Endpoints & Persistence', () => {
    let server: Awaited<ReturnType<typeof buildServer>>;

    beforeEach(async () => {
      server = await buildServer({
        db,
        taskScheduler: scheduler,
        recoveryService,
        processMonitorService: processMonitor,
        resourceQuotaManager: quotaManager,
        systemResourceMonitor: systemMonitor,
        runService,
        soakTestRunner: soakRunner,
      });
    });

    afterEach(async () => {
      await server.close();
    });

    it('4.1: POST /system/soak-test/run thực thi soak test và lưu kết quả vào database', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/system/soak-test/run',
        payload: {
          mode: 'virtual',
          target_duration_ms: 1800000,
          virtual_step_ms: 360000, // 5 steps
          max_iterations: 5,
          task_count: 4,
          fault_config: {
            rate_limit: { enabled: true, probability: 0.5 },
            process_crash: { enabled: false },
            resource_spike: { enabled: false },
            unresponsive_process: { enabled: false },
            service_restart: { enabled: false },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data).toBeDefined();
      expect(body.data.duration_achieved).toBe(true);
      expect(body.data.data_integrity.zero_data_loss).toBe(true);

      // Verify saved in SQLite soak_test_runs table
      const saved = soakTestRepo.getLatest();
      expect(saved).not.toBeNull();
      expect(saved?.id).toBe(body.data.id);
      expect(saved?.zero_data_loss).toBe(true);
    });

    it('4.2: GET /system/soak-test/status trả về kết quả soak test gần nhất và tính toàn vẹn', async () => {
      // First save a dummy result
      soakTestRepo.create({
        id: 'soak-status-test-1',
        name: 'Overnight Soak Test',
        mode: 'virtual',
        target_duration_ms: 3600000,
        duration_ms: 3600000,
        iterations_completed: 10,
        tasks_processed: 5,
        faults_injected_count: 2,
        faults_recovered_count: 2,
        duration_achieved: true,
        zero_data_loss: true,
        status: 'SUCCESS',
        data_integrity: {
          db_integrity_ok: true,
          integrity_check_output: 'ok',
          total_tasks: 5,
          completed_tasks: 5,
          failed_tasks: 0,
          retrying_tasks: 0,
          ready_tasks: 0,
          running_tasks: 0,
          orphaned_running_tasks: 0,
          dangling_locks: 0,
          total_runs: 5,
          active_runs: 0,
          interrupted_runs: 0,
          total_checkpoints: 10,
          total_events: 10,
          total_recovery_audits: 0,
          zero_data_loss: true,
          anomalies: [],
        },
        memory_report: {
          start_heap_used_bytes: 1000000,
          end_heap_used_bytes: 1200000,
          peak_heap_used_bytes: 1500000,
          heap_growth_bytes: 200000,
          heap_growth_ratio: 0.2,
          leak_suspected: false,
        },
        faults_events: [],
        summary: 'Test summary',
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
      });

      const response = await server.inject({
        method: 'GET',
        url: '/system/soak-test/status',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.latest).toBeDefined();
      expect(body.data.latest.id).toBe('soak-status-test-1');
      expect(body.data.integrity.db_integrity_ok).toBe(true);
    });

    it('4.3: POST /system/soak-test/simulate-fault mô phỏng lỗi riêng lẻ qua REST API', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/system/soak-test/simulate-fault',
        payload: {
          fault_type: 'RATE_LIMIT',
          step: 10,
          taskId: 'TASK-API-RL',
          runId: 'RUN-API-RL',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.fault_type).toBe('RATE_LIMIT');
      expect(body.data.recovered).toBe(true);
    });

    it('4.4: GET /system/soak-test/integrity trả về báo cáo tính toàn vẹn', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/system/soak-test/integrity',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.db_integrity_ok).toBe(true);
      expect(body.data.zero_data_loss).toBe(true);
    });
  });
});
