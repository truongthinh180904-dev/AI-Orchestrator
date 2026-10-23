import type Database from 'better-sqlite3';
import {
  type Feature,
  type CreateFeatureInput,
  type UpdateFeatureInput,
  type FeatureFilter,
  type TaskWithDependencies,
  type FeatureRelease,
  FeatureSchema,
  CreateFeatureInputSchema,
  UpdateFeatureInputSchema,
  FeatureFilterSchema,
  AppError,
} from '@ai-orchestrator/shared';
import { TaskRepository } from './task-repository.js';
import { FeatureReleaseRepository } from './feature-release-repository.js';

function rowToFeature(row: Record<string, unknown>): Feature {
  let required_tasks: unknown = [];
  let integration_tests: unknown = [];

  if (typeof row.required_tasks === 'string') {
    try {
      required_tasks = JSON.parse(row.required_tasks);
    } catch {
      required_tasks = [];
    }
  } else if (Array.isArray(row.required_tasks)) {
    required_tasks = row.required_tasks;
  }

  if (typeof row.integration_tests === 'string') {
    try {
      integration_tests = JSON.parse(row.integration_tests);
    } catch {
      integration_tests = [];
    }
  } else if (Array.isArray(row.integration_tests)) {
    integration_tests = row.integration_tests;
  }

  const raw = {
    ...row,
    required_tasks,
    integration_tests,
  };

  return FeatureSchema.parse(raw);
}

export class FeatureRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateFeatureInput): Feature {
    const validated = CreateFeatureInputSchema.parse(input);
    const now = new Date().toISOString();
    const createdAt = validated.created_at ?? now;
    const updatedAt = validated.updated_at ?? now;

    const stmt = this.db.prepare(`
      INSERT INTO features (
        id, name, description, required_tasks, integration_tests, release_policy, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      stmt.run(
        validated.id,
        validated.name,
        validated.description ?? null,
        JSON.stringify(validated.required_tasks ?? []),
        JSON.stringify(validated.integration_tests ?? []),
        validated.release_policy ?? null,
        validated.status ?? 'TODO',
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
          'FEATURE_ALREADY_EXISTS',
          `Feature with id '${validated.id}' already exists`,
          { featureId: validated.id },
        );
      }
      throw error;
    }

    const created = this.findById(validated.id);
    if (!created) {
      throw new AppError(
        'FEATURE_CREATION_FAILED',
        `Failed to retrieve created feature '${validated.id}'`,
        { featureId: validated.id },
      );
    }
    return created;
  }

  createMany(features: CreateFeatureInput[]): Feature[] {
    if (features.length === 0) return [];

    const validatedFeatures = features.map((f) => CreateFeatureInputSchema.parse(f));

    const seenBatch = new Set<string>();
    for (const feat of validatedFeatures) {
      if (seenBatch.has(feat.id)) {
        throw new AppError('DUPLICATE_FEATURE_ID', `Duplicate feature id '${feat.id}' found in batch`, {
          featureId: feat.id,
        });
      }
      seenBatch.add(feat.id);
    }

    const batchIds = Array.from(seenBatch);
    const placeholders = batchIds.map(() => '?').join(',');
    const existingRows = this.db
      .prepare(`SELECT id FROM features WHERE id IN (${placeholders})`)
      .all(...batchIds) as Array<{ id: string }>;
    if (existingRows.length > 0) {
      const conflictId = existingRows[0]?.id;
      throw new AppError('FEATURE_ALREADY_EXISTS', `Feature with id '${conflictId}' already exists in database`, {
        featureId: conflictId,
      });
    }

    const insertTx = this.db.transaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO features (
          id, name, description, required_tasks, integration_tests, release_policy, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = new Date().toISOString();
      for (const f of validatedFeatures) {
        const createdAt = f.created_at ?? now;
        const updatedAt = f.updated_at ?? now;
        stmt.run(
          f.id,
          f.name,
          f.description ?? null,
          JSON.stringify(f.required_tasks ?? []),
          JSON.stringify(f.integration_tests ?? []),
          f.release_policy ?? null,
          f.status ?? 'TODO',
          createdAt,
          updatedAt,
        );
      }
    });

    insertTx();

    return validatedFeatures.map((f) => {
      const found = this.findById(f.id);
      if (!found) {
        throw new AppError('FEATURE_NOT_FOUND', `Failed to find feature '${f.id}' after batch insert`);
      }
      return found;
    });
  }

  findById(id: string): Feature | null {
    const stmt = this.db.prepare('SELECT * FROM features WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToFeature(row);
  }

  findAll(filter?: FeatureFilter): Feature[] {
    const validatedFilter = filter ? FeatureFilterSchema.parse(filter) : undefined;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (validatedFilter?.status) {
      conditions.push('status = ?');
      params.push(validatedFilter.status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `SELECT * FROM features ${whereClause} ORDER BY created_at ASC, id ASC`;
    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];

    return rows.map((r) => rowToFeature(r));
  }

  update(id: string, input: UpdateFeatureInput): Feature {
    const validated = UpdateFeatureInputSchema.parse(input);
    const existing = this.findById(id);
    if (!existing) {
      throw new AppError('FEATURE_NOT_FOUND', `Feature with id '${id}' not found`, {
        featureId: id,
      });
    }

    const updates: string[] = [];
    const params: unknown[] = [];

    if (validated.name !== undefined) {
      updates.push('name = ?');
      params.push(validated.name);
    }
    if (validated.description !== undefined) {
      updates.push('description = ?');
      params.push(validated.description);
    }
    if (validated.required_tasks !== undefined) {
      updates.push('required_tasks = ?');
      params.push(JSON.stringify(validated.required_tasks));
    }
    if (validated.integration_tests !== undefined) {
      updates.push('integration_tests = ?');
      params.push(JSON.stringify(validated.integration_tests));
    }
    if (validated.release_policy !== undefined) {
      updates.push('release_policy = ?');
      params.push(validated.release_policy);
    }
    if (validated.status !== undefined) {
      updates.push('status = ?');
      params.push(validated.status);
    }

    const updatedAt = validated.updated_at ?? new Date().toISOString();
    updates.push('updated_at = ?');
    params.push(updatedAt);

    params.push(id);
    const query = `UPDATE features SET ${updates.join(', ')} WHERE id = ?`;
    this.db.prepare(query).run(...params);

    const updated = this.findById(id);
    if (!updated) {
      throw new AppError('FEATURE_NOT_FOUND', `Feature with id '${id}' not found after update`, {
        featureId: id,
      });
    }
    return updated;
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM features WHERE id = ?').run(id);
    return result.changes > 0;
  }

  exists(id: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM features WHERE id = ?').get(id);
    return row !== undefined;
  }

  count(filter?: FeatureFilter): number {
    const validatedFilter = filter ? FeatureFilterSchema.parse(filter) : undefined;
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (validatedFilter?.status) {
      conditions.push('status = ?');
      params.push(validatedFilter.status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const query = `SELECT COUNT(*) as count FROM features ${whereClause}`;
    const row = this.db.prepare(query).get(...params) as { count: number };
    return row.count;
  }

  /**
   * Lấy danh sách task thành phần thuộc feature (gồm tasks có feature_id = id và tasks trong required_tasks).
   */
  getComponentTasks(featureId: string): { feature: Feature; tasks: TaskWithDependencies[] } {
    const feature = this.findById(featureId);
    if (!feature) {
      throw new AppError('FEATURE_NOT_FOUND', `Feature with id '${featureId}' not found`, {
        featureId,
      });
    }

    const taskRepo = new TaskRepository(this.db);
    // 1. Lấy tasks liên kết qua feature_id
    const tasksByFeature = taskRepo.findAll({ feature_id: featureId });
    const taskMap = new Map<string, TaskWithDependencies>();
    for (const t of tasksByFeature) {
      taskMap.set(t.id, t);
    }

    // 2. Lấy thêm tasks được khai báo trong required_tasks nếu chưa có
    for (const reqId of feature.required_tasks) {
      if (!taskMap.has(reqId)) {
        const found = taskRepo.findById(reqId);
        if (found) {
          taskMap.set(found.id, found);
        }
      }
    }

    return {
      feature,
      tasks: Array.from(taskMap.values()),
    };
  }

  /**
   * Thiết lập danh sách task bắt buộc cho feature.
   */
  setRequiredTasks(featureId: string, requiredTasks: string[]): Feature {
    const feature = this.findById(featureId);
    if (!feature) {
      throw new AppError('FEATURE_NOT_FOUND', `Feature with id '${featureId}' not found`, {
        featureId,
      });
    }

    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE features SET required_tasks = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(requiredTasks), now, featureId);

    const updated = this.findById(featureId);
    if (!updated) {
      throw new AppError('FEATURE_NOT_FOUND', `Feature with id '${featureId}' not found after update`);
    }
    return updated;
  }

  /**
   * Gán danh sách task vào feature (cập nhật feature_id = featureId).
   */
  assignTasks(featureId: string, taskIds: string[]): void {
    const feature = this.findById(featureId);
    if (!feature) {
      throw new AppError('FEATURE_NOT_FOUND', `Feature with id '${featureId}' not found`, {
        featureId,
      });
    }
    if (taskIds.length === 0) return;

    const now = new Date().toISOString();
    const placeholders = taskIds.map(() => '?').join(', ');
    this.db
      .prepare(`UPDATE tasks SET feature_id = ?, updated_at = ? WHERE id IN (${placeholders})`)
      .run(featureId, now, ...taskIds);
  }

  /**
   * Gỡ các task khỏi feature (cập nhật feature_id = NULL).
   */
  unassignTasks(featureId: string, taskIds: string[]): void {
    const feature = this.findById(featureId);
    if (!feature) {
      throw new AppError('FEATURE_NOT_FOUND', `Feature with id '${featureId}' not found`, {
        featureId,
      });
    }
    if (taskIds.length === 0) return;

    const now = new Date().toISOString();
    const placeholders = taskIds.map(() => '?').join(', ');
    this.db
      .prepare(
        `UPDATE tasks SET feature_id = NULL, updated_at = ? WHERE feature_id = ? AND id IN (${placeholders})`,
      )
      .run(now, featureId, ...taskIds);
  }

  /**
   * Lấy bản ghi release mới nhất của feature nếu có.
   */
  getRelease(featureId: string): FeatureRelease | null {
    const releaseRepo = new FeatureReleaseRepository(this.db);
    return releaseRepo.findByFeatureId(featureId);
  }
}

