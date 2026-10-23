import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrator.js';
import { FeatureRepository } from '../repositories/feature-repository.js';
import { TaskRepository } from '../repositories/task-repository.js';
import { AppError } from '@ai-orchestrator/shared';

describe('FeatureRepository Component Tasks', () => {
  let db: Database.Database;
  let featureRepo: FeatureRepository;
  let taskRepo: TaskRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    featureRepo = new FeatureRepository(db);
    taskRepo = new TaskRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('Lấy danh sách task thành phần thuộc feature (getComponentTasks)', () => {
    featureRepo.create({
      id: 'FEAT-PAYMENT',
      name: 'Payment Integration',
      required_tasks: ['PAY-001', 'PAY-002'],
      integration_tests: ['pnpm test:payment'],
    });

    taskRepo.create({
      id: 'PAY-001',
      feature_id: 'FEAT-PAYMENT',
      title: 'Payment DB Schema',
      status: 'DONE',
    });

    taskRepo.create({
      id: 'PAY-002',
      feature_id: 'FEAT-PAYMENT',
      title: 'Stripe Gateway Client',
      status: 'RUNNING',
    });

    taskRepo.create({
      id: 'PAY-OPTIONAL',
      feature_id: 'FEAT-PAYMENT',
      title: 'Optional Payment Analytics',
      status: 'TODO',
    });

    const res = featureRepo.getComponentTasks('FEAT-PAYMENT');
    expect(res.feature.id).toBe('FEAT-PAYMENT');
    expect(res.tasks).toHaveLength(3);
    const taskIds = res.tasks.map((t) => t.id).sort();
    expect(taskIds).toEqual(['PAY-001', 'PAY-002', 'PAY-OPTIONAL']);
  });

  it('Ném AppError(FEATURE_NOT_FOUND) khi feature không tồn tại', () => {
    expect(() => featureRepo.getComponentTasks('NON_EXISTENT')).toThrowError(AppError);
  });

  it('Cập nhật tập task bắt buộc (setRequiredTasks)', () => {
    featureRepo.create({
      id: 'FEAT-AUTH',
      name: 'Auth',
      required_tasks: ['AUTH-1'],
    });

    const updated = featureRepo.setRequiredTasks('FEAT-AUTH', ['AUTH-1', 'AUTH-2', 'AUTH-3']);
    expect(updated.required_tasks).toEqual(['AUTH-1', 'AUTH-2', 'AUTH-3']);

    const fetched = featureRepo.findById('FEAT-AUTH');
    expect(fetched?.required_tasks).toEqual(['AUTH-1', 'AUTH-2', 'AUTH-3']);
  });

  it('Gán và gỡ task vào/khỏi feature (assignTasks & unassignTasks)', () => {
    featureRepo.create({
      id: 'FEAT-CORE',
      name: 'Core System',
    });

    taskRepo.create({ id: 'TASK-1', title: 'Task 1' });
    taskRepo.create({ id: 'TASK-2', title: 'Task 2' });

    // Gán task vào feature
    featureRepo.assignTasks('FEAT-CORE', ['TASK-1', 'TASK-2']);
    expect(taskRepo.findById('TASK-1')?.feature_id).toBe('FEAT-CORE');
    expect(taskRepo.findById('TASK-2')?.feature_id).toBe('FEAT-CORE');

    // Gỡ 1 task khỏi feature
    featureRepo.unassignTasks('FEAT-CORE', ['TASK-1']);
    expect(taskRepo.findById('TASK-1')?.feature_id).toBeNull();
    expect(taskRepo.findById('TASK-2')?.feature_id).toBe('FEAT-CORE');
  });
});
