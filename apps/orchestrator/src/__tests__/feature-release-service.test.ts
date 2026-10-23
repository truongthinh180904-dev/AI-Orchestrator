import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  FeatureRepository,
  TaskRepository,
} from '@ai-orchestrator/db';
import { FeatureReleaseService } from '../services/feature-release-service.js';
import { AppError } from '@ai-orchestrator/shared';

describe('FeatureReleaseService', () => {
  let db: Database.Database;
  let featureRepo: FeatureRepository;
  let taskRepo: TaskRepository;
  let releaseService: FeatureReleaseService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    featureRepo = new FeatureRepository(db);
    taskRepo = new TaskRepository(db);
    releaseService = new FeatureReleaseService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('Xác định feature và tập task bắt buộc: sắp xếp topo, phân định is_required', () => {
    featureRepo.create({
      id: 'FEAT-001',
      name: 'User Management',
      required_tasks: ['TASK-A', 'TASK-B'],
      integration_tests: ['pnpm test:user'],
    });

    // TASK-A -> TASK-B (TASK-B phụ thuộc TASK-A)
    taskRepo.create({
      id: 'TASK-A',
      feature_id: 'FEAT-001',
      title: 'Database migration',
      status: 'DONE',
      priority: 5,
    });

    taskRepo.create({
      id: 'TASK-B',
      feature_id: 'FEAT-001',
      title: 'User API service',
      status: 'DONE',
      dependencies: ['TASK-A'],
      priority: 10,
    });

    taskRepo.create({
      id: 'TASK-C',
      feature_id: 'FEAT-001',
      title: 'Optional user avatar widget',
      status: 'DONE',
      priority: 1,
    });

    const manifest = releaseService.getComponentTasks('FEAT-001');

    expect(manifest.feature_id).toBe('FEAT-001');
    expect(manifest.feature_name).toBe('User Management');
    expect(manifest.tasks).toHaveLength(3);

    // Kiểm tra thứ tự thực thi: TASK-A phải trước TASK-B do TASK-B phụ thuộc TASK-A
    const taskA = manifest.tasks.find((t) => t.id === 'TASK-A')!;
    const taskB = manifest.tasks.find((t) => t.id === 'TASK-B')!;
    const taskC = manifest.tasks.find((t) => t.id === 'TASK-C')!;

    expect(taskA.execution_order).toBeLessThan(taskB.execution_order);
    expect(taskA.is_required).toBe(true);
    expect(taskB.is_required).toBe(true);
    expect(taskC.is_required).toBe(false);

    expect(manifest.summary.total_tasks).toBe(3);
    expect(manifest.summary.required_count).toBe(2);
    expect(manifest.summary.completed_count).toBe(3);
    expect(manifest.summary.missing_count).toBe(0);
    expect(manifest.summary.is_all_required_done).toBe(true);
    expect(manifest.summary.ready_for_release).toBe(true);
  });

  it('Phát hiện task bị thiếu trong missing_task_ids khi khai báo required_tasks không tồn tại', () => {
    featureRepo.create({
      id: 'FEAT-MISSING',
      name: 'Feature with missing tasks',
      required_tasks: ['EXISTS-1', 'GHOST-TASK-999'],
    });

    taskRepo.create({
      id: 'EXISTS-1',
      feature_id: 'FEAT-MISSING',
      title: 'Existing task',
      status: 'DONE',
    });

    const manifest = releaseService.getComponentTasks('FEAT-MISSING');

    expect(manifest.missing_task_ids).toEqual(['GHOST-TASK-999']);
    expect(manifest.summary.missing_count).toBe(1);
    expect(manifest.summary.required_count).toBe(2);
    expect(manifest.summary.is_all_required_done).toBe(false);
    expect(manifest.summary.ready_for_release).toBe(false);
  });

  it('Chặn ready_for_release nếu có task bắt buộc chưa DONE (ví dụ: IN_PROGRESS hoặc FAILED)', () => {
    featureRepo.create({
      id: 'FEAT-PENDING',
      name: 'Pending feature',
      required_tasks: ['REQ-1', 'REQ-2'],
    });

    taskRepo.create({
      id: 'REQ-1',
      feature_id: 'FEAT-PENDING',
      title: 'First task',
      status: 'DONE',
    });

    taskRepo.create({
      id: 'REQ-2',
      feature_id: 'FEAT-PENDING',
      title: 'Second task',
      status: 'RUNNING',
    });

    const manifest = releaseService.getComponentTasks('FEAT-PENDING');

    expect(manifest.summary.completed_count).toBe(1);
    expect(manifest.summary.pending_count).toBe(1);
    expect(manifest.summary.is_all_required_done).toBe(false);
    expect(manifest.summary.ready_for_release).toBe(false);
  });

  it('defineFeatureTasks cập nhật required_tasks và gán task thành công', () => {
    featureRepo.create({
      id: 'FEAT-UPDATE',
      name: 'Updatable feature',
      required_tasks: ['TASK-INIT'],
    });

    taskRepo.create({ id: 'TASK-INIT', title: 'Init', status: 'DONE' });
    taskRepo.create({ id: 'TASK-NEW', title: 'New task', status: 'DONE' });

    const updated = releaseService.defineFeatureTasks('FEAT-UPDATE', {
      required_tasks: ['TASK-INIT', 'TASK-NEW'],
      assign_task_ids: ['TASK-NEW'],
    });

    expect(updated.required_task_ids).toEqual(['TASK-INIT', 'TASK-NEW']);
    expect(updated.summary.total_tasks).toBe(2);
    expect(updated.summary.required_count).toBe(2);
    expect(updated.summary.is_all_required_done).toBe(true);
    expect(updated.summary.ready_for_release).toBe(true);

    const taskNew = taskRepo.findById('TASK-NEW');
    expect(taskNew?.feature_id).toBe('FEAT-UPDATE');
  });

  it('Ném AppError(FEATURE_NOT_FOUND) khi feature không tồn tại', () => {
    expect(() => releaseService.getComponentTasks('NOT-FOUND')).toThrowError(AppError);
    expect(() => releaseService.defineFeatureTasks('NOT-FOUND', {})).toThrowError(AppError);
  });
});
