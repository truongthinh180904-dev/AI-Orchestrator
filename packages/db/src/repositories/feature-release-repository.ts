import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  type FeatureRelease,
  type CreateFeatureReleaseInput,
  type UpdateFeatureReleaseInput,
  type FeatureReleaseStatus,
  FeatureReleaseSchema,
  CreateFeatureReleaseInputSchema,
  UpdateFeatureReleaseInputSchema,
  AppError,
} from '@ai-orchestrator/shared';

function rowToFeatureRelease(row: Record<string, unknown>): FeatureRelease {
  let metadata: unknown = {};
  if (typeof row.metadata_json === 'string') {
    try {
      metadata = JSON.parse(row.metadata_json);
    } catch {
      metadata = {};
    }
  } else if (row.metadata_json && typeof row.metadata_json === 'object') {
    metadata = row.metadata_json;
  }

  const raw = {
    ...row,
    metadata,
  };

  return FeatureReleaseSchema.parse(raw);
}

export class FeatureReleaseRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateFeatureReleaseInput): FeatureRelease {
    const validated = CreateFeatureReleaseInputSchema.parse(input);
    const id = validated.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const createdAt = validated.created_at ?? now;
    const updatedAt = validated.updated_at ?? now;

    const stmt = this.db.prepare(`
      INSERT INTO feature_releases (
        id, feature_id, branch, base_branch, commit_sha, pr_url, status, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        id,
        validated.feature_id,
        validated.branch,
        validated.base_branch,
        validated.commit_sha ?? null,
        validated.pr_url ?? null,
        validated.status ?? 'BRANCH_CREATED',
        JSON.stringify(validated.metadata ?? {}),
        createdAt,
        updatedAt,
      );
    } catch (error: unknown) {
      const sqliteErr = error as { code?: string; message?: string };
      if (
        sqliteErr.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
        sqliteErr.code === 'SQLITE_CONSTRAINT_UNIQUE'
      ) {
        throw new AppError(
          'BRANCH_ALREADY_EXISTS',
          `Feature release or branch '${validated.branch}' already exists`,
          {
            featureId: validated.feature_id,
            branch: validated.branch,
          },
        );
      }
      throw error;
    }

    const created = this.findById(id);
    if (!created) {
      throw new AppError(
        'RELEASE_CREATION_FAILED',
        `Failed to retrieve created feature release '${id}'`,
        { id, featureId: validated.feature_id },
      );
    }

    return created;
  }

  findById(id: string): FeatureRelease | null {
    const stmt = this.db.prepare('SELECT * FROM feature_releases WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? rowToFeatureRelease(row) : null;
  }

  findByFeatureId(featureId: string): FeatureRelease | null {
    const stmt = this.db.prepare(
      'SELECT * FROM feature_releases WHERE feature_id = ? ORDER BY created_at DESC LIMIT 1',
    );
    const row = stmt.get(featureId) as Record<string, unknown> | undefined;
    return row ? rowToFeatureRelease(row) : null;
  }

  findByBranch(branch: string): FeatureRelease | null {
    const stmt = this.db.prepare('SELECT * FROM feature_releases WHERE branch = ?');
    const row = stmt.get(branch) as Record<string, unknown> | undefined;
    return row ? rowToFeatureRelease(row) : null;
  }

  update(id: string, input: UpdateFeatureReleaseInput): FeatureRelease {
    const existing = this.findById(id);
    if (!existing) {
      throw new AppError('RELEASE_NOT_FOUND', `Feature release with id '${id}' not found`, { id });
    }

    const validated = UpdateFeatureReleaseInputSchema.parse(input);
    const updates: string[] = [];
    const values: unknown[] = [];

    if (validated.branch !== undefined) {
      updates.push('branch = ?');
      values.push(validated.branch);
    }
    if (validated.base_branch !== undefined) {
      updates.push('base_branch = ?');
      values.push(validated.base_branch);
    }
    if (validated.commit_sha !== undefined) {
      updates.push('commit_sha = ?');
      values.push(validated.commit_sha);
    }
    if (validated.pr_url !== undefined) {
      updates.push('pr_url = ?');
      values.push(validated.pr_url);
    }
    if (validated.status !== undefined) {
      updates.push('status = ?');
      values.push(validated.status);
    }
    if (validated.metadata !== undefined) {
      updates.push('metadata_json = ?');
      values.push(JSON.stringify(validated.metadata));
    }

    const now = new Date().toISOString();
    updates.push('updated_at = ?');
    values.push(validated.updated_at ?? now);

    values.push(id);

    try {
      this.db.prepare(`UPDATE feature_releases SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    } catch (error: unknown) {
      const sqliteErr = error as { code?: string; message?: string };
      if (sqliteErr.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new AppError(
          'BRANCH_ALREADY_EXISTS',
          `Branch name conflict during update: '${validated.branch}' already exists`,
          { id, branch: validated.branch },
        );
      }
      throw error;
    }

    const updated = this.findById(id);
    if (!updated) {
      throw new AppError('RELEASE_NOT_FOUND', `Feature release with id '${id}' not found after update`, { id });
    }

    return updated;
  }

  list(filter?: { feature_id?: string; status?: FeatureReleaseStatus }): FeatureRelease[] {
    const clauses: string[] = [];
    const values: unknown[] = [];

    if (filter?.feature_id) {
      clauses.push('feature_id = ?');
      values.push(filter.feature_id);
    }
    if (filter?.status) {
      clauses.push('status = ?');
      values.push(filter.status);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const stmt = this.db.prepare(`SELECT * FROM feature_releases ${where} ORDER BY created_at DESC`);
    const rows = stmt.all(...values) as Record<string, unknown>[];

    return rows.map(rowToFeatureRelease);
  }

  delete(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM feature_releases WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }
}
