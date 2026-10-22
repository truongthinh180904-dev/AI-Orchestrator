import type Database from 'better-sqlite3';
import {
  type AgentLock,
  type CreateAgentLockInput,
  AgentLockSchema,
  CreateAgentLockSchema,
  AppError,
} from '@ai-orchestrator/shared';

function rowToLock(row: Record<string, unknown>): AgentLock {
  return AgentLockSchema.parse({
    id: row.id,
    task_id: row.task_id,
    run_id: row.run_id ?? null,
    acquired_at: row.acquired_at,
    owner_pid: row.owner_pid ?? null,
    metadata: row.metadata ?? null,
  });
}

export class AgentLockRepository {
  constructor(private readonly db: Database.Database) {}

  getCurrentLock(id = 'default_agent'): AgentLock | null {
    const row = this.db
      .prepare('SELECT id, task_id, run_id, acquired_at, owner_pid, metadata FROM agent_locks WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }
    return rowToLock(row);
  }

  isLocked(id = 'default_agent'): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM agent_locks WHERE id = ?')
      .get(id);
    return Boolean(row);
  }

  findAll(): AgentLock[] {
    const rows = this.db
      .prepare('SELECT id, task_id, run_id, acquired_at, owner_pid, metadata FROM agent_locks ORDER BY acquired_at ASC')
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToLock);
  }

  acquire(input: CreateAgentLockInput): AgentLock {
    const validated = CreateAgentLockSchema.parse(input);
    const lockId = validated.id ?? 'default_agent';
    const acquiredAt = validated.acquired_at ?? new Date().toISOString();

    const acquireTx = this.db.transaction(() => {
      const existing = this.getCurrentLock(lockId);
      if (existing) {
        throw new AppError(
          'AGENT_LOCK_HELD',
          `Agent lock '${lockId}' is currently held by task '${existing.task_id}'`,
          {
            lockId,
            currentLock: existing,
          },
        );
      }

      this.db
        .prepare(`
          INSERT INTO agent_locks (id, task_id, run_id, acquired_at, owner_pid, metadata)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          lockId,
          validated.task_id,
          validated.run_id ?? null,
          acquiredAt,
          validated.owner_pid ?? null,
          validated.metadata ?? null,
        );

      const created = this.getCurrentLock(lockId);
      if (!created) {
        throw new AppError('AGENT_LOCK_ERROR', `Failed to retrieve created lock '${lockId}'`, { lockId });
      }
      return created;
    });

    return acquireTx.immediate();
  }

  release(id = 'default_agent', taskId?: string): boolean {
    let result: Database.RunResult;
    if (taskId) {
      result = this.db
        .prepare('DELETE FROM agent_locks WHERE id = ? AND task_id = ?')
        .run(id, taskId);
    } else {
      result = this.db
        .prepare('DELETE FROM agent_locks WHERE id = ?')
        .run(id);
    }
    return result.changes > 0;
  }

  updateRunId(id: string, runId: string): void {
    this.db
      .prepare('UPDATE agent_locks SET run_id = ? WHERE id = ?')
      .run(runId, id);
  }

  forceRelease(id = 'default_agent'): void {
    this.db.prepare('DELETE FROM agent_locks WHERE id = ?').run(id);
  }
}
