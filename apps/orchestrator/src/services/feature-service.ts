import type Database from 'better-sqlite3';
import { FeatureRepository } from '@ai-orchestrator/db';
import {
  AppError,
  type Feature,
  type FeatureFilter,
  type UpdateFeatureInput,
} from '@ai-orchestrator/shared';

export class FeatureService {
  private readonly featureRepo: FeatureRepository;

  constructor(db: Database.Database) {
    this.featureRepo = new FeatureRepository(db);
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
}
