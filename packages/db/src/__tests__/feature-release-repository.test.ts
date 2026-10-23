import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrator.js';
import { FeatureRepository } from '../repositories/feature-repository.js';
import { FeatureReleaseRepository } from '../repositories/feature-release-repository.js';
import { AppError } from '@ai-orchestrator/shared';

describe('FeatureReleaseRepository unit tests (REL-003)', () => {
  let db: Database.Database;
  let featureRepo: FeatureRepository;
  let releaseRepo: FeatureReleaseRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    featureRepo = new FeatureRepository(db);
    releaseRepo = new FeatureReleaseRepository(db);

    featureRepo.create({
      id: 'FEAT-AUTH',
      name: 'Authentication Module',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('tạo và truy vấn feature release thành công', () => {
    const release = releaseRepo.create({
      feature_id: 'FEAT-AUTH',
      branch: 'feature/FEAT-AUTH',
      base_branch: 'main',
      commit_sha: 'a'.repeat(40),
      status: 'BRANCH_CREATED',
      metadata: { env: 'test' },
    });

    expect(release.id).toBeDefined();
    expect(release.feature_id).toBe('FEAT-AUTH');
    expect(release.branch).toBe('feature/FEAT-AUTH');
    expect(release.base_branch).toBe('main');
    expect(release.commit_sha).toBe('a'.repeat(40));
    expect(release.status).toBe('BRANCH_CREATED');
    expect(release.metadata).toEqual({ env: 'test' });

    const foundById = releaseRepo.findById(release.id);
    expect(foundById).toEqual(release);

    const foundByFeature = releaseRepo.findByFeatureId('FEAT-AUTH');
    expect(foundByFeature).toEqual(release);

    const foundByBranch = releaseRepo.findByBranch('feature/FEAT-AUTH');
    expect(foundByBranch).toEqual(release);
  });

  it('báo lỗi BRANCH_ALREADY_EXISTS khi tạo release với branch đã tồn tại (Branch trùng -> lỗi)', () => {
    releaseRepo.create({
      feature_id: 'FEAT-AUTH',
      branch: 'feature/duplicate-branch',
      base_branch: 'main',
    });

    expect(() =>
      releaseRepo.create({
        feature_id: 'FEAT-AUTH',
        branch: 'feature/duplicate-branch',
        base_branch: 'main',
      }),
    ).toThrow(AppError);

    try {
      releaseRepo.create({
        feature_id: 'FEAT-AUTH',
        branch: 'feature/duplicate-branch',
        base_branch: 'main',
      });
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('BRANCH_ALREADY_EXISTS');
    }
  });

  it('cập nhật trạng thái và commit SHA của release', () => {
    const release = releaseRepo.create({
      feature_id: 'FEAT-AUTH',
      branch: 'feature/FEAT-AUTH',
      base_branch: 'main',
    });

    const updated = releaseRepo.update(release.id, {
      status: 'COMMITTED',
      commit_sha: 'b'.repeat(40),
      pr_url: 'https://github.com/org/repo/pull/1',
    });

    expect(updated.status).toBe('COMMITTED');
    expect(updated.commit_sha).toBe('b'.repeat(40));
    expect(updated.pr_url).toBe('https://github.com/org/repo/pull/1');
  });

  it('liệt kê và xóa release', () => {
    const r1 = releaseRepo.create({
      feature_id: 'FEAT-AUTH',
      branch: 'feature/branch-1',
      base_branch: 'main',
    });

    const list = releaseRepo.list({ feature_id: 'FEAT-AUTH' });
    expect(list.length).toBeGreaterThanOrEqual(1);

    const deleted = releaseRepo.delete(r1.id);
    expect(deleted).toBe(true);
    expect(releaseRepo.findById(r1.id)).toBeNull();
  });

  it('FeatureRepository.getRelease truy vấn release thành công', () => {
    releaseRepo.create({
      feature_id: 'FEAT-AUTH',
      branch: 'feature/FEAT-AUTH',
      base_branch: 'main',
    });

    const release = featureRepo.getRelease('FEAT-AUTH');
    expect(release).not.toBeNull();
    expect(release?.branch).toBe('feature/FEAT-AUTH');
  });
});
