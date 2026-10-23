import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase, runMigrations } from '../index.js';
import { PlanRepository, FeatureRepository } from '../repositories/index.js';
import { AppError } from '@ai-orchestrator/shared';

describe('PlanRepository', () => {
  let db: Database.Database;
  let repo: PlanRepository;
  let featureRepo: FeatureRepository;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    repo = new PlanRepository(db);
    featureRepo = new FeatureRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates, finds and retrieves a plan with tasks', () => {
    const created = repo.create({
      id: 'plan-1',
      title: 'Authentication Module',
      description: 'Implement JWT authentication',
      repository: '.',
      status: 'PENDING_APPROVAL',
      tasks: [
        {
          id: 'AUTH-1',
          title: 'Database tables',
          scope_files: ['migrations/005_auth.sql'],
          acceptance_criteria: ['Tables created'],
          dependencies: [],
        },
        {
          id: 'AUTH-2',
          title: 'JWT middleware',
          scope_files: ['src/middleware/jwt.ts'],
          acceptance_criteria: ['Tokens verified'],
          dependencies: ['AUTH-1'],
        },
      ],
    });

    expect(created.id).toBe('plan-1');
    expect(created.status).toBe('PENDING_APPROVAL');
    expect(created.tasks).toHaveLength(2);
    expect(created.tasks[0]?.scope_files).toEqual(['migrations/005_auth.sql']);

    const fetched = repo.findById('plan-1');
    expect(fetched).toBeDefined();
    expect(fetched?.title).toBe('Authentication Module');
    expect(fetched?.tasks[1]?.dependencies).toEqual(['AUTH-1']);
  });

  it('filters plans by status and repository', () => {
    repo.create({
      id: 'plan-draft',
      title: 'Draft plan',
      status: 'DRAFT',
      repository: 'repo-a',
      tasks: [
        {
          id: 'T1',
          title: 'Task 1',
          scope_files: ['f1.ts'],
          acceptance_criteria: ['done'],
        },
      ],
    });

    repo.create({
      id: 'plan-pending',
      title: 'Pending plan',
      status: 'PENDING_APPROVAL',
      repository: 'repo-b',
      tasks: [
        {
          id: 'T2',
          title: 'Task 2',
          scope_files: ['f2.ts'],
          acceptance_criteria: ['done'],
        },
      ],
    });

    const pending = repo.findAll({ status: 'PENDING_APPROVAL' });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe('plan-pending');

    const repoA = repo.findAll({ repository: 'repo-a' });
    expect(repoA).toHaveLength(1);
    expect(repoA[0]?.id).toBe('plan-draft');
  });

  it('updates plan fields and status', () => {
    repo.create({
      id: 'plan-up',
      title: 'Initial Title',
      status: 'PENDING_APPROVAL',
      tasks: [
        {
          id: 'T1',
          title: 'Initial Task',
          scope_files: ['a.ts'],
          acceptance_criteria: ['ok'],
        },
      ],
    });

    const updated = repo.update('plan-up', {
      title: 'Updated Title',
      status: 'APPROVED',
      approved_by: 'lead_dev',
      approved_at: '2026-10-23T08:00:00.000Z',
    });

    expect(updated.title).toBe('Updated Title');
    expect(updated.status).toBe('APPROVED');
    expect(updated.approved_by).toBe('lead_dev');

    const fetched = repo.findById('plan-up');
    expect(fetched?.status).toBe('APPROVED');
  });

  it('deletes plan by id', () => {
    repo.create({
      id: 'plan-del',
      title: 'To Delete',
      tasks: [
        {
          id: 'T1',
          title: 'Task',
          scope_files: ['a.ts'],
          acceptance_criteria: ['ok'],
        },
      ],
    });

    const deleted = repo.delete('plan-del');
    expect(deleted).toBe(true);

    const missing = repo.findById('plan-del');
    expect(missing).toBeUndefined();
  });

  it('links plan to a feature and enforces foreign key integrity', () => {
    featureRepo.create({
      id: 'FEAT-1',
      name: 'Auth Feature',
      required_tasks: [],
      integration_tests: [],
      status: 'TODO',
    });

    const plan = repo.create({
      id: 'plan-feat',
      feature_id: 'FEAT-1',
      title: 'Feature Plan',
      tasks: [
        {
          id: 'T1',
          title: 'T1',
          scope_files: ['f.ts'],
          acceptance_criteria: ['done'],
        },
      ],
    });

    expect(plan.feature_id).toBe('FEAT-1');

    // Linking to invalid feature should fail foreign key check
    expect(() =>
      repo.create({
        id: 'plan-invalid-feat',
        feature_id: 'NON_EXISTENT_FEAT',
        title: 'Invalid',
        tasks: [
          {
            id: 'T1',
            title: 'T1',
            scope_files: ['f.ts'],
            acceptance_criteria: ['done'],
          },
        ],
      }),
    ).toThrow(AppError);
  });
});
