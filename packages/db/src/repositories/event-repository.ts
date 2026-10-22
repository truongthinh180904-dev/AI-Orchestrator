import type Database from 'better-sqlite3';
import {
  type EventRecord,
  type CreateEventInput,
  type EventFilter,
  CreateEventInputSchema,
  EventFilterSchema,
  AppError,
} from '@ai-orchestrator/shared';

function parsePayload(raw: unknown): unknown {
  if (typeof raw !== 'string') {
    return raw;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

function serializePayload(payload: unknown): string {
  if (typeof payload === 'string') {
    // If it's already a valid JSON string representing an object/array, preserve it
    const trimmed = payload.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        JSON.parse(trimmed);
        return trimmed;
      } catch {
        // Fall back to string serialization
      }
    }
    return JSON.stringify(payload);
  }
  try {
    return JSON.stringify(payload ?? null);
  } catch (err) {
    throw new AppError(
      'INVALID_PAYLOAD',
      `Cannot serialize event payload to JSON: ${err instanceof Error ? err.message : String(err)}`,
      { payload },
    );
  }
}

function rowToEvent(row: Record<string, unknown>): EventRecord {
  return {
    id: Number(row.id),
    run_id: String(row.run_id),
    seq: Number(row.seq),
    type: String(row.type),
    payload: parsePayload(row.payload),
    ts: String(row.ts),
  };
}

export class EventRepository {
  private readonly insertStmt: Database.Statement;
  private readonly nextSeqStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = this.db.prepare(
      'INSERT INTO events (run_id, seq, type, payload, ts) VALUES (?, ?, ?, ?, ?)',
    );
    this.nextSeqStmt = this.db.prepare(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM events WHERE run_id = ?',
    );
    this.countStmt = this.db.prepare('SELECT COUNT(*) as count FROM events WHERE run_id = ?');
  }

  getNextSeq(runId: string): number {
    const row = this.nextSeqStmt.get(runId) as { next_seq: number } | undefined;
    return row ? Number(row.next_seq) : 1;
  }

  create(input: CreateEventInput): EventRecord {
    const validated = CreateEventInputSchema.parse(input);
    const ts = validated.ts ?? new Date().toISOString();
    const seq = validated.seq ?? this.getNextSeq(validated.run_id);
    const payloadStr = serializePayload(validated.payload);

    try {
      const result = this.insertStmt.run(validated.run_id, seq, validated.type, payloadStr, ts);

      return {
        id: Number(result.lastInsertRowid),
        run_id: validated.run_id,
        seq,
        type: validated.type,
        payload: parsePayload(payloadStr),
        ts,
      };
    } catch (err) {
      throw new AppError(
        'DATABASE_ERROR',
        `Failed to insert event for run "${validated.run_id}": ${err instanceof Error ? err.message : String(err)}`,
        { input: validated, originalError: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  createBatch(inputs: CreateEventInput[]): EventRecord[] {
    if (inputs.length === 0) {
      return [];
    }

    const insertMany = this.db.transaction((items: CreateEventInput[]) => {
      const records: EventRecord[] = [];
      const runSeqMap = new Map<string, number>();

      for (const item of items) {
        const validated = CreateEventInputSchema.parse(item);
        const ts = validated.ts ?? new Date().toISOString();

        let seq = validated.seq;
        if (seq === undefined) {
          const currentSeq = runSeqMap.get(validated.run_id) ?? this.getNextSeq(validated.run_id);
          seq = currentSeq;
          runSeqMap.set(validated.run_id, currentSeq + 1);
        } else {
          runSeqMap.set(validated.run_id, seq + 1);
        }

        const payloadStr = serializePayload(validated.payload);
        const result = this.insertStmt.run(validated.run_id, seq, validated.type, payloadStr, ts);

        records.push({
          id: Number(result.lastInsertRowid),
          run_id: validated.run_id,
          seq,
          type: validated.type,
          payload: parsePayload(payloadStr),
          ts,
        });
      }

      return records;
    });

    try {
      return insertMany(inputs);
    } catch (err) {
      throw new AppError(
        'DATABASE_ERROR',
        `Failed to batch insert events: ${err instanceof Error ? err.message : String(err)}`,
        { count: inputs.length, originalError: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  findByRunId(runId: string, filter?: EventFilter): EventRecord[] {
    const validatedFilter = filter ? EventFilterSchema.parse(filter) : {};
    const conditions: string[] = ['run_id = ?'];
    const params: unknown[] = [runId];

    if (validatedFilter.after_seq !== undefined) {
      conditions.push('seq > ?');
      params.push(validatedFilter.after_seq);
    }

    if (validatedFilter.type !== undefined) {
      conditions.push('type = ?');
      params.push(validatedFilter.type);
    }

    let sql = `SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY seq ASC`;

    if (validatedFilter.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(validatedFilter.limit);

      if (validatedFilter.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(validatedFilter.offset);
      }
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  }

  countByRunId(runId: string, type?: string): number {
    if (type) {
      const stmt = this.db.prepare(
        'SELECT COUNT(*) as count FROM events WHERE run_id = ? AND type = ?',
      );
      const row = stmt.get(runId, type) as { count: number } | undefined;
      return row ? Number(row.count) : 0;
    }
    const row = this.countStmt.get(runId) as { count: number } | undefined;
    return row ? Number(row.count) : 0;
  }

  getRawLogs(runId: string): { type: string; text: string; seq: number; ts: string }[] {
    const sql = `
      SELECT seq, type, payload, ts
      FROM events
      WHERE run_id = ? AND type IN ('stdout', 'stderr', 'stdout_raw', 'stderr_raw')
      ORDER BY seq ASC
    `;
    const rows = this.db.prepare(sql).all(runId) as Record<string, unknown>[];

    return rows.map((row) => {
      const payload = parsePayload(row.payload);
      let text: string;
      if (typeof payload === 'string') {
        text = payload;
      } else if (
        payload &&
        typeof payload === 'object' &&
        'text' in payload &&
        typeof (payload as { text: unknown }).text === 'string'
      ) {
        text = (payload as { text: string }).text;
      } else if (
        payload &&
        typeof payload === 'object' &&
        'raw' in payload &&
        typeof (payload as { raw: unknown }).raw === 'string'
      ) {
        text = (payload as { raw: string }).raw;
      } else {
        text = JSON.stringify(payload);
      }

      return {
        type: String(row.type),
        text,
        seq: Number(row.seq),
        ts: String(row.ts),
      };
    });
  }
}
