import type Database from 'better-sqlite3';
import { FeatureRepository } from '@ai-orchestrator/db';
import {
  AppError,
  type Feature,
  type FeatureFilter,
  type UpdateFeatureInput,
  type FeatureComponentTasksResult,
  type DefineFeatureTasksInput,
  type FeatureReleaseCheckResult,
  type CheckReleaseReadinessInput,
  type FeatureIntegrationTestRecord,
  type CreateFeatureBranchInput,
  type CreateFeatureBranchResult,
  type FeatureBranchInfo,
  type CommitFeatureReleaseInput,
  type CommitFeatureReleaseResult,
  type FeatureRelease,
} from '@ai-orchestrator/shared';
import { FeatureReleaseService, type FeatureReleaseServiceOptions } from './feature-release-service.js';

export interface FeatureServiceOptions extends FeatureReleaseServiceOptions {
  releaseService?: FeatureReleaseService;
}

export class FeatureService {
  private readonly featureRepo: FeatureRepository;
  private readonly releaseService: FeatureReleaseService;

  constructor(db: Database.Database, options?: FeatureServiceOptions) {
    this.featureRepo = new FeatureRepository(db);
    this.releaseService = options?.releaseService ?? new FeatureReleaseService(db, options);
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

  /**
   * Kiểm tra điều kiện release của feature: đủ task bắt buộc, Quality Gate pass, integration test pass.
   */
  async checkReleaseReadiness(
    id: string,
    options?: CheckReleaseReadinessInput,
  ): Promise<FeatureReleaseCheckResult> {
    return this.releaseService.checkReleaseReadiness(id, options);
  }

  /**
   * Khẳng định tính sẵn sàng phát hành của feature (ném lỗi nếu bị chặn).
   */
  async assertCanRelease(
    id: string,
    options?: CheckReleaseReadinessInput,
  ): Promise<FeatureReleaseCheckResult> {
    return this.releaseService.assertCanRelease(id, options);
  }

  /**
   * Chạy các lệnh kiểm thử tích hợp (integration tests) cho feature.
   */
  async runIntegrationTests(
    id: string,
    options?: { repoPath?: string; timeoutMs?: number; saveReport?: boolean },
  ): Promise<FeatureIntegrationTestRecord[]> {
    return this.releaseService.runIntegrationTests(id, options);
  }

  /**
   * Tạo branch feature an toàn (không ghi đè) - REL-003.
   */
  async createFeatureBranch(
    id: string,
    options?: CreateFeatureBranchInput,
  ): Promise<CreateFeatureBranchResult> {
    return this.releaseService.createFeatureBranch(id, options);
  }

  /**
   * Lấy thông tin branch feature.
   */
  async getFeatureBranchInfo(
    id: string,
    repoPath?: string,
  ): Promise<FeatureBranchInfo | null> {
    return this.releaseService.getFeatureBranchInfo(id, repoPath);
  }

  /**
   * Tạo commit chuẩn hóa cho feature release và lưu SHA vào DB (REL-004).
   */
  async commitFeatureRelease(
    id: string,
    input?: CommitFeatureReleaseInput,
  ): Promise<CommitFeatureReleaseResult> {
    return this.releaseService.commitFeatureRelease(id, input);
  }

  /**
   * Lấy thông tin release của feature từ DB.
   */
  getFeatureRelease(id: string): FeatureRelease | null {
    return this.releaseService.getFeatureRelease(id);
  }
}


