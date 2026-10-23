import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import {
  gitPush,
  gitLsRemote,
  gitConfirmRemoteBranch,
  parseLsRemoteOutput,
  sanitizeGitOutput,
  classifyGitError,
} from '../git.js';

describe('git push & ls-remote unit tests (REL-005)', () => {
  let tmpRepoDir: string;
  let tmpRemoteDir: string;

  beforeEach(() => {
    // 1. Tạo bare remote repository
    tmpRemoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-remote-bare-'));
    execSync('git init --bare', { cwd: tmpRemoteDir, stdio: 'ignore' });

    // 2. Tạo local working repository
    tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-local-repo-'));
    execSync('git init -b main', { cwd: tmpRepoDir, stdio: 'ignore' });
    execSync('git config user.email "test@ai.local"', { cwd: tmpRepoDir, stdio: 'ignore' });
    execSync('git config user.name "AI Tester"', { cwd: tmpRepoDir, stdio: 'ignore' });

    // Commit khởi tạo
    fs.writeFileSync(path.join(tmpRepoDir, 'README.md'), '# Initial Repository\n');
    execSync('git add . && git commit -m "chore: initial commit"', {
      cwd: tmpRepoDir,
      stdio: 'ignore',
    });

    // Thêm remote 'origin' trỏ tới bare remote
    execSync(`git remote add origin "${tmpRemoteDir}"`, { cwd: tmpRepoDir, stdio: 'ignore' });
  });

  afterEach(() => {
    if (tmpRepoDir && fs.existsSync(tmpRepoDir)) {
      fs.rmSync(tmpRepoDir, { recursive: true, force: true });
    }
    if (tmpRemoteDir && fs.existsSync(tmpRemoteDir)) {
      fs.rmSync(tmpRemoteDir, { recursive: true, force: true });
    }
  });

  describe('sanitizeGitOutput', () => {
    it('redacts tokens and credentials from git error strings', () => {
      const withHttpAuth = 'fatal: unable to access "https://ghp_abcdef1234567890abcdef1234567890abcd@github.com/repo.git": 401';
      const sanitized = sanitizeGitOutput(withHttpAuth);
      expect(sanitized).not.toContain('ghp_abcdef1234567890abcdef1234567890abcd');
      expect(sanitized).toContain('[REDACTED_CREDENTIALS]@');

      const withBearer = 'remote: error: token ghp_012345678901234567890123456789012345 invalid';
      expect(sanitizeGitOutput(withBearer)).toContain('[REDACTED_TOKEN]');

      const withPassword = 'fatal: password=secret123 authentication failed';
      expect(sanitizeGitOutput(withPassword)).toContain('password=[REDACTED]');
    });
  });

  describe('parseLsRemoteOutput', () => {
    it('parses valid ls-remote lines correctly', () => {
      const sample = [
        'c7ab9b0000000000000000000000000000000001\trefs/heads/main',
        'a54d522000000000000000000000000000000002\trefs/heads/feature/REL-005',
      ].join('\n');

      const entries = parseLsRemoteOutput(sample);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        commitSha: 'c7ab9b0000000000000000000000000000000001',
        ref: 'refs/heads/main',
        branchName: 'main',
      });
      expect(entries[1]?.branchName).toBe('feature/REL-005');
    });

    it('returns empty array on empty output', () => {
      expect(parseLsRemoteOutput('')).toEqual([]);
      expect(parseLsRemoteOutput('   \n\n')).toEqual([]);
    });
  });

  describe('classifyGitError', () => {
    it('classifies authentication errors as GIT_AUTH_FAILED', () => {
      const err = classifyGitError('fatal: Authentication failed for remote repo', 128);
      expect(err.code).toBe('GIT_AUTH_FAILED');
    });

    it('classifies remote not found errors as GIT_REMOTE_NOT_FOUND', () => {
      const err = classifyGitError("fatal: 'origin' does not appear to be a git repository", 128);
      expect(err.code).toBe('GIT_REMOTE_NOT_FOUND');
    });

    it('classifies network errors as GIT_NETWORK_ERROR', () => {
      const err = classifyGitError('fatal: Could not resolve host: github.com', 128);
      expect(err.code).toBe('GIT_NETWORK_ERROR');
    });

    it('classifies non-fast-forward errors as GIT_NON_FAST_FORWARD', () => {
      const err = classifyGitError('error: failed to push some refs to remote (non-fast-forward)', 1);
      expect(err.code).toBe('GIT_NON_FAST_FORWARD');
    });
  });

  describe('gitPush & gitLsRemote execution', () => {
    it('strictly forbids pushing directly to main or master', async () => {
      await expect(
        gitPush(tmpRepoDir, {
          branch: 'main',
          remote: 'origin',
        }),
      ).rejects.toThrow(AppError);

      await expect(
        gitPush(tmpRepoDir, {
          branch: 'main',
          remote: 'origin',
        }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN_PUSH_BRANCH',
      });

      await expect(
        gitPush(tmpRepoDir, {
          branch: 'master',
          remote: 'origin',
        }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN_PUSH_BRANCH',
      });
    });

    it('pushes feature branch successfully and confirms with git ls-remote', async () => {
      // Tạo feature branch và commit nội dung
      execSync('git checkout -b feature/auth-module', { cwd: tmpRepoDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(tmpRepoDir, 'feature.txt'), 'Feature implementation\n');
      execSync('git add . && git commit -m "feat(auth): implement auth module"', {
        cwd: tmpRepoDir,
        stdio: 'ignore',
      });
      const localSha = execSync('git rev-parse HEAD', { cwd: tmpRepoDir }).toString().trim();

      // Push branch lên bare remote
      const result = await gitPush(tmpRepoDir, {
        branch: 'feature/auth-module',
        remote: 'origin',
        setUpstream: true,
        confirm: true,
      });

      expect(result.branch).toBe('feature/auth-module');
      expect(result.remote).toBe('origin');
      expect(result.remoteRef).toBe('refs/heads/feature/auth-module');
      expect(result.commitSha).toBe(localSha);
      expect(result.confirmedRemote).toBe(true);

      // Nghiệm thu: git ls-remote thấy branch trên remote
      const lsResult = await gitLsRemote(tmpRepoDir, {
        remote: 'origin',
        branch: 'feature/auth-module',
      });
      expect(lsResult.branchFound).toBe(true);
      expect(lsResult.commitSha).toBe(localSha);
      expect(lsResult.ref).toBe('refs/heads/feature/auth-module');

      // Xác nhận bằng gitConfirmRemoteBranch
      const confirmCheck = await gitConfirmRemoteBranch(
        tmpRepoDir,
        'feature/auth-module',
        'origin',
      );
      expect(confirmCheck.exists).toBe(true);
      expect(confirmCheck.commitSha).toBe(localSha);
    });

    it('throws GIT_REMOTE_NOT_FOUND when pushing to non-existent remote', async () => {
      execSync('git checkout -b feature/test-remote', { cwd: tmpRepoDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(tmpRepoDir, 'f.txt'), 'hello');
      execSync('git add . && git commit -m "feat(test): add f"', { cwd: tmpRepoDir, stdio: 'ignore' });

      await expect(
        gitPush(tmpRepoDir, {
          branch: 'feature/test-remote',
          remote: 'invalid-remote-xyz',
          confirm: false,
        }),
      ).rejects.toMatchObject({
        code: 'GIT_REMOTE_NOT_FOUND',
      });
    });

    it('retries on simulated transient network failure and succeeds', async () => {
      execSync('git checkout -b feature/transient-test', { cwd: tmpRepoDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(tmpRepoDir, 'retry.txt'), 'retry me');
      execSync('git add . && git commit -m "feat(retry): test retry"', { cwd: tmpRepoDir, stdio: 'ignore' });
      const localSha = execSync('git rev-parse HEAD', { cwd: tmpRepoDir }).toString().trim();

      let attempts = 0;
      const retryCallbacks: number[] = [];

      // Giả lập runner thất bại 1 lần do mạng rồi thành công
      const customRunner = async (args: string[], cwd: string) => {
        attempts++;
        if (attempts === 1) {
          return {
            stdout: '',
            stderr: 'fatal: Could not resolve host: github.com',
            exitCode: 128,
          };
        }
        // Gọi lệnh git thật ở lần 2
        return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
          try {
            const out = execSync(`git ${args.join(' ')}`, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
            resolve({ stdout: out, stderr: '', exitCode: 0 });
          } catch (err: unknown) {
            const e = err as { stdout?: string; stderr?: string; status?: number };
            resolve({
              stdout: e.stdout ?? '',
              stderr: e.stderr ?? String(err),
              exitCode: e.status ?? 1,
            });
          }
        });
      };

      const result = await gitPush(tmpRepoDir, {
        branch: 'feature/transient-test',
        remote: 'origin',
        maxRetries: 2,
        retryDelayMs: 50,
        runCommand: customRunner,
        onRetry: (attempt) => retryCallbacks.push(attempt),
      });

      expect(attempts).toBe(2);
      expect(retryCallbacks).toEqual([1]);
      expect(result.branch).toBe('feature/transient-test');
      expect(result.commitSha).toBe(localSha);
    });
  });
});
