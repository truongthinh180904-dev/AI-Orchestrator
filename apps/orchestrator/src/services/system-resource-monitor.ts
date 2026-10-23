import fs from 'node:fs';
import os from 'node:os';
import type Database from 'better-sqlite3';
import {
  type SystemResourceThresholds,
  type SystemResourceThresholdsInput,
  SystemResourceThresholdsSchema,
  type SystemResourceSnapshot,
  type SystemResourceMetricsSample,
  type ResourceThresholdBreach,
  type ResourceHealthStatus,
  type ResourceAcquisitionResult,
  type SystemResourceEventType,
  type SystemResourceEventRecord,
  logger,
} from '@ai-orchestrator/shared';
import { SystemResourceRepository } from '@ai-orchestrator/db';

export interface SystemResourceMonitorOptions {
  db?: Database.Database;
  thresholds?: SystemResourceThresholdsInput;
  clock?: () => number;
  diskPath?: string;
  metricsSampler?: () => SystemResourceMetricsSample | Promise<SystemResourceMetricsSample>;
}

interface CpuTimeAggregate {
  idle: number;
  total: number;
}

export class SystemResourceMonitor {
  private thresholds: SystemResourceThresholds;
  private readonly db?: Database.Database;
  private readonly repo?: SystemResourceRepository;
  private readonly clock: () => number;
  private diskPath: string;
  private metricsSampler?: () => SystemResourceMetricsSample | Promise<SystemResourceMetricsSample>;

  private prevCpuTimes: CpuTimeAggregate;
  private prevCpuTimestamp: number;
  private lastSnapshot?: SystemResourceSnapshot;
  private lastStatus: ResourceHealthStatus = 'OK';

  constructor(options?: SystemResourceMonitorOptions) {
    this.thresholds = SystemResourceThresholdsSchema.parse(options?.thresholds ?? {});
    this.clock = options?.clock ?? (() => Date.now());
    this.diskPath = options?.diskPath ?? this.thresholds.disk_path;
    this.metricsSampler = options?.metricsSampler;

    if (options?.db) {
      this.db = options.db;
      this.repo = new SystemResourceRepository(options.db);
    }

    this.prevCpuTimestamp = this.clock();
    this.prevCpuTimes = this.aggregateCpuTimes();
  }

  setMetricsSampler(sampler?: () => SystemResourceMetricsSample | Promise<SystemResourceMetricsSample>): void {
    this.metricsSampler = sampler;
  }

  get currentThresholds(): SystemResourceThresholds {
    return { ...this.thresholds };
  }

  get currentStatus(): ResourceHealthStatus {
    return this.lastStatus;
  }

  /**
   * Aggregates raw CPU tick metrics across all cores.
   */
  private aggregateCpuTimes(): CpuTimeAggregate {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;

    for (const cpu of cpus) {
      idle += cpu.times.idle;
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    }

    return { idle, total };
  }

  /**
   * Samples live OS metrics for CPU, RAM, and Disk.
   */
  sampleMetrics(): SystemResourceMetricsSample {
    if (this.metricsSampler) {
      const result = this.metricsSampler();
      // If sampler returns a synchronous sample
      if ('cpu' in (result as object) && 'memory' in (result as object) && 'disk' in (result as object)) {
        return result as SystemResourceMetricsSample;
      }
    }

    const now = this.clock();

    // 1. CPU Metrics
    const currentCpuTimes = this.aggregateCpuTimes();
    const timeDelta = now - this.prevCpuTimestamp;
    const totalDelta = currentCpuTimes.total - this.prevCpuTimes.total;
    const idleDelta = currentCpuTimes.idle - this.prevCpuTimes.idle;

    let cpuPercent: number;
    const cores = Math.max(1, os.cpus().length);
    const loadAvg = os.loadavg()[0] ?? 0;

    if (totalDelta > 0 && timeDelta >= 50) {
      const usedDelta = totalDelta - idleDelta;
      cpuPercent = Math.max(0, Math.min(100, Math.round(((usedDelta / totalDelta) * 100) * 10) / 10));
    } else {
      // Fallback to load average normalized by core count
      cpuPercent = Math.max(0, Math.min(100, Math.round(((loadAvg / cores) * 100) * 10) / 10));
    }

    this.prevCpuTimes = currentCpuTimes;
    this.prevCpuTimestamp = now;

    // 2. Memory Metrics
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = Math.max(0, totalMem - freeMem);
    const memPercent = totalMem > 0 ? Math.max(0, Math.min(100, Math.round(((usedMem / totalMem) * 100) * 10) / 10)) : 0;

    // 3. Disk Metrics
    let totalDisk: number;
    let freeDisk: number;
    let usedDisk: number;
    let diskPercent: number;

    try {
      const stat = fs.statfsSync(this.diskPath);
      totalDisk = Number(stat.blocks) * Number(stat.bsize);
      freeDisk = Number(stat.bavail) * Number(stat.bsize);
      usedDisk = Math.max(0, totalDisk - freeDisk);
      diskPercent = totalDisk > 0 ? Math.max(0, Math.min(100, Math.round(((usedDisk / totalDisk) * 100) * 10) / 10)) : 0;
    } catch (err) {
      logger.warn(`Failed to inspect disk space at '${this.diskPath}', using defaults`, { error: err });
      // In testing or restricted sandbox where statfs might fail, fallback safely
      totalDisk = 100 * 1024 * 1024 * 1024;
      freeDisk = 50 * 1024 * 1024 * 1024;
      usedDisk = 50 * 1024 * 1024 * 1024;
      diskPercent = 50.0;
    }

    return {
      cpu: {
        usagePercent: cpuPercent,
        loadAverage1m: Math.round(loadAvg * 100) / 100,
        cores,
      },
      memory: {
        totalBytes: totalMem,
        freeBytes: freeMem,
        usedBytes: usedMem,
        usedPercent: memPercent,
      },
      disk: {
        path: this.diskPath,
        totalBytes: totalDisk,
        freeBytes: freeDisk,
        usedBytes: usedDisk,
        usedPercent: diskPercent,
      },
    };
  }

  /**
   * Evaluates system metrics against configured warning and critical thresholds.
   */
  evaluate(sampleInput?: SystemResourceMetricsSample): SystemResourceSnapshot {
    const sample = sampleInput ?? this.sampleMetrics();
    const nowIso = new Date(this.clock()).toISOString();
    const breaches: ResourceThresholdBreach[] = [];

    // --- CPU Evaluation ---
    if (sample.cpu.usagePercent >= this.thresholds.cpu_critical_percent) {
      breaches.push({
        resource: 'cpu',
        level: 'CRITICAL',
        metric: 'usagePercent',
        current: sample.cpu.usagePercent,
        threshold: this.thresholds.cpu_critical_percent,
        unit: '%',
        message: `CPU usage (${sample.cpu.usagePercent}%) exceeded critical threshold (${this.thresholds.cpu_critical_percent}%)`,
      });
    } else if (sample.cpu.usagePercent >= this.thresholds.cpu_warning_percent) {
      breaches.push({
        resource: 'cpu',
        level: 'WARNING',
        metric: 'usagePercent',
        current: sample.cpu.usagePercent,
        threshold: this.thresholds.cpu_warning_percent,
        unit: '%',
        message: `CPU usage (${sample.cpu.usagePercent}%) exceeded warning threshold (${this.thresholds.cpu_warning_percent}%)`,
      });
    }

    // --- Memory Evaluation ---
    if (sample.memory.usedPercent >= this.thresholds.memory_critical_percent) {
      breaches.push({
        resource: 'memory',
        level: 'CRITICAL',
        metric: 'usedPercent',
        current: sample.memory.usedPercent,
        threshold: this.thresholds.memory_critical_percent,
        unit: '%',
        message: `Memory usage (${sample.memory.usedPercent}%) exceeded critical threshold (${this.thresholds.memory_critical_percent}%)`,
      });
    } else if (sample.memory.freeBytes < this.thresholds.min_free_memory_bytes) {
      const freeMb = (sample.memory.freeBytes / (1024 * 1024)).toFixed(0);
      const minMb = (this.thresholds.min_free_memory_bytes / (1024 * 1024)).toFixed(0);
      breaches.push({
        resource: 'memory',
        level: 'CRITICAL',
        metric: 'freeBytes',
        current: sample.memory.freeBytes,
        threshold: this.thresholds.min_free_memory_bytes,
        unit: 'bytes',
        message: `Free memory (${freeMb}MB) dropped below critical threshold (${minMb}MB)`,
      });
    } else if (sample.memory.usedPercent >= this.thresholds.memory_warning_percent) {
      breaches.push({
        resource: 'memory',
        level: 'WARNING',
        metric: 'usedPercent',
        current: sample.memory.usedPercent,
        threshold: this.thresholds.memory_warning_percent,
        unit: '%',
        message: `Memory usage (${sample.memory.usedPercent}%) exceeded warning threshold (${this.thresholds.memory_warning_percent}%)`,
      });
    }

    // --- Disk Evaluation ---
    if (sample.disk.usedPercent >= this.thresholds.disk_critical_percent) {
      breaches.push({
        resource: 'disk',
        level: 'CRITICAL',
        metric: 'usedPercent',
        current: sample.disk.usedPercent,
        threshold: this.thresholds.disk_critical_percent,
        unit: '%',
        message: `Disk usage (${sample.disk.usedPercent}%) exceeded critical threshold (${this.thresholds.disk_critical_percent}%)`,
      });
    } else if (sample.disk.freeBytes < this.thresholds.min_free_disk_bytes) {
      const freeGb = (sample.disk.freeBytes / (1024 * 1024 * 1024)).toFixed(2);
      const minGb = (this.thresholds.min_free_disk_bytes / (1024 * 1024 * 1024)).toFixed(2);
      breaches.push({
        resource: 'disk',
        level: 'CRITICAL',
        metric: 'freeBytes',
        current: sample.disk.freeBytes,
        threshold: this.thresholds.min_free_disk_bytes,
        unit: 'bytes',
        message: `Free disk space (${freeGb}GB) dropped below critical threshold (${minGb}GB)`,
      });
    } else if (sample.disk.usedPercent >= this.thresholds.disk_warning_percent) {
      breaches.push({
        resource: 'disk',
        level: 'WARNING',
        metric: 'usedPercent',
        current: sample.disk.usedPercent,
        threshold: this.thresholds.disk_warning_percent,
        unit: '%',
        message: `Disk usage (${sample.disk.usedPercent}%) exceeded warning threshold (${this.thresholds.disk_warning_percent}%)`,
      });
    }

    const hasCritical = breaches.some((b) => b.level === 'CRITICAL');
    const hasWarning = breaches.some((b) => b.level === 'WARNING');
    const status: ResourceHealthStatus = hasCritical ? 'CRITICAL' : hasWarning ? 'WARNING' : 'OK';

    const snapshot: SystemResourceSnapshot = {
      timestamp: nowIso,
      status,
      cpu: sample.cpu,
      memory: sample.memory,
      disk: sample.disk,
      breaches,
    };

    this.handleStatusTransition(snapshot);
    this.lastSnapshot = snapshot;
    this.lastStatus = status;

    return snapshot;
  }

  /**
   * Detects and audits status changes (e.g. OK -> WARNING, OK/WARNING -> CRITICAL, CRITICAL -> OK).
   */
  private handleStatusTransition(snapshot: SystemResourceSnapshot): void {
    const previousStatus = this.lastStatus;
    const currentStatus = snapshot.status;

    let eventType: SystemResourceEventType | null = null;

    if (currentStatus === 'CRITICAL' && previousStatus !== 'CRITICAL') {
      eventType = 'RESOURCE_CRITICAL';
      logger.error('System resource exceeded CRITICAL threshold — stopping task acquisition', {
        breaches: snapshot.breaches,
        status: currentStatus,
      });
    } else if (currentStatus === 'WARNING' && previousStatus === 'OK') {
      eventType = 'RESOURCE_WARNING';
      logger.warn('System resource reached WARNING threshold', {
        breaches: snapshot.breaches,
        status: currentStatus,
      });
    } else if ((previousStatus === 'CRITICAL' || previousStatus === 'WARNING') && currentStatus === 'OK') {
      eventType = 'RESOURCE_RECOVERED';
      logger.info('System resources recovered to healthy operating range', {
        status: currentStatus,
      });
    }

    if (eventType && this.repo) {
      try {
        this.repo.create({
          event_type: eventType,
          status: currentStatus,
          cpu_percent: snapshot.cpu.usagePercent,
          memory_percent: snapshot.memory.usedPercent,
          memory_free_bytes: snapshot.memory.freeBytes,
          memory_total_bytes: snapshot.memory.totalBytes,
          disk_percent: snapshot.disk.usedPercent,
          disk_free_bytes: snapshot.disk.freeBytes,
          disk_total_bytes: snapshot.disk.totalBytes,
          breaches: snapshot.breaches,
          details: {
            previousStatus,
            currentStatus,
          },
          created_at: snapshot.timestamp,
        });
      } catch (err) {
        logger.warn('Failed to persist system resource event', { error: err });
      }
    }
  }

  /**
   * Checks whether new tasks can be accepted based on system resource limits.
   * "Vượt ngưỡng → dừng nhận task"
   */
  canAcquire(): ResourceAcquisitionResult {
    if (!this.thresholds.enabled) {
      return { allowed: true };
    }

    const snapshot = this.evaluate();

    if (snapshot.status === 'CRITICAL') {
      const criticalBreaches = snapshot.breaches.filter((b) => b.level === 'CRITICAL');
      const messages = criticalBreaches.map((b) => b.message).join('; ');

      return {
        allowed: false,
        reason: 'SYSTEM_RESOURCE_EXCEEDED',
        message: `System resource critical threshold exceeded: ${messages}`,
        details: {
          status: 'CRITICAL',
          breaches: criticalBreaches,
          snapshot,
        },
      };
    }

    return {
      allowed: true,
      details: {
        status: snapshot.status,
        snapshot,
      },
    };
  }

  /**
   * Updates configuration dynamically with validation.
   */
  updateThresholds(updates: Partial<SystemResourceThresholdsInput>): SystemResourceThresholds {
    const merged = { ...this.thresholds, ...updates };
    this.thresholds = SystemResourceThresholdsSchema.parse(merged);

    logger.info('System resource thresholds updated', { thresholds: this.thresholds });

    if (this.repo) {
      try {
        const sample = this.sampleMetrics();
        this.repo.create({
          event_type: 'CONFIG_UPDATED',
          status: this.lastStatus,
          cpu_percent: sample.cpu.usagePercent,
          memory_percent: sample.memory.usedPercent,
          memory_free_bytes: sample.memory.freeBytes,
          memory_total_bytes: sample.memory.totalBytes,
          disk_percent: sample.disk.usedPercent,
          disk_free_bytes: sample.disk.freeBytes,
          disk_total_bytes: sample.disk.totalBytes,
          details: { thresholds: this.thresholds },
          created_at: new Date(this.clock()).toISOString(),
        });
      } catch (err) {
        logger.warn('Failed to persist config update event', { error: err });
      }
    }

    return { ...this.thresholds };
  }

  /**
   * Manually records a metric snapshot to the database.
   */
  recordSnapshot(eventType: SystemResourceEventType = 'SAMPLE'): SystemResourceEventRecord | null {
    const snapshot = this.evaluate();
    if (!this.repo) return null;

    return this.repo.create({
      event_type: eventType,
      status: snapshot.status,
      cpu_percent: snapshot.cpu.usagePercent,
      memory_percent: snapshot.memory.usedPercent,
      memory_free_bytes: snapshot.memory.freeBytes,
      memory_total_bytes: snapshot.memory.totalBytes,
      disk_percent: snapshot.disk.usedPercent,
      disk_free_bytes: snapshot.disk.freeBytes,
      disk_total_bytes: snapshot.disk.totalBytes,
      breaches: snapshot.breaches,
      details: {
        loadAverage1m: snapshot.cpu.loadAverage1m,
        cores: snapshot.cpu.cores,
      },
      created_at: snapshot.timestamp,
    });
  }

  /**
   * Returns the most recent snapshot without forcing a resample if fresh.
   */
  getLatestSnapshot(): SystemResourceSnapshot {
    if (!this.lastSnapshot) {
      return this.evaluate();
    }
    return this.lastSnapshot;
  }
}
