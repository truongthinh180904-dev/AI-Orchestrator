import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import { checkRepoClean, getRepoStatus, isRepoClean, parseGitPorcelain } from '../git.js';

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
});
