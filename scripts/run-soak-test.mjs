#!/usr/bin/env node
/**
 * Soak Test Runner CLI for AI Orchestrator
 * Simulates sustained overnight execution, fault injection, and zero data loss verification.
 * Usage:
 *   node scripts/run-soak-test.mjs [--mode virtual|realtime] [--duration <ms>] [--iterations <n>]
 */
import process from 'node:process';
import console from 'node:console';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, runMigrations } from '../packages/db/dist/index.js';
import { logger } from '../packages/shared/dist/index.js';
import { TaskScheduler } from '../apps/orchestrator/dist/services/task-scheduler.js';
import { RunService } from '../apps/orchestrator/dist/services/run-service.js';
import { ExecutionManager } from '../apps/orchestrator/dist/adapters/execution-manager.js';
import { RecoveryService } from '../apps/orchestrator/dist/services/recovery-service.js';
import { ProcessMonitorService } from '../apps/orchestrator/dist/services/process-monitor-service.js';
import { ResourceQuotaManager } from '../apps/orchestrator/dist/services/resource-quota-manager.js';
import { SystemResourceMonitor } from '../apps/orchestrator/dist/services/system-resource-monitor.js';
import { SoakTestRunner } from '../apps/orchestrator/dist/services/soak-test-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mockCliPath = path.resolve(__dirname, '../fixtures/mock-agy-cli.cjs');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    mode: 'virtual',
    durationMs: 3600000, // 1 hour default virtual
    iterations: 20,
    taskCount: 10,
    dbPath: ':memory:',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--mode' && args[i + 1]) {
      options.mode = args[i + 1] === 'realtime' ? 'realtime' : 'virtual';
      i++;
    } else if (arg === '--duration' && args[i + 1]) {
      options.durationMs = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--iterations' && args[i + 1]) {
      options.iterations = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--tasks' && args[i + 1]) {
      options.taskCount = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === '--db' && args[i + 1]) {
      options.dbPath = args[i + 1];
      i++;
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();
  console.log('='.repeat(70));
  console.log(`AI Orchestrator — Overnight Soak Test Runner`);
  console.log(`Mode: ${options.mode} | Target Duration: ${options.durationMs}ms | Iterations: ${options.iterations}`);
  console.log('='.repeat(70));

  const db = createDatabase(options.dbPath);
  runMigrations(db);

  const executionManager = new ExecutionManager();
  const runService = new RunService({
    db,
    executionManager,
    config: {
      AGY_BIN: 'node',
      AGY_ARGS: mockCliPath,
    },
  });
  const systemMonitor = new SystemResourceMonitor({
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
  const quotaManager = new ResourceQuotaManager({ db, systemResourceMonitor: systemMonitor });
  const recoveryService = new RecoveryService({ db, resourceQuotaManager: quotaManager });
  const processMonitor = new ProcessMonitorService({
    db,
    runService,
    recoveryService,
    resourceQuotaManager: quotaManager,
    executionManager,
  });

  const scheduler = new TaskScheduler({
    db,
    runService,
    recoveryService,
    resourceQuotaManager: quotaManager,
    systemResourceMonitor: systemMonitor,
  });

  const runner = new SoakTestRunner({
    db,
    taskScheduler: scheduler,
    recoveryService,
    processMonitor,
    quotaManager,
    systemMonitor,
  });

  try {
    const result = await runner.run({
      mode: options.mode,
      target_duration_ms: options.durationMs,
      max_iterations: options.iterations,
      task_count: options.taskCount,
    });

    console.log('\n--- KẾT QUẢ SOAK TEST ---');
    console.log(`Status:              ${result.status}`);
    console.log(`Duration Achieved:   ${result.duration_achieved} (${result.duration_ms}ms / ${result.target_duration_ms}ms)`);
    console.log(`Zero Data Loss:      ${result.zero_data_loss}`);
    console.log(`DB Integrity Check:  ${result.data_integrity.db_integrity_ok ? 'PASS' : 'FAIL'}`);
    console.log(`Iterations:          ${result.iterations_completed}`);
    console.log(`Tasks Completed:     ${result.data_integrity.completed_tasks}`);
    console.log(`Tasks Failed:        ${result.data_integrity.failed_tasks}`);
    console.log(`Tasks Retrying:      ${result.data_integrity.retrying_tasks}`);
    console.log(`Tasks Ready:         ${result.data_integrity.ready_tasks}`);
    console.log(`Orphaned Tasks:      ${result.data_integrity.orphaned_running_tasks}`);
    console.log(`Dangling Locks:      ${result.data_integrity.dangling_locks}`);
    console.log(`Faults Injected:     ${result.faults_injected_count}`);
    console.log(`Faults Recovered:    ${result.faults_recovered_count}`);
    console.log(`Memory Heap Growth:  ${(result.memory_report.heap_growth_bytes / 1024).toFixed(1)} KB`);
    console.log(`Memory Leak Risk:    ${result.memory_report.leak_suspected ? 'YES' : 'NO'}`);
    console.log('='.repeat(70));
    console.log(`Summary: ${result.summary}\n`);

    if (result.status === 'SUCCESS' || result.status === 'PARTIAL') {
      process.exit(0);
    } else {
      process.exit(1);
    }
  } catch (err) {
    logger.error('Soak test execution failed with unhandled error', { error: err });
    process.exit(1);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
