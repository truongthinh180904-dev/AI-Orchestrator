import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AppError,
  checkRepoClean,
  getRepoStatus,
  isRepoClean,
} from '../packages/shared/src/index.js';
import {
  checkRepoClean as orchCheckRepoClean,
  getRepoStatus as orchGetRepoStatus,
} from '../apps/orchestrator/src/index.js';

describe('FND-006: Hàm checkRepoClean(path) dùng git status --porcelain', () => {
  let tmpRepo: string;

  beforeEach(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'fnd006-repo-'));
    execSync('git init -b main', { cwd: tmpRepo, stdio: 'ignore' });
    execSync('git config user.email "orchestrator@example.com"', { cwd: tmpRepo, stdio: 'ignore' });
    execSync('git config user.name "AI Orchestrator"', { cwd: tmpRepo, stdio: 'ignore' });
  });

  afterEach(() => {
    if (fs.existsSync(tmpRepo)) {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  describe('Nghiệm thu: Repo bẩn → trả lỗi, không ghi đè', () => {
    it('Repo bẩn do untracked file → trả lỗi REPO_DIRTY', async () => {
      // Create untracked file
      fs.writeFileSync(path.join(tmpRepo, 'untracked-file.txt'), 'content');

      let error: AppError | undefined;
      try {
        await checkRepoClean(tmpRepo);
      } catch (err) {
        if (err instanceof AppError) error = err;
      }

      expect(error).toBeDefined();
      expect(error?.code).toBe('REPO_DIRTY');
      expect(error?.message).toContain('uncommitted changes');
      expect(error?.message).toContain('untracked-file.txt');
      expect(error?.context['dirtyCount']).toBe(1);
    });

    it('Repo bẩn do modified file (unstaged) → trả lỗi REPO_DIRTY', async () => {
      const filePath = path.join(tmpRepo, 'tracked.txt');
      fs.writeFileSync(filePath, 'original content');
      execSync('git add tracked.txt && git commit -m "initial commit"', {
        cwd: tmpRepo,
        stdio: 'ignore',
      });

      // Modify the file without committing
      fs.writeFileSync(filePath, 'modified uncommitted content');

      await expect(checkRepoClean(tmpRepo)).rejects.toMatchObject({
        code: 'REPO_DIRTY',
        message: expect.stringContaining('tracked.txt'),
      });
    });

    it('Repo bẩn do staged change chưa commit → trả lỗi REPO_DIRTY', async () => {
      const filePath = path.join(tmpRepo, 'staged.txt');
      fs.writeFileSync(filePath, 'original content');
      execSync('git add staged.txt && git commit -m "initial commit"', {
        cwd: tmpRepo,
        stdio: 'ignore',
      });

      fs.writeFileSync(filePath, 'staged content');
      execSync('git add staged.txt', { cwd: tmpRepo, stdio: 'ignore' });

      await expect(checkRepoClean(tmpRepo)).rejects.toMatchObject({
        code: 'REPO_DIRTY',
        message: expect.stringContaining('staged.txt'),
      });
    });

    it('Repo bẩn do xóa file chưa commit → trả lỗi REPO_DIRTY', async () => {
      const filePath = path.join(tmpRepo, 'to-delete.txt');
      fs.writeFileSync(filePath, 'file content');
      execSync('git add to-delete.txt && git commit -m "add file"', {
        cwd: tmpRepo,
        stdio: 'ignore',
      });

      fs.unlinkSync(filePath);

      await expect(checkRepoClean(tmpRepo)).rejects.toMatchObject({
        code: 'REPO_DIRTY',
        message: expect.stringContaining('to-delete.txt'),
      });
    });

    it('Không ghi đè: khi repo bẩn, thao tác bảo vệ bởi checkRepoClean bị chặn, không ghi đè file', async () => {
      const existingFile = path.join(tmpRepo, 'important-data.txt');
      const originalContent = 'DO NOT OVERWRITE THIS EXISTING WORK';
      fs.writeFileSync(existingFile, originalContent);
      execSync('git add important-data.txt && git commit -m "base"', {
        cwd: tmpRepo,
        stdio: 'ignore',
      });

      // Tạo thay đổi chưa commit làm repo bẩn
      fs.writeFileSync(path.join(tmpRepo, 'dirty-untracked.txt'), 'some dirty changes');

      // Mô phỏng hàm ghi file được bảo vệ bởi checkRepoClean
      async function safeOverwriteOrWrite(repoDir: string, targetFile: string, newContent: string) {
        await checkRepoClean(repoDir);
        fs.writeFileSync(targetFile, newContent);
      }

      // Thao tác phải bị reject
      await expect(
        safeOverwriteOrWrite(tmpRepo, existingFile, 'NEW OVERWRITING CONTENT'),
      ).rejects.toThrowError(AppError);

      // Xác nhận nội dung gốc KHÔNG bị ghi đè
      const currentContent = fs.readFileSync(existingFile, 'utf-8');
      expect(currentContent).toBe(originalContent);
    });

    it('Repo sạch → checkRepoClean thành công, cho phép thao tác an toàn', async () => {
      const sampleFile = path.join(tmpRepo, 'file.txt');
      fs.writeFileSync(sampleFile, 'initial');
      execSync('git add file.txt && git commit -m "init"', { cwd: tmpRepo, stdio: 'ignore' });

      // Clean repo should pass
      const result = await checkRepoClean(tmpRepo);
      expect(result.isClean).toBe(true);
      expect(result.files).toHaveLength(0);

      const status = await getRepoStatus(tmpRepo);
      expect(status.isClean).toBe(true);
      expect(status.files).toHaveLength(0);

      const isClean = await isRepoClean(tmpRepo);
      expect(isClean).toBe(true);
    });

    it('Hoạt động đồng bộ qua export từ orchestrator adapters', async () => {
      fs.writeFileSync(path.join(tmpRepo, 'dirty.txt'), 'dirty');

      await expect(orchCheckRepoClean(tmpRepo)).rejects.toMatchObject({
        code: 'REPO_DIRTY',
      });

      const status = await orchGetRepoStatus(tmpRepo);
      expect(status.isClean).toBe(false);
      expect(status.files.length).toBe(1);
      expect(status.files[0]?.path).toBe('dirty.txt');
    });
  });
});
