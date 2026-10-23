import { z } from 'zod';

export const SoakFaultTypeSchema = z.enum([
  'RATE_LIMIT',
  'PROCESS_CRASH',
  'UNRESPONSIVE_PROCESS',
  'RESOURCE_SPIKE',
  'SERVICE_RESTART',
]);
export type SoakFaultType = z.infer<typeof SoakFaultTypeSchema>;

export const SoakFaultConfigSchema = z.object({
  rate_limit: z
    .object({
      enabled: z.boolean().default(true),
      probability: z.number().min(0).max(1).default(0.2),
      backoffMs: z.number().default(50),
      maxHits: z.number().default(3),
    })
    .default({
      enabled: true,
      probability: 0.2,
      backoffMs: 50,
      maxHits: 3,
    }),
  process_crash: z
    .object({
      enabled: z.boolean().default(true),
      probability: z.number().min(0).max(1).default(0.15),
      exitCode: z.number().default(1),
    })
    .default({
      enabled: true,
      probability: 0.15,
      exitCode: 1,
    }),
  unresponsive_process: z
    .object({
      enabled: z.boolean().default(true),
      probability: z.number().min(0).max(1).default(0.1),
      staleDurationMs: z.number().default(5000),
    })
    .default({
      enabled: true,
      probability: 0.1,
      staleDurationMs: 5000,
    }),
  resource_spike: z
    .object({
      enabled: z.boolean().default(true),
      probability: z.number().min(0).max(1).default(0.15),
      metric: z.enum(['cpu', 'memory', 'disk']).default('cpu'),
      durationMs: z.number().default(100),
    })
    .default({
      enabled: true,
      probability: 0.15,
      metric: 'cpu',
      durationMs: 100,
    }),
  service_restart: z
    .object({
      enabled: z.boolean().default(true),
      probability: z.number().min(0).max(1).default(0.1),
    })
    .default({
      enabled: true,
      probability: 0.1,
    }),
});
export type SoakFaultConfig = z.infer<typeof SoakFaultConfigSchema>;

export const SoakTestConfigSchema = z.object({
  id: z.string().optional(),
  name: z.string().default('Overnight Soak Test'),
  mode: z.enum(['virtual', 'realtime']).default('virtual'),
  target_duration_ms: z.number().min(1).default(3600000), // Default 1 hour
  virtual_step_ms: z.number().min(1).default(60000), // 1 min per virtual step
  realtime_interval_ms: z.number().min(1).default(10),
  task_count: z.number().min(0).default(20),
  max_iterations: z.number().min(1).default(50),
  fault_config: SoakFaultConfigSchema.default({
    rate_limit: { enabled: true, probability: 0.2, backoffMs: 50, maxHits: 3 },
    process_crash: { enabled: true, probability: 0.15, exitCode: 1 },
    unresponsive_process: { enabled: true, probability: 0.1, staleDurationMs: 5000 },
    resource_spike: { enabled: true, probability: 0.15, metric: 'cpu', durationMs: 100 },
    service_restart: { enabled: true, probability: 0.1 },
  }),
  check_integrity_every_n_steps: z.number().min(1).default(5),
  memory_check: z.boolean().default(true),
  auto_cleanup_on_finish: z.boolean().default(true),
});
export type SoakTestConfig = z.infer<typeof SoakTestConfigSchema>;

export const SoakFaultEventSchema = z.object({
  step: z.number(),
  fault_type: SoakFaultTypeSchema,
  timestamp: z.string(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  description: z.string(),
  recovered: z.boolean(),
  recovery_details: z.record(z.string(), z.unknown()).optional(),
});
export type SoakFaultEvent = z.infer<typeof SoakFaultEventSchema>;

export const SoakTestDataIntegrityReportSchema = z.object({
  db_integrity_ok: z.boolean(),
  integrity_check_output: z.string(),
  total_tasks: z.number(),
  completed_tasks: z.number(),
  failed_tasks: z.number(),
  retrying_tasks: z.number(),
  ready_tasks: z.number(),
  running_tasks: z.number(),
  orphaned_running_tasks: z.number(),
  dangling_locks: z.number(),
  total_runs: z.number(),
  active_runs: z.number(),
  interrupted_runs: z.number(),
  total_checkpoints: z.number(),
  total_events: z.number(),
  total_recovery_audits: z.number(),
  zero_data_loss: z.boolean(),
  anomalies: z.array(z.string()),
});
export type SoakTestDataIntegrityReport = z.infer<typeof SoakTestDataIntegrityReportSchema>;

export const SoakTestMemoryReportSchema = z.object({
  start_heap_used_bytes: z.number(),
  end_heap_used_bytes: z.number(),
  peak_heap_used_bytes: z.number(),
  heap_growth_bytes: z.number(),
  heap_growth_ratio: z.number(),
  leak_suspected: z.boolean(),
});
export type SoakTestMemoryReport = z.infer<typeof SoakTestMemoryReportSchema>;

export const SoakTestResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  duration_ms: z.number(),
  target_duration_ms: z.number(),
  duration_achieved: z.boolean(),
  zero_data_loss: z.boolean(),
  iterations_completed: z.number(),
  mode: z.enum(['virtual', 'realtime']),
  data_integrity: SoakTestDataIntegrityReportSchema,
  memory_report: SoakTestMemoryReportSchema,
  faults_injected_count: z.number(),
  faults_recovered_count: z.number(),
  faults_events: z.array(SoakFaultEventSchema),
  tasks_processed: z.number(),
  status: z.enum(['SUCCESS', 'FAILED', 'PARTIAL']),
  summary: z.string(),
});
export type SoakTestResult = z.infer<typeof SoakTestResultSchema>;
