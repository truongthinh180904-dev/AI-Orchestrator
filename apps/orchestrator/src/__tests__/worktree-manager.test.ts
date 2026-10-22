import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AppError, runGitCommand } from '@ai-orchestrator/shared';
import { RepositoryRegistry, createRepositoryRegistry } from '../adapters/repository-registry.js';
import { WorktreeManager, createWorktreeManager } from '../adapters/worktree-manager.js';
import { ProcessAdapter } from '../adapters/process-adapter.js';

describe('WorktreeManager (AGY-006: Chạy trong working dir/worktree cô lập)', () => {
  let tempDir: string;
  let repoDir: string;
  let registry: RepositoryRegistry;
  let manager: WorktreeManager;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-mgr-test-'));
    repoDir = path.join(tempDir, 'main-repo');
    fs.mkdirSync(repoDir, { recursive: true });

    // Initialize real git repo in repoDir
    await runGitCommand(['init', '-b', 'main'], repoDir);
    await runGitCommand(['config', 'user.email', 'test@example.com'], repoDir);
    await runGitCommand(['config', 'user.name', 'Test User'], repoDir);

    // Create initial commit so HEAD exists
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Main Repo\n');
    await runGitCommand(['add', '.'], repoDir);
    await runGitCommand(['commit', '-m', 'Initial commit'], repoDir);

    registry = createRepositoryRegistry();
    registry.register(repoDir, { name: 'Main Repo' });
    manager = createWorktreeManager({ repositoryRegistry: registry });
  });

  afterEach(async () => {
    // Best effort prune / remove worktrees before deleting tempDir
    try {
      await manager.pruneWorktrees(repoDir);
    } catch {
      // Ignored
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates an isolated worktree for a task and registers it in the registry', async () => {
    const worktreeDir = path.join(tempDir, 'wt-TSK-001');

    const wt = await manager.createIsolatedWorktree({
      repoPath: repoDir,
      taskId: 'TSK-001',
      worktreeDir,
    });

    expect(wt.taskId).toBe('TSK-001');
    expect(wt.branch).toBe('agy/TSK-001');
    expect(fs.existsSync(worktreeDir)).toBe(true);

    // Verify cwd in worktree is validated and accepted by registry
    const validation = registry.validateCwd(worktreeDir);
    expect(validation.valid).toBe(true);
    expect(validation.isWorktree).toBe(true);
    expect(() => registry.assertCwdValid(worktreeDir)).not.toThrow();

    // Verify list worktrees includes the new worktree
    const list = await manager.listWorktrees(repoDir);
    expect(list.length).toBeGreaterThanOrEqual(2);
    const found = list.find((item) => item.path === fs.realpathSync(worktreeDir));
    expect(found).toBeDefined();
    expect(found?.branch).toBe('agy/TSK-001');
  });

  it('rejects worktree creation if repoPath is not registered', async () => {
    const unregisteredDir = path.join(tempDir, 'unregistered-repo');
    fs.mkdirSync(unregisteredDir, { recursive: true });

    await expect(
      manager.createIsolatedWorktree({
        repoPath: unregisteredDir,
        taskId: 'TSK-999',
      }),
    ).rejects.toThrow(AppError);

    try {
      await manager.createIsolatedWorktree({
        repoPath: unregisteredDir,
        taskId: 'TSK-999',
      });
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('UNREGISTERED_REPOSITORY');
    }
  });

  it('allows process execution safely within isolated worktree', async () => {
    const worktreeDir = path.join(tempDir, 'wt-EXEC-001');

    const wt = await manager.createIsolatedWorktree({
      repoPath: repoDir,
      taskId: 'EXEC-001',
      worktreeDir,
    });

    const adapter = new ProcessAdapter({
      repositoryRegistry: registry,
    });

    // Execute process in worktree directory: should succeed
    const handle = adapter.spawn({
      exe: process.execPath,
      args: ['-e', 'console.log(process.cwd())'],
      cwd: wt.worktreePath,
    });

    const exitResult = await handle.waitForExit();
    expect(exitResult.exitCode).toBe(0);

    // Execute process in an unregistered directory: should be rejected immediately!
    const ghostDir = path.join(tempDir, 'not-registered-cwd');
    fs.mkdirSync(ghostDir, { recursive: true });

    expect(() => {
      adapter.spawn({
        exe: process.execPath,
        args: ['-e', 'console.log("bad")'],
        cwd: ghostDir,
      });
    }).toThrow(AppError);

    try {
      adapter.spawn({
        exe: process.execPath,
        args: ['-e', 'console.log("bad")'],
        cwd: ghostDir,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('UNREGISTERED_REPOSITORY');
    }
  });

  it('modifications in isolated worktree do not taint the main repository', async () => {
    const worktreeDir = path.join(tempDir, 'wt-ISOLATION-001');

    const wt = await manager.createIsolatedWorktree({
      repoPath: repoDir,
      taskId: 'ISOLATION-001',
      worktreeDir,
    });

    // Modify a file in the worktree
    const wtFile = path.join(wt.worktreePath, 'task-file.txt');
    fs.writeFileSync(wtFile, 'worktree content\n');

    // Verify main repository working tree remains clean of that file
    const mainFile = path.join(repoDir, 'task-file.txt');
    expect(fs.existsSync(mainFile)).toBe(false);

    // Remove worktree
    await wt.remove({ force: true });

    // Verify worktree is removed and unregistered
    expect(fs.existsSync(worktreeDir)).toBe(false);
    expect(registry.validateCwd(worktreeDir).valid).toBe(false);
  });
});
