import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AppError } from '@ai-orchestrator/shared';
import { createRepositoryRegistry } from '../adapters/repository-registry.js';

describe('RepositoryRegistry (AGY-006: kiểm tra cwd thuộc repo đã đăng ký)', () => {
  let tempDir: string;
  let repoA: string;
  let repoB: string;
  let outsideDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-registry-test-'));
    repoA = path.join(tempDir, 'repo-a');
    repoB = path.join(tempDir, 'repo-b');
    outsideDir = path.join(tempDir, 'outside');

    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    // Create subdirectories and files
    fs.mkdirSync(path.join(repoA, 'src', 'components'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Repository Registration & Lifecycle', () => {
    it('registers valid directories and returns registered repository info', () => {
      const registry = createRepositoryRegistry();
      const registered = registry.register(repoA, { name: 'Repo A' });

      expect(registered.id).toBeDefined();
      expect(registered.name).toBe('Repo A');
      expect(registered.path).toBe(fs.realpathSync(repoA));
      expect(registered.isDefault).toBe(true);

      const list = registry.list();
      expect(list.length).toBe(1);
      expect(list[0]?.path).toBe(fs.realpathSync(repoA));
    });

    it('rejects registration when path is empty or invalid string', () => {
      const registry = createRepositoryRegistry();
      expect(() => registry.register('')).toThrow(AppError);
      expect(() => registry.register('   ')).toThrow(AppError);
    });

    it('rejects registration when path does not exist', () => {
      const registry = createRepositoryRegistry();
      const nonExistent = path.join(tempDir, 'ghost-repo');
      expect(() => registry.register(nonExistent)).toThrow(AppError);
      try {
        registry.register(nonExistent);
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('PATH_NOT_FOUND');
      }
    });

    it('rejects registration when path is a file instead of a directory', () => {
      const registry = createRepositoryRegistry();
      const filePath = path.join(tempDir, 'file.txt');
      fs.writeFileSync(filePath, 'hello');

      expect(() => registry.register(filePath)).toThrow(AppError);
      try {
        registry.register(filePath);
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('NOT_A_DIRECTORY');
      }
    });

    it('supports unregistering repositories and managing default repo', () => {
      const registry = createRepositoryRegistry();
      const r1 = registry.register(repoA);
      const r2 = registry.register(repoB);

      expect(registry.list().length).toBe(2);
      expect(registry.getDefault()?.id).toBe(r1.id);

      const removed = registry.unregister(r1.id);
      expect(removed).toBe(true);
      expect(registry.list().length).toBe(1);
      expect(registry.getDefault()?.id).toBe(r2.id);

      registry.clear();
      expect(registry.list().length).toBe(0);
      expect(registry.getDefault()).toBeUndefined();
    });
  });

  describe('Cwd Validation (Cwd sai bị từ chối)', () => {
    it('accepts exact registered repository root path', () => {
      const registry = createRepositoryRegistry();
      registry.register(repoA);

      const res = registry.validateCwd(repoA);
      expect(res.valid).toBe(true);
      expect(res.canonicalPath).toBe(fs.realpathSync(repoA));
      expect(res.isWorktree).toBe(false);

      expect(() => registry.assertCwdValid(repoA)).not.toThrow();
    });

    it('accepts valid nested subdirectory within registered repository', () => {
      const registry = createRepositoryRegistry();
      registry.register(repoA);

      const subDir = path.join(repoA, 'src', 'components');
      const res = registry.validateCwd(subDir);
      expect(res.valid).toBe(true);
      expect(res.canonicalPath).toBe(fs.realpathSync(subDir));

      expect(() => registry.assertCwdValid(subDir)).not.toThrow();
    });

    it('rejects cwd that belongs to an unregistered directory ("Cwd sai bị từ chối")', () => {
      const registry = createRepositoryRegistry();
      registry.register(repoA);

      const res = registry.validateCwd(outsideDir);
      expect(res.valid).toBe(false);
      expect(res.reason).toContain('does not belong to any registered repository');

      expect(() => registry.assertCwdValid(outsideDir)).toThrow(AppError);
      try {
        registry.assertCwdValid(outsideDir);
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('UNREGISTERED_REPOSITORY');
      }
    });

    it('rejects path traversal attempts outside registered repository', () => {
      const registry = createRepositoryRegistry();
      registry.register(repoA);

      // Traversal using .. to reach outsideDir
      const traversalDir = path.join(repoA, '..', 'outside');
      const res = registry.validateCwd(traversalDir);
      expect(res.valid).toBe(false);

      expect(() => registry.assertCwdValid(traversalDir)).toThrow(AppError);
    });

    it('rejects cwd when directory does not exist', () => {
      const registry = createRepositoryRegistry();
      registry.register(repoA);

      const ghostDir = path.join(repoA, 'non_existent_subdir');
      const res = registry.validateCwd(ghostDir);
      expect(res.valid).toBe(false);

      expect(() => registry.assertCwdValid(ghostDir)).toThrow(AppError);
      try {
        registry.assertCwdValid(ghostDir);
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('INVALID_WORKING_DIRECTORY');
      }
    });

    it('rejects symlinks that point outside the registered repository root', () => {
      const registry = createRepositoryRegistry();
      registry.register(repoA);

      const symlinkPath = path.join(repoA, 'link_to_outside');
      try {
        fs.symlinkSync(outsideDir, symlinkPath, 'dir');
      } catch {
        // Skip if symlink permission not available
        return;
      }

      const res = registry.validateCwd(symlinkPath);
      expect(res.valid).toBe(false);
      expect(() => registry.assertCwdValid(symlinkPath)).toThrow(AppError);
    });

    it('accepts authorized isolated worktree registered for a repository', () => {
      const registry = createRepositoryRegistry();
      registry.register(repoA);

      const worktreeDir = path.join(tempDir, 'wt-task-123');
      fs.mkdirSync(worktreeDir, { recursive: true });

      // Before registration: rejected
      expect(registry.validateCwd(worktreeDir).valid).toBe(false);

      // Register worktree
      registry.registerWorktree(worktreeDir, repoA);

      // After registration: accepted
      const res = registry.validateCwd(worktreeDir);
      expect(res.valid).toBe(true);
      expect(res.isWorktree).toBe(true);
      expect(res.repo?.path).toBe(fs.realpathSync(repoA));

      expect(() => registry.assertCwdValid(worktreeDir)).not.toThrow();

      // Unregister worktree: rejected again
      registry.unregisterWorktree(worktreeDir);
      expect(registry.validateCwd(worktreeDir).valid).toBe(false);
    });
  });
});
