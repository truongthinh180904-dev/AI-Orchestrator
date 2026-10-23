import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type SystemResourceEventRecord,
  type CreateSystemResourceEventInput,
  type SystemResourceEventType,
  type ResourceHealthStatus,
  type ResourceThresholdBreach,
  AppError,
} from '@ai-orchestrator/shared';

function parseJsonData(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') {
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      return raw as Record<string, unknown>;
    }
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { text: raw };
  }
}

function parseBreaches(raw: unknown): ResourceThresholdBreach[] {
  if (Array.isArray(raw)) {
    return raw as ResourceThresholdBreach[];
  }
  if (typeof raw !== 'string') {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as ResourceThresholdBreach[];
    }
    return [];
  } catch {
    return [];
  }
}

function rowToSystemResourceEvent(row: Record<string, unknown>): SystemResourceEventRecord {
  return {
    id: String(row.id),
    event_type: String(row.event_type) as SystemResourceEventType,
    status: String(row.status) as ResourceHealthStatus,
    cpu_percent: Number(row.cpu_percent ?? 0),
    memory_percent: Number(row.memory_percent ?? 0),
    memory_free_bytes: Number(row.memory_free_bytes ?? 0),
    memory_total_bytes: Number(row.memory_total_bytes ?? 0),
    disk_percent: Number(row.disk_percent ?? 0),
    disk_free_bytes: Number(row.disk_free_bytes ?? 0),
    disk_total_bytes: Number(row.disk_total_bytes ?? 0),
    breaches: parseBreaches(row.breaches),
    details: parseJsonData(row.details),
    created_at: String(row.created_at),
  };
}

export interface SystemResourceEventFilter {
  eventType?: SystemResourceEventType;
  status?: ResourceHealthStatus;
  since?: string;
  limit?: number;
}

export class SystemResourceRepository {
  private readonly getByIdStmt: Database.Statement;
  private readonly getLatestStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.getByIdStmt = this.db.prepare(
      `SELECT * FROM system_resource_events WHERE id = ? LIMIT 1`,
    );
    this.getLatestStmt = this.db.prepare(
      `SELECT * FROM system_resource_events ORDER BY created_at DESC LIMIT 1`,
    );
    this.countStmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM system_resource_events`,
    );
  }

  create(input: CreateSystemResourceEventInput): SystemResourceEventRecord {
    const id = input.id ?? crypto.randomUUID();
    const createdAt = input.created_at ?? new Date().toISOString();
    const breachesJson = JSON.stringify(input.breaches ?? []);
    const detailsJson = JSON.stringify(input.details ?? {});

    try {
      this.db
        .prepare(
          `INSERT INTO system_resource_events (
            id, event_type, status,
            cpu_percent, memory_percent, memory_free_bytes, memory_total_bytes,
            disk_percent, disk_free_bytes, disk_total_bytes,
            breaches, details, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.event_type,
          input.status,
          input.cpu_percent,
          input.memory_percent,
          input.memory_free_bytes,
          input.memory_total_bytes,
          input.disk_percent,
          input.disk_free_bytes,
          input.disk_total_bytes,
          breachesJson,
          detailsJson,
          createdAt,
        );

      return {
        id,
        event_type: input.event_type,
        status: input.status,
        cpu_percent: input.cpu_percent,
        memory_percent: input.memory_percent,
        memory_free_bytes: input.memory_free_bytes,
        memory_total_bytes: input.memory_total_bytes,
        disk_percent: input.disk_percent,
        disk_free_bytes: input.disk_free_bytes,
        disk_total_bytes: input.disk_total_bytes,
        breaches: input.breaches ?? [],
        details: input.details ?? {},
        created_at: createdAt,
      };
    } catch (err) {
      throw new AppError(
        'DATABASE_ERROR',
        `Failed to record system resource event: ${err instanceof Error ? err.message : String(err)}`,
        { error: err, input },
      );
    }
  }

  findById(id: string): SystemResourceEventRecord | null {
    const row = this.getByIdStmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToSystemResourceEvent(row);
  }

  findLatest(): SystemResourceEventRecord | null {
    const row = this.getLatestStmt.get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToSystemResourceEvent(row);
  }

  findAll(filter?: SystemResourceEventFilter): SystemResourceEventRecord[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter?.eventType) {
      conditions.push('event_type = ?');
      params.push(filter.eventType);
    }

    if (filter?.status) {
      conditions.push('status = ?');
      params.push(filter.status);
    }

    if (filter?.since) {
      conditions.push('created_at >= ?');
      params.push(filter.since);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter?.limit ?? 50;
    const query = `SELECT * FROM system_resource_events ${whereClause} ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map(rowToSystemResourceEvent);
  }

  count(): number {
    const row = this.countStmt.get() as { count: number };
    return row.count;
  }
}
