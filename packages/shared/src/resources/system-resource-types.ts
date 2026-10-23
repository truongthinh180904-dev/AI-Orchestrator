import { z } from 'zod';

export type ResourceHealthStatus = 'OK' | 'WARNING' | 'CRITICAL';

export interface CpuMetrics {
  usagePercent: number; // 0 - 100
  loadAverage1m: number;
  cores: number;
}

export interface MemoryMetrics {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number; // 0 - 100
}

export interface DiskMetrics {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number; // 0 - 100
}

export interface ResourceThresholdBreach {
  resource: 'cpu' | 'memory' | 'disk';
  level: 'WARNING' | 'CRITICAL';
  metric: string;
  current: number;
  threshold: number;
  unit: string;
  message: string;
}

export interface SystemResourceSnapshot {
  timestamp: string;
  status: ResourceHealthStatus;
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  disk: DiskMetrics;
  breaches: ResourceThresholdBreach[];
}

export const SystemResourceThresholdsSchema = z.object({
  cpu_warning_percent: z.number().min(1).max(100).default(80),
  cpu_critical_percent: z.number().min(1).max(100).default(90),

  memory_warning_percent: z.number().min(1).max(100).default(85),
  memory_critical_percent: z.number().min(1).max(100).default(92),
  min_free_memory_bytes: z.number().int().min(0).default(256 * 1024 * 1024), // 256MB

  disk_warning_percent: z.number().min(1).max(100).default(85),
  disk_critical_percent: z.number().min(1).max(100).default(90),
  min_free_disk_bytes: z.number().int().min(0).default(1024 * 1024 * 1024), // 1GB

  disk_path: z.string().default('.'),
  enabled: z.boolean().default(true),
});

export type SystemResourceThresholds = z.infer<typeof SystemResourceThresholdsSchema>;
export type SystemResourceThresholdsInput = z.input<typeof SystemResourceThresholdsSchema>;

export type SystemResourceEventType =
  | 'SAMPLE'
  | 'RESOURCE_WARNING'
  | 'RESOURCE_CRITICAL'
  | 'RESOURCE_RECOVERED'
  | 'CONFIG_UPDATED';

export interface SystemResourceEventRecord {
  id: string;
  event_type: SystemResourceEventType;
  status: ResourceHealthStatus;
  cpu_percent: number;
  memory_percent: number;
  memory_free_bytes: number;
  memory_total_bytes: number;
  disk_percent: number;
  disk_free_bytes: number;
  disk_total_bytes: number;
  breaches: ResourceThresholdBreach[];
  details: Record<string, unknown>;
  created_at: string;
}

export interface CreateSystemResourceEventInput {
  id?: string;
  event_type: SystemResourceEventType;
  status: ResourceHealthStatus;
  cpu_percent: number;
  memory_percent: number;
  memory_free_bytes: number;
  memory_total_bytes: number;
  disk_percent: number;
  disk_free_bytes: number;
  disk_total_bytes: number;
  breaches?: ResourceThresholdBreach[];
  details?: Record<string, unknown>;
  created_at?: string;
}

export interface SystemResourceMetricsSample {
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  disk: DiskMetrics;
}
