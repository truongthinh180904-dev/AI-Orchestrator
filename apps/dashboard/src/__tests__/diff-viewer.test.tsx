/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { DiffViewer, parsePatchLines } from '../components/DiffViewer.js';
import { TaskDetail } from '../components/TaskDetail.js';
import TaskDiffPage from '../app/tasks/[id]/diff/page.js';
import DiffPage from '../app/diff/page.js';
import { ApiClient } from '../lib/api.js';
import type {
  TaskDiffData,
  TaskWithDependencies,
  TaskRunHistory,
} from '@ai-orchestrator/shared';

describe('DiffViewer Component & Diff Pages (UI-005)', () => {
  afterEach(() => {
    cleanup();
  });

  const sampleDiffData: TaskDiffData = {
    taskId: 'TSK-DIFF-01',
    repoPath: '/workspace/ai-orchestrator',
    scopeFiles: ['apps/dashboard/src/components/DiffViewer.tsx'],
    isScopeClean: true,
    outOfScopeFiles: [],
    changedFiles: ['apps/dashboard/src/components/DiffViewer.tsx'],
    fileDiffs: [
      {
        path: 'apps/dashboard/src/components/DiffViewer.tsx',
        status: 'modified',
        additions: 15,
        deletions: 3,
        inScope: true,
        patch: [
          'diff --git a/apps/dashboard/src/components/DiffViewer.tsx b/apps/dashboard/src/components/DiffViewer.tsx',
          'index 1234567..89abcdef 100644',
          '--- a/apps/dashboard/src/components/DiffViewer.tsx',
          '+++ b/apps/dashboard/src/components/DiffViewer.tsx',
          '@@ -10,3 +10,15 @@',
          ' export function existingCode() {',
          '-  return false;',
          '+  // Updated code',
          '+  return true;',
          ' }',
        ].join('\n'),
      },
    ],
    rawDiff: [
      'diff --git a/apps/dashboard/src/components/DiffViewer.tsx b/apps/dashboard/src/components/DiffViewer.tsx',
      'index 1234567..89abcdef 100644',
      '--- a/apps/dashboard/src/components/DiffViewer.tsx',
      '+++ b/apps/dashboard/src/components/DiffViewer.tsx',
      '@@ -10,3 +10,15 @@',
      ' export function existingCode() {',
      '-  return false;',
      '+  // Updated code',
      '+  return true;',
      ' }',
    ].join('\n'),
    stats: {
      totalChanged: 1,
      inScopeCount: 1,
      outOfScopeCount: 0,
      additions: 15,
      deletions: 3,
    },
  };

  const sampleDiffWithAlienFiles: TaskDiffData = {
    taskId: 'TSK-DIFF-02',
    repoPath: '/workspace/ai-orchestrator',
    scopeFiles: ['packages/db/src/schema.ts'],
    isScopeClean: false,
    outOfScopeFiles: ['secret-token.txt', 'unauthorized.config.js'],
    changedFiles: [
      'packages/db/src/schema.ts',
      'secret-token.txt',
      'unauthorized.config.js',
    ],
    fileDiffs: [
      {
        path: 'packages/db/src/schema.ts',
        status: 'modified',
        additions: 10,
        deletions: 2,
        inScope: true,
        patch: [
          '@@ -1,3 +1,11 @@',
          ' export const schema = {',
          '+  newCol: "test"',
          ' };',
        ].join('\n'),
      },
      {
        path: 'secret-token.txt',
        status: 'added',
        additions: 1,
        deletions: 0,
        inScope: false,
        patch: [
          '@@ -0,0 +1,1 @@',
          '+MY_SECRET_KEY=12345',
        ].join('\n'),
      },
      {
        path: 'unauthorized.config.js',
        status: 'added',
        additions: 5,
        deletions: 0,
        inScope: false,
        patch: [
          '@@ -0,0 +1,5 @@',
          '+module.exports = { bypass: true };',
        ].join('\n'),
      },
    ],
    rawDiff: 'diff --git a/packages/db/src/schema.ts ...\n+newCol',
    stats: {
      totalChanged: 3,
      inScopeCount: 1,
      outOfScopeCount: 2,
      additions: 16,
      deletions: 2,
    },
  };

  describe('parsePatchLines helper', () => {
    it('correctly categorizes line types and coordinates', () => {
      const patch = [
        'diff --git a/foo.ts b/foo.ts',
        '@@ -10,3 +15,4 @@',
        ' context line',
        '-deleted line',
        '+added line',
      ].join('\n');

      const parsed = parsePatchLines(patch);
      expect(parsed).toHaveLength(5);
      expect(parsed[0]?.type).toBe('header');
      expect(parsed[1]?.type).toBe('chunk');
      expect(parsed[2]?.type).toBe('context');
      expect(parsed[2]?.oldLineNumber).toBe(10);
      expect(parsed[2]?.newLineNumber).toBe(15);
      expect(parsed[3]?.type).toBe('delete');
      expect(parsed[3]?.oldLineNumber).toBe(11);
      expect(parsed[4]?.type).toBe('add');
      expect(parsed[4]?.newLineNumber).toBe(16);
    });

    it('returns empty array when patch is empty', () => {
      expect(parsePatchLines('')).toEqual([]);
    });
  });

  describe('DiffViewer core features', () => {
    it('displays loading indicator initially while fetching diff from API', async () => {
      let resolvePromise: (val: TaskDiffData) => void;
      const promise = new Promise<TaskDiffData>((resolve) => {
        resolvePromise = resolve;
      });

      const mockApi = {
        getTaskDiff: vi.fn().mockReturnValue(promise),
      } as unknown as ApiClient;

      render(<DiffViewer taskId="TSK-DIFF-01" apiClient={mockApi} />);

      expect(screen.getByTestId('diff-loading')).toBeDefined();
      expect(screen.getByTestId('diff-loading').textContent).toContain('Đang tải git diff');

      resolvePromise!(sampleDiffData);

      await waitFor(() => {
        expect(screen.queryByTestId('diff-loading')).toBeNull();
        expect(screen.getByTestId('diff-viewer')).toBeDefined();
      });
    });

    it('displays error box with retry button when API call fails', async () => {
      const mockApi = {
        getTaskDiff: vi.fn().mockRejectedValue(new Error('Network error 500')),
      } as unknown as ApiClient;

      render(<DiffViewer taskId="TSK-FAIL" apiClient={mockApi} />);

      await waitFor(() => {
        expect(screen.getByTestId('diff-error')).toBeDefined();
        expect(screen.getByTestId('diff-error').textContent).toContain('Network error 500');
      });

      // Clicking retry triggers another call
      const retryBtn = screen.getByTestId('diff-retry-btn');
      fireEvent.click(retryBtn);
      expect(mockApi.getTaskDiff).toHaveBeenCalledTimes(2);
    });

    it('renders empty state when working tree and diff have no changes', async () => {
      const emptyDiff: TaskDiffData = {
        taskId: 'TSK-CLEAN',
        repoPath: '/workspace',
        scopeFiles: [],
        isScopeClean: true,
        outOfScopeFiles: [],
        changedFiles: [],
        fileDiffs: [],
        rawDiff: '',
        stats: {
          totalChanged: 0,
          inScopeCount: 0,
          outOfScopeCount: 0,
          additions: 0,
          deletions: 0,
        },
      };

      const mockApi = {
        getTaskDiff: vi.fn().mockResolvedValue(emptyDiff),
      } as unknown as ApiClient;

      render(<DiffViewer taskId="TSK-CLEAN" apiClient={mockApi} />);

      await waitFor(() => {
        expect(screen.getByTestId('diff-empty')).toBeDefined();
        expect(screen.getByTestId('diff-empty').textContent).toContain('Không có thay đổi nào trong Git');
      });
    });

    it('renders diff with summary statistics and colored unified additions/deletions', async () => {
      render(<DiffViewer initialData={sampleDiffData} />);

      expect(screen.getByTestId('diff-viewer')).toBeDefined();
      expect(screen.getByTestId('diff-stat-files').textContent).toContain('1 tập tin');
      expect(screen.getByTestId('diff-stat-additions').textContent).toContain('+15 dòng');
      expect(screen.getByTestId('diff-stat-deletions').textContent).toContain('-3 dòng');
      expect(screen.getByTestId('diff-task-id-badge').textContent).toBe('TSK-DIFF-01');

      // Check scope banner: clean scope
      const scopeBanner = screen.getByTestId('diff-scope-banner');
      expect(scopeBanner.textContent).toContain('Phạm vi hợp lệ');
      expect(screen.queryByTestId('diff-scope-alien-files')).toBeNull();

      // Check file card
      const fileCard = screen.getByTestId('diff-file-card-apps/dashboard/src/components/DiffViewer.tsx');
      expect(fileCard).toBeDefined();
      expect(screen.getByTestId('diff-status-modified')).toBeDefined();
      expect(screen.getByTestId('diff-file-scope-in')).toBeDefined();

      // Check colored diff lines
      const addedLines = screen.getAllByTestId('diff-line-added');
      expect(addedLines.length).toBeGreaterThan(0);
      expect(addedLines[0]?.textContent).toContain('Updated code');

      const deletedLines = screen.getAllByTestId('diff-line-deleted');
      expect(deletedLines.length).toBeGreaterThan(0);
      expect(deletedLines[0]?.textContent).toContain('return false');

      const chunkLines = screen.getAllByTestId('diff-line-chunk');
      expect(chunkLines.length).toBeGreaterThan(0);
      expect(chunkLines[0]?.textContent).toContain('@@');
    });

    it('displays warning banner and badges for alien files out of scope (QLT-003)', async () => {
      render(<DiffViewer initialData={sampleDiffWithAlienFiles} />);

      const scopeBanner = screen.getByTestId('diff-scope-banner');
      expect(scopeBanner.textContent).toContain('Cảnh báo Quality Gate (QLT-003)');
      expect(scopeBanner.textContent).toContain('2 tập tin ngoài phạm vi (file lạ)');

      const alienFilesContainer = screen.getByTestId('diff-scope-alien-files');
      expect(alienFilesContainer.textContent).toContain('secret-token.txt');
      expect(alienFilesContainer.textContent).toContain('unauthorized.config.js');

      // Alien file cards have out-of-scope badge
      const outScopeBadges = screen.getAllByTestId('diff-file-scope-out');
      expect(outScopeBadges).toHaveLength(2);
    });

    it('filters files by scope (all, in-scope only, out-of-scope only)', async () => {
      render(<DiffViewer initialData={sampleDiffWithAlienFiles} />);

      // Initially all 3 files are rendered
      expect(screen.getByTestId('diff-file-card-packages/db/src/schema.ts')).toBeDefined();
      expect(screen.getByTestId('diff-file-card-secret-token.txt')).toBeDefined();
      expect(screen.getByTestId('diff-file-card-unauthorized.config.js')).toBeDefined();

      // Filter: In-scope only
      fireEvent.click(screen.getByTestId('diff-filter-in-scope'));
      expect(screen.getByTestId('diff-file-card-packages/db/src/schema.ts')).toBeDefined();
      expect(screen.queryByTestId('diff-file-card-secret-token.txt')).toBeNull();
      expect(screen.queryByTestId('diff-file-card-unauthorized.config.js')).toBeNull();

      // Filter: Out-of-scope only
      fireEvent.click(screen.getByTestId('diff-filter-out-of-scope'));
      expect(screen.queryByTestId('diff-file-card-packages/db/src/schema.ts')).toBeNull();
      expect(screen.getByTestId('diff-file-card-secret-token.txt')).toBeDefined();
      expect(screen.getByTestId('diff-file-card-unauthorized.config.js')).toBeDefined();

      // Filter: Back to all
      fireEvent.click(screen.getByTestId('diff-filter-all'));
      expect(screen.getByTestId('diff-file-card-packages/db/src/schema.ts')).toBeDefined();
    });

    it('filters files by search query', async () => {
      render(<DiffViewer initialData={sampleDiffWithAlienFiles} />);

      const searchInput = screen.getByTestId('diff-search-input');
      fireEvent.change(searchInput, { target: { value: 'secret' } });

      expect(screen.getByTestId('diff-file-card-secret-token.txt')).toBeDefined();
      expect(screen.queryByTestId('diff-file-card-packages/db/src/schema.ts')).toBeNull();
      expect(screen.queryByTestId('diff-file-card-unauthorized.config.js')).toBeNull();

      // Clear search button
      fireEvent.click(screen.getByTestId('diff-search-clear'));
      expect(screen.getByTestId('diff-file-card-packages/db/src/schema.ts')).toBeDefined();
    });

    it('toggles view mode between per-file cards and raw unified diff', async () => {
      render(<DiffViewer initialData={sampleDiffData} />);

      // Initially files mode
      expect(screen.getByTestId('diff-files-container')).toBeDefined();
      expect(screen.queryByTestId('diff-raw-container')).toBeNull();

      // Switch to Raw mode
      fireEvent.click(screen.getByTestId('diff-view-raw'));
      expect(screen.queryByTestId('diff-files-container')).toBeNull();
      expect(screen.getByTestId('diff-raw-container')).toBeDefined();
      const rawAddLines = screen.getAllByTestId('diff-raw-line-add');
      expect(rawAddLines.length).toBeGreaterThan(0);
      expect(rawAddLines[0]?.textContent).toContain('Updated code');

      // Switch back to files mode
      fireEvent.click(screen.getByTestId('diff-view-files'));
      expect(screen.getByTestId('diff-files-container')).toBeDefined();
    });

    it('collapses and expands file cards', () => {
      render(<DiffViewer initialData={sampleDiffData} />);

      expect(screen.getByTestId('diff-file-content')).toBeDefined();

      // Click header to collapse
      fireEvent.click(screen.getByTestId('diff-file-header'));
      expect(screen.queryByTestId('diff-file-content')).toBeNull();

      // Click again to expand
      fireEvent.click(screen.getByTestId('diff-file-header'));
      expect(screen.getByTestId('diff-file-content')).toBeDefined();
    });

    it('handles clipboard copying of diff and individual file patch', async () => {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: writeTextMock,
        },
        configurable: true,
        writable: true,
      });

      render(<DiffViewer initialData={sampleDiffData} />);

      // Copy all diff
      const copyAllBtn = screen.getByTestId('diff-copy-all-btn');
      fireEvent.click(copyAllBtn);
      expect(writeTextMock).toHaveBeenCalledWith(sampleDiffData.rawDiff);

      // Copy single file
      const copyFileBtn = screen.getByTestId(
        'diff-copy-file-apps/dashboard/src/components/DiffViewer.tsx',
      );
      fireEvent.click(copyFileBtn);
      expect(writeTextMock).toHaveBeenCalledWith(sampleDiffData.fileDiffs[0]?.patch);
    });
  });

  describe('Integration with TaskDetail (UI-003 & UI-005)', () => {
    it('switching to tab-diff in TaskDetail renders DiffViewer for that task', async () => {
      const mockTask: TaskWithDependencies = {
        id: 'TSK-WITH-DIFF',
        feature_id: 'FEAT-1',
        plan_id: null,
        title: 'Task with code changes',
        description: 'Sample description',
        phase: 'UI',
        worker_type: 'agy',
        repository: '.',
        scope_files: ['src/app.ts'],
        acceptance_criteria: ['Check diff'],
        test_commands: ['pnpm test'],
        priority: 1,
        max_attempts: 3,
        timeout_minutes: 30,
        status: 'VERIFYING',
        attempts: 1,
        created_at: '2026-10-23T00:00:00.000Z',
        updated_at: '2026-10-23T00:30:00.000Z',
        dependencies: [],
      };

      const mockRun = {
        id: 'run-1',
        task_id: 'TSK-WITH-DIFF',
        attempt: 1,
        status: 'RUNNING' as const,
        exit_code: null,
        pid: 1234,
        started_at: '2026-10-23T00:00:00.000Z',
        finished_at: null,
        branch: 'dev',
        commit_sha: null,
      };

      const mockHistory: TaskRunHistory = {
        taskId: 'TSK-WITH-DIFF',
        taskTitle: 'Task with code changes',
        taskStatus: 'VERIFYING',
        attempts: 1,
        maxAttempts: 3,
        latestRun: mockRun,
        latestCheckpoint: null,
        history: [
          {
            attempt: 1,
            run: mockRun,
            result: {
              outcome: 'SUCCESS',
              success: true,
              exit_code: 0,
              duration_ms: 1000,
              error_message: null,
              event_count: 1,
              checkpoint_count: 0,
              report_count: 0,
            },
            checkpoints: [],
            reports: [],
          },
        ],
      };

      const mockApi = {
        getTask: vi.fn().mockResolvedValue(mockTask),
        getTaskHistory: vi.fn().mockResolvedValue(mockHistory),
        getRunDetail: vi.fn().mockResolvedValue({
          run: mockRun,
          task: mockTask,
          result: mockHistory.history[0]!.result,
          checkpoints: [],
          reports: [],
          events: [],
          eventStats: {
            total: 0,
            byType: {},
          },
        }),
        getTaskDiff: vi.fn().mockResolvedValue(sampleDiffData),
      } as unknown as ApiClient;

      render(<TaskDetail taskId="TSK-WITH-DIFF" apiClient={mockApi} />);

      await waitFor(() => {
        expect(screen.getByTestId('tab-diff')).toBeDefined();
      });

      // Click Diff tab
      fireEvent.click(screen.getByTestId('tab-diff'));

      await waitFor(() => {
        expect(screen.getByTestId('run-diff-container')).toBeDefined();
        expect(screen.getByTestId('diff-viewer')).toBeDefined();
      });
      expect(mockApi.getTaskDiff).toHaveBeenCalledWith('TSK-WITH-DIFF');
    });
  });

  describe('Pages (TaskDiffPage & DiffPage)', () => {
    it('TaskDiffPage renders diff viewer and back link', async () => {
      const mockApi = {
        getTaskDiff: vi.fn().mockResolvedValue(sampleDiffData),
      } as unknown as ApiClient;

      render(
        <TaskDiffPage
          params={{ id: 'TSK-DIFF-01' }}
          apiClient={mockApi}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('dashboard-task-diff-page')).toBeDefined();
        expect(screen.getByTestId('diff-viewer')).toBeDefined();
      });
    });

    it('DiffPage lists tasks and renders diff viewer for selected task', async () => {
      const mockTasks: TaskWithDependencies[] = [
        {
          id: 'TSK-01',
          feature_id: 'FEAT-1',
          plan_id: null,
          title: 'First task',
          description: '',
          phase: 'UI',
          worker_type: 'agy',
          repository: '.',
          scope_files: [],
          acceptance_criteria: [],
          test_commands: [],
          priority: 1,
          max_attempts: 1,
          timeout_minutes: 10,
          status: 'DONE',
          attempts: 1,
          created_at: '2026-10-23T00:00:00.000Z',
          updated_at: '2026-10-23T00:00:00.000Z',
          dependencies: [],
        },
      ];

      const mockApi = {
        getTasks: vi.fn().mockResolvedValue(mockTasks),
        getTaskDiff: vi.fn().mockResolvedValue(sampleDiffData),
      } as unknown as ApiClient;

      render(<DiffPage apiClient={mockApi} />);

      await waitFor(() => {
        expect(screen.getByTestId('dashboard-diff-page')).toBeDefined();
        expect(screen.getByTestId('diff-task-select')).toBeDefined();
        expect(screen.getByTestId('diff-viewer')).toBeDefined();
      });
    });
  });
});
