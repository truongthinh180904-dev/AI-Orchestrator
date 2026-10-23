import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import {
  checkRepoClean,
  getGitDiff,
  getRepoStatus,
  isRepoClean,
  parseGitPorcelain,
  validateGitBranchName,
  gitBranchExists,
  gitListBranches,
  gitGetCurrentBranch,
  gitGetRefCommit,
  gitCreateBranch,
} from '../git.js';


describe('git status & checkRepoClean unit tests', () => {
  describe('parseGitPorcelain', () => {
    it('returns empty array for empty output', () => {
      expect(parseGitPorcelain('')).toEqual([]);
      expect(parseGitPorcelain('\n\n')).toEqual([]);
    });

    it('parses various porcelain status lines correctly', () => {
      const output = [
        '?? untracked.txt',
        'M  staged-modified.txt',
        ' M unstaged-modified.txt',
        'MM staged-and-unstaged.txt',
        'D  staged-deleted.txt',
        ' D unstaged-deleted.txt',
        'A  added.txt',
        'R  old.txt -> new.txt',
      ].join('\n');

      const result = parseGitPorcelain(output);
      expect(result).toHaveLength(8);

      expect(result[0]).toEqual({
        indexStatus: '?',
        workTreeStatus: '?',
        path: 'untracked.txt',
        origPath: undefined,
        raw: '?? untracked.txt',
      });

      expect(result[1]?.path).toBe('staged-modified.txt');
      expect(result[1]?.indexStatus).toBe('M');
      expect(result[1]?.workTreeStatus).toBe(' ');

      expect(result[2]?.path).toBe('unstaged-modified.txt');
      expect(result[2]?.indexStatus).toBe(' ');
      expect(result[2]?.workTreeStatus).toBe('M');

      expect(result[7]?.path).toBe('new.txt');
      expect(result[7]?.origPath).toBe('old.txt');
      expect(result[7]?.indexStatus).toBe('R');
    });

    it('handles quoted filenames with spaces and renames', () => {
      const output = [
        '?? "path with spaces/file.txt"',
        'R  "old name with spaces.txt" -> "new name with spaces.txt"',
      ].join('\n');

      const result = parseGitPorcelain(output);
      expect(result).toHaveLength(2);
      expect(result[0]?.path).toBe('path with spaces/file.txt');
      expect(result[1]?.origPath).toBe('old name with spaces.txt');
      expect(result[1]?.path).toBe('new name with spaces.txt');
    });
  });

  describe('checkRepoClean with real temporary repositories', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-'));
    });

    afterEach(() => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('throws PATH_NOT_FOUND when directory does not exist', async () => {
      const nonExistent = path.join(tmpDir, 'does-not-exist');
      await expect(checkRepoClean(nonExistent)).rejects.toThrowError(AppError);
      await expect(checkRepoClean(nonExistent)).rejects.toMatchObject({
        code: 'PATH_NOT_FOUND',
      });
    });

    it('throws NOT_A_DIRECTORY when path points to a file', async () => {
      const filePath = path.join(tmpDir, 'somefile.txt');
      fs.writeFileSync(filePath, 'hello');
      await expect(checkRepoClean(filePath)).rejects.toMatchObject({
        code: 'NOT_A_DIRECTORY',
      });
    });

    it('throws NOT_A_GIT_REPO when directory is not a git repo', async () => {
      await expect(checkRepoClean(tmpDir)).rejects.toMatchObject({
        code: 'NOT_A_GIT_REPO',
      });
    });

    it('passes on an empty, clean git repository', async () => {
      execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
      const status = await checkRepoClean(tmpDir);
      expect(status.isClean).toBe(true);
      expect(status.files).toHaveLength(0);

      const isClean = await isRepoClean(tmpDir);
      expect(isClean).toBe(true);
    });

    it('passes on a git repository with committed files and no modifications', async () => {
      execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.name "Test User"', { cwd: tmpDir, stdio: 'ignore' });

      fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'content 1');
      execSync('git add hello.txt', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });

      const status = await checkRepoClean(tmpDir);
      expect(status.isClean).toBe(true);
      expect(status.files).toHaveLength(0);
      expect(await isRepoClean(tmpDir)).toBe(true);
    });

    it('throws REPO_DIRTY when untracked file exists', async () => {
      execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(tmpDir, 'untracked.txt'), 'untracked');

      await expect(checkRepoClean(tmpDir)).rejects.toMatchObject({
        code: 'REPO_DIRTY',
        context: {
          dirtyCount: 1,
        },
      });

      const cleanCheck = await isRepoClean(tmpDir);
      expect(cleanCheck).toBe(false);
    });

    it('throws REPO_DIRTY when tracked file has uncommitted changes', async () => {
      execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.name "Test User"', { cwd: tmpDir, stdio: 'ignore' });

      fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'initial');
      execSync('git add hello.txt && git commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });

      fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'modified');

      let caughtErr: AppError | undefined;
      try {
        await checkRepoClean(tmpDir);
      } catch (err) {
        if (err instanceof AppError) caughtErr = err;
      }

      expect(caughtErr).toBeDefined();
      expect(caughtErr?.code).toBe('REPO_DIRTY');
      expect(caughtErr?.message).toContain('hello.txt');
    });

    it('supports allowedFiles to ignore expected modifications', async () => {
      execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.name "Test User"', { cwd: tmpDir, stdio: 'ignore' });

      fs.writeFileSync(path.join(tmpDir, 'allowed.txt'), 'initial');
      fs.writeFileSync(path.join(tmpDir, 'forbidden.txt'), 'initial');
      execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });

      // Modify allowed file
      fs.writeFileSync(path.join(tmpDir, 'allowed.txt'), 'updated');

      const allowedStatus = await checkRepoClean(tmpDir, { allowedFiles: ['allowed.txt'] });
      expect(allowedStatus.isClean).toBe(true);

      // Now also modify forbidden file
      fs.writeFileSync(path.join(tmpDir, 'forbidden.txt'), 'updated');
      await expect(checkRepoClean(tmpDir, { allowedFiles: ['allowed.txt'] })).rejects.toMatchObject(
        {
          code: 'REPO_DIRTY',
          context: {
            dirtyCount: 1,
          },
        },
      );
    });

    it('supports ignoreUntracked option', async () => {
      execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(tmpDir, 'untracked.txt'), 'untracked');

      const status = await getRepoStatus(tmpDir, { ignoreUntracked: true });
      expect(status.isClean).toBe(true);

      const check = await checkRepoClean(tmpDir, { ignoreUntracked: true });
      expect(check.isClean).toBe(true);
    });
  });

  describe('getGitDiff', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-diff-test-'));
      execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.name "Test User"', { cwd: tmpDir, stdio: 'ignore' });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns empty diff for clean repository', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello');
      execSync('git add . && git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });

      const diff = await getGitDiff(tmpDir);
      expect(diff.changedFiles).toEqual([]);
      expect(diff.fileDiffs).toEqual([]);
      expect(diff.rawDiff).toBe('');
    });

    it('detects modified and untracked files', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'line 1\n');
      execSync('git add . && git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });

      // Modify existing file
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'line 1\nline 2\n');
      // Create untracked file
      fs.writeFileSync(path.join(tmpDir, 'untracked.ts'), 'export const secret = true;\n');

      const diff = await getGitDiff(tmpDir);
      expect(diff.changedFiles).toContain('file.txt');
      expect(diff.changedFiles).toContain('untracked.ts');
      expect(diff.changedFiles).toHaveLength(2);

      const modified = diff.fileDiffs.find((f) => f.path === 'file.txt');
      expect(modified).toBeDefined();
      expect(modified?.status).toBe('modified');

      const untracked = diff.fileDiffs.find((f) => f.path === 'untracked.ts');
      expect(untracked).toBeDefined();
      expect(untracked?.status).toBe('untracked');
    });

    it('supports includeUntracked: false', async () => {
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'line 1\n');
      execSync('git add . && git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });

      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'line 1\nmodified\n');
      fs.writeFileSync(path.join(tmpDir, 'untracked.ts'), 'content\n');

      const diff = await getGitDiff(tmpDir, { includeUntracked: false });
      expect(diff.changedFiles).toEqual(['file.txt']);
      expect(diff.fileDiffs).toHaveLength(1);
    });
  });

  describe('validateGitBranchName', () => {
    it('accepts valid branch names', () => {
      expect(() => validateGitBranchName('main')).not.toThrow();
      expect(() => validateGitBranchName('dev')).not.toThrow();
      expect(() => validateGitBranchName('feature/REL-003')).not.toThrow();
      expect(() => validateGitBranchName('agy/TSK-001-setup-db')).not.toThrow();
      expect(() => validateGitBranchName('feature/user_auth-v2.0')).not.toThrow();
    });

    it('rejects invalid branch names with AppError', () => {
      expect(() => validateGitBranchName('')).toThrow(AppError);
      expect(() => validateGitBranchName('   ')).toThrow(AppError);
      expect(() => validateGitBranchName('branch with space')).toThrow(AppError);
      expect(() => validateGitBranchName('/starts-with-slash')).toThrow(AppError);
      expect(() => validateGitBranchName('ends-with-slash/')).toThrow(AppError);
      expect(() => validateGitBranchName('has..double-dot')).toThrow(AppError);
      expect(() => validateGitBranchName('has//double-slash')).toThrow(AppError);
      expect(() => validateGitBranchName('ends-with.lock')).toThrow(AppError);
      expect(() => validateGitBranchName('has~tilde')).toThrow(AppError);
      expect(() => validateGitBranchName('has^caret')).toThrow(AppError);
      expect(() => validateGitBranchName('has:colon')).toThrow(AppError);
      expect(() => validateGitBranchName('has?question')).toThrow(AppError);
      expect(() => validateGitBranchName('has*star')).toThrow(AppError);
      expect(() => validateGitBranchName('has[bracket')).toThrow(AppError);
      expect(() => validateGitBranchName('has\\backslash')).toThrow(AppError);
      expect(() => validateGitBranchName('has@{brace')).toThrow(AppError);
      expect(() => validateGitBranchName('@')).toThrow(AppError);
    });
  });

  describe('gitCreateBranch & branch operations (REL-003)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-branch-test-'));
      execSync('git init -b main', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: tmpDir, stdio: 'ignore' });
      execSync('git config user.name "Test User"', { cwd: tmpDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Initial Repo\n');
      execSync('git add . && git commit -m "initial commit"', { cwd: tmpDir, stdio: 'ignore' });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates a new feature branch safely and returns metadata', async () => {
      const result = await gitCreateBranch(tmpDir, {
        branchName: 'feature/REL-003',
      });

      expect(result.branch).toBe('feature/REL-003');
      expect(result.baseBranch).toBe('main');
      expect(result.created).toBe(true);
      expect(result.commitSha).toHaveLength(40);

      // Verify branch exists in git
      const exists = await gitBranchExists(tmpDir, 'feature/REL-003');
      expect(exists).toBe(true);

      const branches = await gitListBranches(tmpDir);
      expect(branches).toContain('feature/REL-003');
      expect(branches).toContain('main');

      // Current branch should still be main (since checkout was not requested)
      const current = await gitGetCurrentBranch(tmpDir);
      expect(current).toBe('main');
    });

    it('switches to created branch when checkout: true is specified', async () => {
      const result = await gitCreateBranch(tmpDir, {
        branchName: 'feature/checkout-test',
        checkout: true,
      });

      expect(result.created).toBe(true);
      const current = await gitGetCurrentBranch(tmpDir);
      expect(current).toBe('feature/checkout-test');
    });

    it('fails with BRANCH_ALREADY_EXISTS when branch already exists (Branch trùng -> lỗi)', async () => {
      // Create first time
      await gitCreateBranch(tmpDir, {
        branchName: 'feature/duplicate',
      });

      // Try to create again -> must throw BRANCH_ALREADY_EXISTS
      await expect(
        gitCreateBranch(tmpDir, {
          branchName: 'feature/duplicate',
        }),
      ).rejects.toThrow(AppError);

      try {
        await gitCreateBranch(tmpDir, {
          branchName: 'feature/duplicate',
        });
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('BRANCH_ALREADY_EXISTS');
      }
    });

    it('rejects branch creation if working tree is dirty (requireClean: true)', async () => {
      // Make repo dirty
      fs.writeFileSync(path.join(tmpDir, 'dirty.txt'), 'uncommitted changes');

      await expect(
        gitCreateBranch(tmpDir, {
          branchName: 'feature/dirty-test',
          requireClean: true,
        }),
      ).rejects.toThrow(AppError);

      try {
        await gitCreateBranch(tmpDir, {
          branchName: 'feature/dirty-test',
          requireClean: true,
        });
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('REPO_DIRTY');
      }
    });

    it('rejects branch creation with invalid base branch (BASE_REF_NOT_FOUND)', async () => {
      await expect(
        gitCreateBranch(tmpDir, {
          branchName: 'feature/invalid-base',
          baseBranch: 'nonexistent-branch-123',
        }),
      ).rejects.toThrow(AppError);

      try {
        await gitCreateBranch(tmpDir, {
          branchName: 'feature/invalid-base',
          baseBranch: 'nonexistent-branch-123',
        });
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).code).toBe('BASE_REF_NOT_FOUND');
      }
    });

    it('resolves commit SHA with gitGetRefCommit', async () => {
      const sha = await gitGetRefCommit(tmpDir, 'main');
      expect(sha).not.toBeNull();
      expect(sha).toHaveLength(40);

      const invalidSha = await gitGetRefCommit(tmpDir, 'invalid-ref-xyz');
      expect(invalidSha).toBeNull();
    });
  });
});

