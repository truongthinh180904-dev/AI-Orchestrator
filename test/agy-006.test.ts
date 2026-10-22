import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runGitCommand } from '../packages/shared/src/index.js';
import {
  AppError,
  RepositoryRegistry,
  createRepositoryRegistry,
  WorktreeManager,
  createWorktreeManager,
  ProcessAdapter,
  ExecutionManager,
} from '../apps/orchestrator/src/index.js';

describe('AGY-006 Nghiệm thu: Chạy trong working dir/worktree cô lập, kiểm tra cwd thuộc repo đã đăng ký — Cwd sai bị từ chối', () => {
  let tempDir: string;
  let repoPath: string;
  let outsidePath: string;
  let registry: RepositoryRegistry;
  let worktreeManager: WorktreeManager;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-006-acc-'));
    repoPath = path.join(tempDir, 'registered-repo');
    outsidePath = path.join(tempDir, 'unregistered-outside');

    fs.mkdirSync(repoPath, { recursive: true });
    fs.mkdirSync(outsidePath, { recursive: true });

    // Initialize real git repo
    await runGitCommand(['init', '-b', 'main'], repoPath);
    await runGitCommand(['config', 'user.email', 'orchestrator@example.com'], repoPath);
    await runGitCommand(['config', 'user.name', 'AI Orchestrator'], repoPath);

    // Initial commit
    fs.writeFileSync(path.join(repoPath, 'initial.txt'), 'Initial commit content\n');
    await runGitCommand(['add', '.'], repoPath);
    await runGitCommand(['commit', '-m', 'Initial baseline commit'], repoPath);

    // Subdirectory inside repo
    fs.mkdirSync(path.join(repoPath, 'packages', 'core'), { recursive: true });

    // Registry setup
    registry = createRepositoryRegistry();
    registry.register(repoPath, { name: 'Registered Repository' });

    worktreeManager = createWorktreeManager({ repositoryRegistry: registry });
  });

  afterEach(async () => {
    try {
      await worktreeManager.pruneWorktrees(repoPath);
    } catch {
      // Ignored
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Tiêu chí nghiệm thu 1: Cwd sai bị từ chối', () => {
    it('1.1: Cwd không thuộc repo đã đăng ký bị từ chối ngay lập tức với lỗi UNREGISTERED_REPOSITORY', () => {
      const result = registry.validateCwd(outsidePath);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('does not belong to any registered repository');

      expect(() => registry.assertCwdValid(outsidePath)).toThrow(AppError);
      try {
        registry.assertCwdValid(outsidePath);
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('UNREGISTERED_REPOSITORY');
      }
    });

    it('1.2: Cwd trỏ tới đường dẫn không tồn tại bị từ chối với lỗi INVALID_WORKING_DIRECTORY', () => {
      const nonExistentPath = path.join(repoPath, 'does-not-exist-dir');

      const result = registry.validateCwd(nonExistentPath);
      expect(result.valid).toBe(false);

      expect(() => registry.assertCwdValid(nonExistentPath)).toThrow(AppError);
      try {
        registry.assertCwdValid(nonExistentPath);
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('INVALID_WORKING_DIRECTORY');
      }
    });

    it('1.3: Cwd trỏ tới file (không phải thư mục) bị từ chối với lỗi INVALID_WORKING_DIRECTORY', () => {
      const filePath = path.join(repoPath, 'initial.txt');

      const result = registry.validateCwd(filePath);
      expect(result.valid).toBe(false);

      expect(() => registry.assertCwdValid(filePath)).toThrow(AppError);
      try {
        registry.assertCwdValid(filePath);
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('INVALID_WORKING_DIRECTORY');
      }
    });

    it('1.4: Cwd cố tình path traversal (../) ra ngoài repo đã đăng ký bị từ chối', () => {
      const traversalPath = path.join(repoPath, '..', 'unregistered-outside');

      const result = registry.validateCwd(traversalPath);
      expect(result.valid).toBe(false);

      expect(() => registry.assertCwdValid(traversalPath)).toThrow(AppError);
      try {
        registry.assertCwdValid(traversalPath);
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('UNREGISTERED_REPOSITORY');
      }
    });

    it('1.5: Cwd dùng symlink trỏ ra ngoài repo đã đăng ký bị từ chối', () => {
      const symlinkPath = path.join(repoPath, 'escape-symlink');
      try {
        fs.symlinkSync(outsidePath, symlinkPath, 'dir');
      } catch {
        return; // Skip if symlinks not supported on OS
      }

      const result = registry.validateCwd(symlinkPath);
      expect(result.valid).toBe(false);
      expect(() => registry.assertCwdValid(symlinkPath)).toThrow(AppError);
    });

    it('1.6: ProcessAdapter khi cấu hình repositoryRegistry từ chối spawn process với Cwd sai', () => {
      const adapter = new ProcessAdapter({ repositoryRegistry: registry });

      expect(() => {
        adapter.spawn({
          exe: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: outsidePath,
        });
      }).toThrow(AppError);

      try {
        adapter.spawn({
          exe: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: outsidePath,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('UNREGISTERED_REPOSITORY');
      }
    });

    it('1.7: ExecutionManager khi startRun() từ chối khởi chạy process với Cwd sai', () => {
      const manager = new ExecutionManager({ repositoryRegistry: registry });

      expect(() => {
        manager.startRun({
          runId: 'run-invalid-cwd',
          command: {
            exe: process.execPath,
            args: ['-e', 'process.exit(0)'],
            cwd: outsidePath,
          },
        });
      }).toThrow(AppError);

      try {
        manager.startRun({
          runId: 'run-invalid-cwd',
          command: {
            exe: process.execPath,
            args: ['-e', 'process.exit(0)'],
            cwd: outsidePath,
          },
        });
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('UNREGISTERED_REPOSITORY');
      }
    });
  });

  describe('Tiêu chí nghiệm thu 2: Chạy trong working dir/worktree cô lập', () => {
    it('2.1: Chạy trong repo root hoặc thư mục con hợp lệ của repo đã đăng ký thành công', async () => {
      const adapter = new ProcessAdapter({ repositoryRegistry: registry });
      const subDir = path.join(repoPath, 'packages', 'core');

      const handle = adapter.spawn({
        exe: process.execPath,
        args: ['-e', 'console.log("inside valid cwd")'],
        cwd: subDir,
      });

      const exitResult = await handle.waitForExit();
      expect(exitResult.exitCode).toBe(0);
    });

    it('2.2: Tạo worktree cô lập từ repo đã đăng ký, worktree được tự động cấp quyền cwd', async () => {
      const wtDir = path.join(tempDir, 'wt-AGY-006-acc');

      const wt = await worktreeManager.createIsolatedWorktree({
        repoPath,
        taskId: 'AGY-006',
        worktreeDir: wtDir,
      });

      expect(fs.existsSync(wtDir)).toBe(true);
      expect(wt.branch).toBe('agy/AGY-006');

      // Verify worktree is recognized as authorized working directory
      const validation = registry.validateCwd(wtDir);
      expect(validation.valid).toBe(true);
      expect(validation.isWorktree).toBe(true);
      expect(() => registry.assertCwdValid(wtDir)).not.toThrow();
    });

    it('2.3: ProcessAdapter thực thi thành công tiến trình con bên trong worktree cô lập', async () => {
      const wtDir = path.join(tempDir, 'wt-EXEC-acc');

      const wt = await worktreeManager.createIsolatedWorktree({
        repoPath,
        taskId: 'EXEC-ACC',
        worktreeDir: wtDir,
      });

      const adapter = new ProcessAdapter({ repositoryRegistry: registry });

      const handle = adapter.spawn({
        exe: process.execPath,
        args: ['-e', 'console.log("executed in worktree")'],
        cwd: wt.worktreePath,
      });

      const exitResult = await handle.waitForExit();
      expect(exitResult.exitCode).toBe(0);
    });

    it('2.4: ExecutionManager startRun() thành công với worktree cô lập', async () => {
      const wtDir = path.join(tempDir, 'wt-ORCH-acc');

      const wt = await worktreeManager.createIsolatedWorktree({
        repoPath,
        taskId: 'ORCH-ACC',
        worktreeDir: wtDir,
      });

      const manager = new ExecutionManager({ repositoryRegistry: registry });

      const execution = manager.startRun({
        runId: 'run-worktree-acc',
        taskId: 'ORCH-ACC',
        worktree: wt,
        command: {
          exe: process.execPath,
          args: ['-e', 'console.log("run via execution manager in worktree")'],
          cwd: wt.worktreePath,
        },
      });

      const exitResult = await execution.waitForCompletion();
      expect(exitResult.exitCode).toBe(0);
    });

    it('2.5: Thay đổi file trong worktree cô lập không làm bẩn repo gốc', async () => {
      const wtDir = path.join(tempDir, 'wt-DIRTY-acc');

      const wt = await worktreeManager.createIsolatedWorktree({
        repoPath,
        taskId: 'DIRTY-ACC',
        worktreeDir: wtDir,
      });

      // Write a new file inside worktree
      fs.writeFileSync(
        path.join(wt.worktreePath, 'new-worktree-feature.ts'),
        'export const x = 1;\n',
      );

      // Check that the file does NOT exist in the original repo
      expect(fs.existsSync(path.join(repoPath, 'new-worktree-feature.ts'))).toBe(false);

      // Verify original repo git status remains completely clean
      const gitStatus = await runGitCommand(['status', '--porcelain'], repoPath);
      expect(gitStatus.stdout.trim()).toBe('');
    });

    it('2.6: Dọn dẹp worktree cô lập sạch sẽ và thu hồi quyền cwd', async () => {
      const wtDir = path.join(tempDir, 'wt-CLEANUP-acc');

      const wt = await worktreeManager.createIsolatedWorktree({
        repoPath,
        taskId: 'CLEANUP-ACC',
        worktreeDir: wtDir,
      });

      expect(fs.existsSync(wtDir)).toBe(true);
      expect(registry.validateCwd(wtDir).valid).toBe(true);

      // Remove worktree
      await wt.remove({ force: true });

      // Verify worktree folder removed
      expect(fs.existsSync(wtDir)).toBe(false);

      // Verify cwd permissions revoked
      expect(registry.validateCwd(wtDir).valid).toBe(false);
      expect(() => registry.assertCwdValid(wtDir)).toThrow(AppError);
    });
  });
});
