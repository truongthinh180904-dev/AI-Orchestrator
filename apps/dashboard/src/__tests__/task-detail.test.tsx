/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { TaskDetail } from '../components/TaskDetail.js';
import TaskDetailPage from '../app/tasks/[id]/page.js';
import { ApiClient } from '../lib/api.js';
import type { TaskWithDependencies, TaskRunHistory, RunDetail } from '@ai-orchestrator/shared';

describe('TaskDetail & Timeline Component (UI-003)', () => {
  afterEach(() => {
    cleanup();
  });

  const mockTask: TaskWithDependencies = {
    id: 'TSK-003',
    feature_id: 'FEAT-DASH',
    plan_id: null,
    title: 'Task detail and execution timeline view',
    description: 'Detailed view displaying task metadata, dependencies and real run timeline',
    phase: 'UI',
    worker_type: 'agy',
    repository: '.',
    scope_files: ['apps/dashboard/src/components/TaskDetail.tsx'],
    acceptance_criteria: [
      'Render task metadata and acceptance criteria',
      'Display real execution timeline with attempts and checkpoints',
    ],
    test_commands: ['pnpm test apps/dashboard/src/__tests__/task-detail.test.tsx'],
    priority: 1,
    max_attempts: 3,
    timeout_minutes: 30,
    status: 'DONE',
    attempts: 2,
    created_at: '2026-10-23T00:00:00.000Z',
    updated_at: '2026-10-23T00:30:00.000Z',
    dependencies: ['TSK-001', 'TSK-002'],
  };

  const mockRun1 = {
    id: 'run-attempt-1',
    task_id: 'TSK-003',
    attempt: 1,
    status: 'ERROR' as const,
    exit_code: 1,
    pid: 1234,
    started_at: '2026-10-23T00:05:00.000Z',
    finished_at: '2026-10-23T00:07:00.000Z',
    branch: 'dev',
    commit_sha: 'a1b2c3d4e5f6',
  };

  const mockRun2 = {
    id: 'run-attempt-2',
    task_id: 'TSK-003',
    attempt: 2,
    status: 'SUCCESS' as const,
    exit_code: 0,
    pid: 5678,
    started_at: '2026-10-23T00:10:00.000Z',
    finished_at: '2026-10-23T00:15:00.000Z',
    branch: 'dev',
    commit_sha: 'f6e5d4c3b2a1',
  };

  const mockHistory: TaskRunHistory = {
    taskId: 'TSK-003',
    taskTitle: 'Task detail and execution timeline view',
    taskStatus: 'DONE',
    attempts: 2,
    maxAttempts: 3,
    latestRun: mockRun2,
    latestCheckpoint: {
      id: 'cp-2',
      task_id: 'TSK-003',
      run_id: 'run-attempt-2',
      attempt: 2,
      step: 'run_completed',
      status: 'COMPLETED',
      data: { exit_code: 0 },
      created_at: '2026-10-23T00:15:00.000Z',
    },
    history: [
      {
        attempt: 1,
        run: mockRun1,
        result: {
          outcome: 'ERROR',
          success: false,
          exit_code: 1,
          duration_ms: 120000,
          error_message: 'Process exited with code 1: typecheck error',
          event_count: 5,
          checkpoint_count: 2,
          report_count: 0,
        },
        checkpoints: [
          {
            id: 'cp-run1-1',
            task_id: 'TSK-003',
            run_id: 'run-attempt-1',
            attempt: 1,
            step: 'run_started',
            status: 'COMPLETED',
            data: { started: true },
            created_at: '2026-10-23T00:05:00.000Z',
          },
          {
            id: 'cp-run1-2',
            task_id: 'TSK-003',
            run_id: 'run-attempt-1',
            attempt: 1,
            step: 'run_failed',
            status: 'FAILED',
            data: { error: 'typecheck failed' },
            created_at: '2026-10-23T00:07:00.000Z',
          },
        ],
        reports: [],
      },
      {
        attempt: 2,
        run: mockRun2,
        result: {
          outcome: 'SUCCESS',
          success: true,
          exit_code: 0,
          duration_ms: 300000,
          error_message: null,
          event_count: 12,
          checkpoint_count: 3,
          report_count: 1,
        },
        checkpoints: [
          {
            id: 'cp-run2-1',
            task_id: 'TSK-003',
            run_id: 'run-attempt-2',
            attempt: 2,
            step: 'run_started',
            status: 'COMPLETED',
            data: { started: true },
            created_at: '2026-10-23T00:10:00.000Z',
          },
          {
            id: 'cp-run2-2',
            task_id: 'TSK-003',
            run_id: 'run-attempt-2',
            attempt: 2,
            step: 'test_execution',
            status: 'COMPLETED',
            data: { testsPassed: 4 },
            created_at: '2026-10-23T00:13:00.000Z',
          },
          {
            id: 'cp-run2-3',
            task_id: 'TSK-003',
            run_id: 'run-attempt-2',
            attempt: 2,
            step: 'run_completed',
            status: 'COMPLETED',
            data: { exit_code: 0 },
            created_at: '2026-10-23T00:15:00.000Z',
          },
        ],
        reports: [
          {
            id: 'rep-run2-1',
            run_id: 'run-attempt-2',
            kind: 'acceptance',
            content: 'All 4 acceptance criteria passed with flying colors.',
            created_at: '2026-10-23T00:15:00.000Z',
          },
        ],
      },
    ],
  };

  const mockRunDetail2: RunDetail = {
    run: mockRun2,
    task: mockTask,
    result: {
      outcome: 'SUCCESS',
      success: true,
      exit_code: 0,
      duration_ms: 300000,
      error_message: null,
      event_count: 12,
      checkpoint_count: 3,
      report_count: 1,
    },
    checkpoints: mockHistory.history[1]!.checkpoints,
    reports: mockHistory.history[1]!.reports,
    events: [
      {
        id: 1,
        run_id: 'run-attempt-2',
        seq: 1,
        type: 'stdout',
        payload: 'Starting execution container',
        ts: '2026-10-23T00:10:01.000Z',
      },
      {
        id: 2,
        run_id: 'run-attempt-2',
        seq: 2,
        type: 'agent_output',
        payload: { message: 'Executing test runner' },
        ts: '2026-10-23T00:13:05.000Z',
      },
      {
        id: 3,
        run_id: 'run-attempt-2',
        seq: 3,
        type: 'result',
        payload: { success: true },
        ts: '2026-10-23T00:15:00.000Z',
      },
    ],
    eventStats: {
      total: 3,
      byType: {
        stdout: 1,
        agent_output: 1,
        result: 1,
      },
    },
  };

  const mockRunDetail1: RunDetail = {
    run: mockRun1,
    task: mockTask,
    result: {
      outcome: 'ERROR',
      success: false,
      exit_code: 1,
      duration_ms: 120000,
      error_message: 'Process exited with code 1: typecheck error',
      event_count: 5,
      checkpoint_count: 2,
      report_count: 0,
    },
    checkpoints: mockHistory.history[0]!.checkpoints,
    reports: [],
    events: [
      {
        id: 101,
        run_id: 'run-attempt-1',
        seq: 1,
        type: 'stderr',
        payload: 'Error: Cannot find module foo',
        ts: '2026-10-23T00:06:00.000Z',
      },
    ],
    eventStats: {
      total: 1,
      byType: {
        stderr: 1,
      },
    },
  };

  it('renders loading state initially', async () => {
    const mockApi = {
      getTask: vi.fn().mockImplementation(() => new Promise(() => {})),
      getTaskHistory: vi.fn().mockImplementation(() => new Promise(() => {})),
      getRunDetail: vi.fn().mockImplementation(() => new Promise(() => {})),
    } as unknown as ApiClient;

    render(<TaskDetail taskId="TSK-003" apiClient={mockApi} />);

    expect(screen.getByTestId('loading-task-detail')).toBeDefined();
    expect(screen.getByText(/Đang tải thông tin chi tiết tác vụ TSK-003/i)).toBeDefined();
  });

  it('renders task metadata, criteria, test commands, and dependencies', async () => {
    const mockApi = {
      getTask: vi.fn().mockResolvedValue(mockTask),
      getTaskHistory: vi.fn().mockResolvedValue(mockHistory),
      getRunDetail: vi.fn().mockResolvedValue(mockRunDetail2),
    } as unknown as ApiClient;

    render(<TaskDetail taskId="TSK-003" apiClient={mockApi} />);

    await waitFor(() => {
      expect(screen.getByTestId('task-title').textContent).toBe(mockTask.title);
    });

    expect(screen.getByTestId('task-id-badge').textContent).toBe('TSK-003');
    expect(screen.getByTestId('task-phase-badge').textContent).toBe('Phase: UI');
    expect(screen.getByTestId('task-feature-badge').textContent).toBe('Feature: FEAT-DASH');
    expect(screen.getByTestId('task-description').textContent).toBe(mockTask.description);
    expect(screen.getByTestId('task-attempts-metric').textContent).toBe('2 / 3');
    expect(screen.getByTestId('task-priority').textContent).toBe('1');
    expect(screen.getByTestId('task-worker-type').textContent).toBe('agy');
    expect(screen.getByTestId('task-repository').textContent).toBe('.');
    expect(screen.getByTestId('task-timeout').textContent).toBe('30 phút');

    // Dependencies
    expect(screen.getByTestId('task-dep-TSK-001')).toBeDefined();
    expect(screen.getByTestId('task-dep-TSK-002')).toBeDefined();

    // Acceptance criteria
    expect(screen.getByTestId('task-criterion-0').textContent).toBe(
      'Render task metadata and acceptance criteria',
    );
    expect(screen.getByTestId('task-criterion-1').textContent).toBe(
      'Display real execution timeline with attempts and checkpoints',
    );

    // Test commands
    expect(screen.getByTestId('task-test-cmd-0').textContent).toContain(
      'pnpm test apps/dashboard/src/__tests__/task-detail.test.tsx',
    );

    // Scope files
    expect(screen.getByTestId('task-scope-file-0').textContent).toBe(
      'apps/dashboard/src/components/TaskDetail.tsx',
    );
  });

  it('renders real execution timeline with multiple attempts, duration, exit code, and git info', async () => {
    const mockApi = {
      getTask: vi.fn().mockResolvedValue(mockTask),
      getTaskHistory: vi.fn().mockResolvedValue(mockHistory),
      getRunDetail: vi.fn().mockResolvedValue(mockRunDetail2),
    } as unknown as ApiClient;

    render(<TaskDetail taskId="TSK-003" apiClient={mockApi} />);

    await waitFor(() => {
      expect(screen.getByTestId('task-run-timeline')).toBeDefined();
    });

    expect(screen.getByTestId('timeline-summary-bar').textContent).toContain('Tổng: 2 lần chạy');

    // Attempt cards
    const attempt1Card = screen.getByTestId('run-attempt-card-1');
    expect(attempt1Card.textContent).toContain('Attempt #1');
    expect(attempt1Card.textContent).toContain('run-attempt-1');
    expect(attempt1Card.textContent).toContain('ERROR');
    expect(attempt1Card.textContent).toContain('120.00s');
    expect(attempt1Card.textContent).toContain('Exit Code: 1');
    expect(screen.getByTestId('run-error-msg-run-attempt-1').textContent).toContain(
      'Process exited with code 1: typecheck error',
    );

    const attempt2Card = screen.getByTestId('run-attempt-card-2');
    expect(attempt2Card.textContent).toContain('Attempt #2');
    expect(attempt2Card.textContent).toContain('run-attempt-2');
    expect(attempt2Card.textContent).toContain('SUCCESS');
    expect(attempt2Card.textContent).toContain('300.00s');
    expect(attempt2Card.textContent).toContain('Exit Code: 0');
    expect(attempt2Card.textContent).toContain('f6e5d4c');
  });

  it('inspects run deep detail with checkpoints, reports, and event logs', async () => {
    const mockApi = {
      getTask: vi.fn().mockResolvedValue(mockTask),
      getTaskHistory: vi.fn().mockResolvedValue(mockHistory),
      getRunDetail: vi.fn().mockResolvedValue(mockRunDetail2),
    } as unknown as ApiClient;

    render(<TaskDetail taskId="TSK-003" apiClient={mockApi} />);

    await waitFor(() => {
      expect(screen.getByTestId('run-deep-inspector')).toBeDefined();
    });

    expect(screen.getByTestId('inspected-run-id').textContent).toBe('run-attempt-2');

    // Tab 1: Checkpoints
    expect(screen.getByTestId('run-checkpoints-timeline')).toBeDefined();
    expect(screen.getByTestId('checkpoint-step-cp-run2-1').textContent).toBe('run_started');
    expect(screen.getByTestId('checkpoint-step-cp-run2-2').textContent).toBe('test_execution');
    expect(screen.getByTestId('checkpoint-step-cp-run2-3').textContent).toBe('run_completed');

    // Switch to Tab 2: Reports
    const reportsTab = screen.getByTestId('tab-reports');
    fireEvent.click(reportsTab);

    await waitFor(() => {
      expect(screen.getByTestId('run-reports-list')).toBeDefined();
    });
    expect(screen.getByTestId('report-kind-rep-run2-1').textContent).toBe('acceptance');
    expect(screen.getByTestId('report-content-rep-run2-1').textContent).toContain(
      'All 4 acceptance criteria passed',
    );

    // Switch to Tab 3: Events & Logs
    const eventsTab = screen.getByTestId('tab-events');
    fireEvent.click(eventsTab);

    await waitFor(() => {
      expect(screen.getByTestId('run-events-breakdown')).toBeDefined();
    });
    expect(screen.getByTestId('event-stat-stdout').textContent).toBe('stdout: 1');
    expect(screen.getByTestId('event-stat-agent_output').textContent).toBe('agent_output: 1');
    expect(screen.getByTestId('event-stat-result').textContent).toBe('result: 1');
    expect(screen.getByTestId('events-list').textContent).toContain('Starting execution container');
  });

  it('allows clicking another attempt card to inspect that run', async () => {
    const mockGetRunDetail = vi.fn().mockImplementation((runId: string) => {
      if (runId === 'run-attempt-1') return Promise.resolve(mockRunDetail1);
      return Promise.resolve(mockRunDetail2);
    });

    const mockApi = {
      getTask: vi.fn().mockResolvedValue(mockTask),
      getTaskHistory: vi.fn().mockResolvedValue(mockHistory),
      getRunDetail: mockGetRunDetail,
    } as unknown as ApiClient;

    render(<TaskDetail taskId="TSK-003" apiClient={mockApi} />);

    await waitFor(() => {
      expect(screen.getByTestId('inspected-run-id').textContent).toBe('run-attempt-2');
    });

    // Click inspect Attempt #1
    const inspectBtn1 = screen.getByTestId('btn-inspect-run-run-attempt-1');
    fireEvent.click(inspectBtn1);

    await waitFor(() => {
      expect(screen.getByTestId('inspected-run-id').textContent).toBe('run-attempt-1');
    });

    expect(screen.getByTestId('checkpoint-step-cp-run1-1').textContent).toBe('run_started');
    expect(screen.getByTestId('checkpoint-step-cp-run1-2').textContent).toBe('run_failed');
  });

  it('renders empty timeline state when task has 0 attempts', async () => {
    const unexecutedTask: TaskWithDependencies = {
      ...mockTask,
      id: 'TSK-EMPTY',
      status: 'TODO',
      attempts: 0,
    };
    const emptyHistory: TaskRunHistory = {
      taskId: 'TSK-EMPTY',
      taskTitle: mockTask.title,
      taskStatus: 'TODO',
      attempts: 0,
      maxAttempts: 3,
      latestRun: null,
      latestCheckpoint: null,
      history: [],
    };

    const mockApi = {
      getTask: vi.fn().mockResolvedValue(unexecutedTask),
      getTaskHistory: vi.fn().mockResolvedValue(emptyHistory),
      getRunDetail: vi.fn(),
    } as unknown as ApiClient;

    render(<TaskDetail taskId="TSK-EMPTY" apiClient={mockApi} />);

    await waitFor(() => {
      expect(screen.getByTestId('empty-timeline-state')).toBeDefined();
    });

    expect(screen.getByText(/Chưa có lần chạy nào/i)).toBeDefined();
    expect(screen.getByText(/chưa được worker điều phối thực thi/i)).toBeDefined();
  });

  it('renders error banner and allows retry when API fails', async () => {
    const mockGetTask = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network connection timeout'))
      .mockResolvedValueOnce(mockTask);
    const mockGetHistory = vi.fn().mockResolvedValue(mockHistory);
    const mockGetRunDetail = vi.fn().mockResolvedValue(mockRunDetail2);

    const mockApi = {
      getTask: mockGetTask,
      getTaskHistory: mockGetHistory,
      getRunDetail: mockGetRunDetail,
    } as unknown as ApiClient;

    render(<TaskDetail taskId="TSK-003" apiClient={mockApi} />);

    await waitFor(() => {
      expect(screen.getByTestId('task-error-banner')).toBeDefined();
    });

    expect(screen.getByText(/Network connection timeout/i)).toBeDefined();

    // Click Retry
    const retryBtn = screen.getByTestId('btn-retry-task');
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.getByTestId('task-detail-view')).toBeDefined();
    });

    expect(screen.getByTestId('task-title').textContent).toBe(mockTask.title);
  });

  it('refreshes task data when refresh button is clicked', async () => {
    const mockApi = {
      getTask: vi.fn().mockResolvedValue(mockTask),
      getTaskHistory: vi.fn().mockResolvedValue(mockHistory),
      getRunDetail: vi.fn().mockResolvedValue(mockRunDetail2),
    } as unknown as ApiClient;

    render(<TaskDetail taskId="TSK-003" apiClient={mockApi} />);

    await waitFor(() => {
      expect(screen.getByTestId('task-title')).toBeDefined();
    });

    const refreshBtn = screen.getByTestId('btn-refresh-task');
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(mockApi.getTask).toHaveBeenCalledTimes(2);
      expect(mockApi.getTaskHistory).toHaveBeenCalledTimes(2);
    });
  });

  it('switches to Live Logs (SSE) tab and renders LiveLogViewer container', async () => {
    const mockApi = {
      getTask: vi.fn().mockResolvedValue(mockTask),
      getTaskHistory: vi.fn().mockResolvedValue(mockHistory),
      getRunDetail: vi.fn().mockResolvedValue(mockRunDetail2),
      subscribeToRunStream: vi.fn().mockReturnValue(() => {}),
    } as unknown as ApiClient;

    render(<TaskDetail taskId="TSK-003" apiClient={mockApi} />);

    await waitFor(() => {
      expect(screen.getByTestId('tab-live')).toBeDefined();
    });

    const tabLive = screen.getByTestId('tab-live');
    fireEvent.click(tabLive);

    await waitFor(() => {
      expect(screen.getByTestId('run-live-logs-container')).toBeDefined();
      expect(screen.getByTestId('live-log-viewer')).toBeDefined();
      expect(mockApi.subscribeToRunStream).toHaveBeenCalledWith(
        'run-attempt-2',
        expect.any(Object),
        expect.any(Object),
      );
    });
  });

  it('TaskDetailPage App Router page wrapper renders TaskDetail correctly', async () => {
    const mockApi = {
      getTask: vi.fn().mockResolvedValue(mockTask),
      getTaskHistory: vi.fn().mockResolvedValue(mockHistory),
      getRunDetail: vi.fn().mockResolvedValue(mockRunDetail2),
    } as unknown as ApiClient;

    render(<TaskDetailPage params={{ id: 'TSK-003' }} apiClient={mockApi} />);

    expect(screen.getByTestId('dashboard-task-detail-page')).toBeDefined();
    await waitFor(() => {
      expect(screen.getByTestId('task-id-badge').textContent).toBe('TSK-003');
    });
  });
});
