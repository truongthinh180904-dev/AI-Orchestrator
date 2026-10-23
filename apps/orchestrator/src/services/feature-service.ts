import type Database from 'better-sqlite3';
import { FeatureRepository } from '@ai-orchestrator/db';
import {
  AppError,
  type Feature,
  type FeatureFilter,
  type UpdateFeatureInput,
  type FeatureComponentTasksResult,
  type DefineFeatureTasksInput,
} from '@ai-orchestrator/shared';
import { FeatureReleaseService } from './feature-release-service.js';

export class FeatureService {
  private readonly featureRepo: FeatureRepository;
  private readonly releaseService: FeatureReleaseService;

  constructor(db: Database.Database) {
    this.featureRepo = new FeatureRepository(db);
    this.releaseService = new FeatureReleaseService(db);
  }

  list(filter?: FeatureFilter): Feature[] {
    return this.featureRepo.findAll(filter);
  }

  getById(id: string): Feature {
    const feature = this.featureRepo.findById(id);
    if (!feature) {
      throw new AppError('FEATURE_NOT_FOUND', `Feature with id '${id}' not found`, {
        featureId: id,
      });
    }
    return feature;
  }

  update(id: string, input: UpdateFeatureInput): Feature {
    return this.featureRepo.update(id, input);
  }

  /**
   * Xác định feature và tập task bắt buộc (Danh sách task thành phần).
   */
  getComponentTasks(id: string): FeatureComponentTasksResult {
    return this.releaseService.getComponentTasks(id);
  }

  /**
   * Định nghĩa hoặc cập nhật tập task bắt buộc của feature.
   */
  defineFeatureTasks(id: string, input: DefineFeatureTasksInput): FeatureComponentTasksResult {
    return this.releaseService.defineFeatureTasks(id, input);
  }
}

