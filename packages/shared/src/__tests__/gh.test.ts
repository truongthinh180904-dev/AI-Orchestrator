import { describe, expect, it, vi } from 'vitest';
import {
  sanitizeGhOutput,
  extractPrUrl,
  extractPrNumber,
  classifyGhError,
  ghPrCreate,
  ghPrView,
  generateFeatureReleaseReportMarkdown,
  QualityGatePolicySchema,
  AppError,
} from '../index.js';

describe('GitHub CLI (gh) & Release Report Tests (REL-006)', () => {
  describe('sanitizeGhOutput', () => {
    it('redacts classic GitHub personal access tokens (ghp_)', () => {
      const input = 'Error: remote failed with token ghp_1234567890abcdefghijklmnopqrstuvwxyza';
      const output = sanitizeGhOutput(input);
      expect(output).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwxyza');
      expect(output).toContain('[REDACTED_GH_TOKEN]');
    });

    it('redacts fine-grained GitHub personal access tokens (github_pat_)', () => {
      const token = 'github_pat_11ABCDEFG0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      const input = `gh auth failure using ${token} on host github.com`;
      const output = sanitizeGhOutput(input);
      expect(output).not.toContain(token);
      expect(output).toContain('[REDACTED_GH_PAT]');
    });

    it('redacts Bearer tokens and credentials in URLs', () => {
      const input = 'Authorization: Bearer mySecretToken123\nClone https://user:secretpass@github.com/repo.git';
      const output = sanitizeGhOutput(input);
      expect(output).toContain('Bearer [REDACTED_TOKEN]');
      expect(output).toContain('https://[REDACTED_CREDENTIALS]@github.com/repo.git');
      expect(output).not.toContain('mySecretToken123');
      expect(output).not.toContain('secretpass');
    });
  });

  describe('extractPrUrl & extractPrNumber', () => {
    it('extracts PR URL and PR number accurately', () => {
      const text = 'Creating pull request for feature/REL-006 into main in repo\nhttps://github.com/acme/project/pull/42\n';
      expect(extractPrUrl(text)).toBe('https://github.com/acme/project/pull/42');
      expect(extractPrNumber('https://github.com/acme/project/pull/42')).toBe(42);
    });

    it('returns null when no PR URL is present', () => {
      expect(extractPrUrl('Just some normal output without PR url')).toBeNull();
      expect(extractPrNumber('invalid-url')).toBeNull();
    });
  });

  describe('classifyGhError', () => {
    it('classifies ENOENT / gh command not found as GH_NOT_FOUND', () => {
      const err = classifyGhError('spawn gh ENOENT', 1);
      expect(err.code).toBe('GH_NOT_FOUND');
    });

    it('classifies auth errors as GH_AUTH_FAILED', () => {
      const err = classifyGhError('To authenticate, please run: gh auth login', 1);
      expect(err.code).toBe('GH_AUTH_FAILED');
    });

    it('classifies existing PR error as GH_PR_ALREADY_EXISTS and extracts PR url', () => {
      const err = classifyGhError(
        'a pull request for branch "feature/REL-001" already exists:\nhttps://github.com/org/repo/pull/99',
        1,
      );
      expect(err.code).toBe('GH_PR_ALREADY_EXISTS');
      expect(err.context?.prUrl).toBe('https://github.com/org/repo/pull/99');
      expect(err.context?.prNumber).toBe(99);
    });

    it('classifies connection timeout as GH_NETWORK_ERROR', () => {
      const err = classifyGhError('fatal: connection timed out after 30000 ms', 1);
      expect(err.code).toBe('GH_NETWORK_ERROR');
    });

    it('classifies other failures as GH_COMMAND_FAILED', () => {
      const err = classifyGhError('unhandled failure in gh command', 1);
      expect(err.code).toBe('GH_COMMAND_FAILED');
    });
  });

  describe('ghPrCreate', () => {
    it('creates PR successfully with custom runner', async () => {
      const mockRunner = vi.fn().mockResolvedValue({
        stdout: 'https://github.com/org/repo/pull/105\n',
        stderr: '',
        exitCode: 0,
      });

      const result = await ghPrCreate({
        base: 'main',
        head: 'feature/REL-006',
        title: 'feat(REL-006): create pull request and release report',
        bodyFile: 'reports/REL-006.md',
        runCommand: mockRunner,
      });

      expect(result.prUrl).toBe('https://github.com/org/repo/pull/105');
      expect(result.prNumber).toBe(105);
      expect(result.isExisting).toBe(false);
      expect(mockRunner).toHaveBeenCalledWith(
        [
          'pr',
          'create',
          '--base',
          'main',
          '--head',
          'feature/REL-006',
          '--title',
          'feat(REL-006): create pull request and release report',
          '--body-file',
          'reports/REL-006.md',
        ],
        '.',
        undefined,
      );
    });

    it('handles already existing PR gracefully when allowExisting is true', async () => {
      const mockRunner = vi.fn().mockResolvedValue({
        stdout: '',
        stderr: 'a pull request for branch "feature/REL-006" already exists:\nhttps://github.com/org/repo/pull/105\n',
        exitCode: 1,
      });

      const result = await ghPrCreate({
        base: 'main',
        head: 'feature/REL-006',
        title: 'feat(REL-006): create pull request',
        body: 'Description',
        allowExisting: true,
        runCommand: mockRunner,
      });

      expect(result.isExisting).toBe(true);
      expect(result.prUrl).toBe('https://github.com/org/repo/pull/105');
      expect(result.prNumber).toBe(105);
    });

    it('retries on network error with exponential backoff and succeeds', async () => {
      let callCount = 0;
      const mockRunner = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            stdout: '',
            stderr: 'connection timed out',
            exitCode: 1,
          });
        }
        return Promise.resolve({
          stdout: 'https://github.com/org/repo/pull/106\n',
          stderr: '',
          exitCode: 0,
        });
      });

      const onRetry = vi.fn();

      const result = await ghPrCreate({
        base: 'main',
        head: 'feature/REL-006',
        title: 'feat(REL-006): pr',
        maxRetries: 2,
        retryDelayMs: 10,
        runCommand: mockRunner,
        onRetry,
      });

      expect(result.prUrl).toBe('https://github.com/org/repo/pull/106');
      expect(callCount).toBe(2);
      expect(onRetry).toHaveBeenCalledWith(1, expect.any(AppError));
    });

    it('fails fast on authentication error without retrying', async () => {
      const mockRunner = vi.fn().mockResolvedValue({
        stdout: '',
        stderr: 'To authenticate, please run: gh auth login',
        exitCode: 1,
      });

      await expect(
        ghPrCreate({
          base: 'main',
          head: 'feature/REL-006',
          title: 'feat(REL-006): pr',
          maxRetries: 3,
          runCommand: mockRunner,
        }),
      ).rejects.toThrowError(AppError);

      expect(mockRunner).toHaveBeenCalledTimes(1);
    });
  });

  describe('ghPrView', () => {
    it('returns parsed PR view data on success', async () => {
      const mockRunner = vi.fn().mockResolvedValue({
        stdout: JSON.stringify({
          url: 'https://github.com/org/repo/pull/42',
          number: 42,
          state: 'OPEN',
          title: 'Feature Release',
          headRefName: 'feature/REL-006',
          baseRefName: 'main',
        }),
        stderr: '',
        exitCode: 0,
      });

      const result = await ghPrView('feature/REL-006', { runCommand: mockRunner });
      expect(result?.url).toBe('https://github.com/org/repo/pull/42');
      expect(result?.number).toBe(42);
      expect(result?.state).toBe('OPEN');
    });

    it('returns null when PR view fails or is not found', async () => {
      const mockRunner = vi.fn().mockResolvedValue({
        stdout: '',
        stderr: 'no pull requests found for branch',
        exitCode: 1,
      });

      const result = await ghPrView('feature/non-existing', { runCommand: mockRunner });
      expect(result).toBeNull();
    });
  });

  describe('generateFeatureReleaseReportMarkdown', () => {
    it('generates GitHub-flavored markdown with tasks, Quality Gate evidence, and sign-off checklist', () => {
      const report = generateFeatureReleaseReportMarkdown({
        featureId: 'REL-006',
        featureName: 'PR Creation & Release Report',
        description: 'Auto-create PR and generate release report',
        branch: 'feature/REL-006',
        baseBranch: 'main',
        commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
        prUrl: 'https://github.com/org/repo/pull/42',
        tasks: [
          {
            id: 'REL-001',
            title: 'Define tasks',
            description: null,
            feature_id: 'REL-006',
            phase: 'Release',
            priority: 1,
            status: 'DONE',
            worker_type: 'agy',
            repository: '.',
            acceptance_criteria: ['List tasks'],
            test_commands: ['pnpm test'],
            scope_files: null,
            dependencies: [],
            is_required: true,
            execution_order: 1,
          },
        ],
        taskSummary: {
          total_tasks: 1,
          required_count: 1,
          completed_count: 1,
          pending_count: 0,
          failed_count: 0,
          missing_count: 0,
          is_all_required_done: true,
          ready_for_release: true,
        },
        qualityGateResult: {
          id: 'qg-1',
          task_id: 'REL-001',
          run_id: null,
          repo_path: '.',
          passed: true,
          status: 'PASSED',
          summary: 'All checks passed',
          policy: QualityGatePolicySchema.parse({}),
          rule_evaluations: [],
          evidence_summary: {
            cliExitCode: 0,
            cliStatus: 'SUCCESS',
            cliSucceeded: true,
            totalCommands: 3,
            passedCommands: 3,
            failedCommands: 0,
            skippedCommands: 0,
            outOfScopeFilesCount: 0,
            outOfScopeFiles: [],
            reviewFindingsCount: 0,
            reviewHighCount: 0,
            reviewCriticalCount: 0,
            secretFindingsCount: 0,
            auditHighCriticalCount: 0,
          },
          command_records: [],
          scope_result: null,
          review_result: null,
          security_result: null,
          duration_ms: 120,
          evaluated_at: '2026-10-23T14:00:00.000Z',
        },
      });

      expect(report).toContain('# Feature Release Report: PR Creation & Release Report (REL-006)');
      expect(report).toContain('https://github.com/org/repo/pull/42');
      expect(report).toContain('READY_FOR_REVIEW');
      expect(report).toContain('abcdef1234567890abcdef1234567890abcdef12');
      expect(report).toContain('`REL-001`');
      expect(report).toContain('PASSED');
      expect(report).toContain('0 secrets leaked, 0 audit vulnerabilities');
      expect(report).toContain('Review & Sign-Off Checklist');
    });
  });
});
