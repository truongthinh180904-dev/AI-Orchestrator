/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { TaskFeatureDashboard } from '../components/TaskFeatureDashboard.js';
import { StatusBadge, getStatusStyle } from '../components/StatusBadge.js';
import { ApiClient } from '../lib/api.js';
import type { TaskWithDependencies, Feature } from '@ai-orchestrator/shared';

const mockTasks: TaskWithDependencies[] = [
  {
    id: 'TSK-001',
    feature_id: 'FEAT-001',
    plan_id: null,
    title: 'Setup task database schema',
    description: 'Create SQLite schema and zod models',
    phase: 'TSK',
    worker_type: 'agy',
    repository: '.',
    scope_files: ['packages/db/src/index.ts'],
    acceptance_criteria: ['CRUD operations pass'],
    test_commands: ['pnpm test'],
    priority: 1,
    max_attempts: 3,
    timeout_minutes: 30,
    status: 'DONE',
    attempts: 1,
    dependencies: [],
    created_at: '2026-10-23T00:00:00Z',
    updated_at: '2026-10-23T01:00:00Z',
  },
  {
    id: 'TSK-002',
    feature_id: 'FEAT-001',
    plan_id: null,
    title: 'Excel CSV parser',
    description: 'Parse 3 sheets with validation',
    phase: 'TSK',
    worker_type: 'agy',
    repository: '.',
    scope_files: ['apps/orchestrator/src/services/import-service.ts'],
    acceptance_criteria: ['Reads sample file correctly'],
    test_commands: ['pnpm test'],
    priority: 2,
    max_attempts: 3,
    timeout_minutes: 30,
    status: 'RUNNING',
    attempts: 1,
    dependencies: ['TSK-001'],
    created_at: '2026-10-23T01:00:00Z',
    updated_at: '2026-10-23T02:00:00Z',
  },
  {
    id: 'TSK-003',
    feature_id: 'FEAT-002',
    plan_id: null,
    title: 'Detect cycle in dependency graph',
    description: 'Use Kahn algorithm or DFS',
    phase: 'TSK',
    worker_type: 'agy',
    repository: '.',
    scope_files: [],
    acceptance_criteria: ['Rejects cyclic graphs'],
    test_commands: [],
    priority: 0,
    max_attempts: 3,
    timeout_minutes: 30,
    status: 'FAILED',
    attempts: 3,
    dependencies: ['TSK-002'],
    created_at: '2026-10-23T02:00:00Z',
    updated_at: '2026-10-23T03:00:00Z',
  },
];

const mockFeatures: Feature[] = [
  {
    id: 'FEAT-001',
    name: 'Task Import System',
    description: 'Import tasks from Excel or CSV files',
    required_tasks: ['TSK-001', 'TSK-002'],
    integration_tests: ['pnpm test import'],
    release_policy: 'strict',
    status: 'IN_PROGRESS',
    created_at: '2026-10-23T00:00:00Z',
    updated_at: '2026-10-23T01:00:00Z',
  },
  {
    id: 'FEAT-002',
    name: 'Dependency Resolver',
    description: 'Topological sort and ready task determination',
    required_tasks: ['TSK-003'],
    integration_tests: [],
    release_policy: null,
    status: 'TODO',
    created_at: '2026-10-23T01:00:00Z',
    updated_at: '2026-10-23T02:00:00Z',
  },
];

describe('StatusBadge Component (UI-002)', () => {
  it('renders correct label and styles for different statuses', () => {
    const { rerender } = render(<StatusBadge status="DONE" />);
    expect(screen.getByTestId('status-badge-done').textContent).toBe('DONE');

    rerender(<StatusBadge status="RUNNING" />);
    expect(screen.getByTestId('status-badge-running').textContent).toBe('RUNNING');

    rerender(<StatusBadge status="FAILED" />);
    expect(screen.getByTestId('status-badge-failed').textContent).toBe('FAILED');

    rerender(<StatusBadge status="TODO" />);
    expect(screen.getByTestId('status-badge-todo').textContent).toBe('TODO');
  });

  it('getStatusStyle returns correct colors', () => {
    expect(getStatusStyle('DONE').bg).toBe('#dcfce7');
    expect(getStatusStyle('FAILED').bg).toBe('#fee2e2');
    expect(getStatusStyle('RUNNING').bg).toBe('#dbeafe');
    expect(getStatusStyle('TODO').bg).toBe('#f8fafc');
  });
});

describe('TaskFeatureDashboard Component (UI-002)', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders tasks and features loaded from ApiClient', async () => {
    const mockGetTasks = vi.fn().mockResolvedValue(mockTasks);
    const mockGetFeatures = vi.fn().mockResolvedValue(mockFeatures);
    const mockApi = {
      getTasks: mockGetTasks,
      getFeatures: mockGetFeatures,
    } as unknown as ApiClient;

    render(<TaskFeatureDashboard apiClient={mockApi} />);

    expect(screen.getByTestId('task-feature-dashboard')).toBeDefined();

    await waitFor(() => {
      expect(screen.getByTestId('tasks-table')).toBeDefined();
    });

    expect(mockGetTasks).toHaveBeenCalledTimes(1);
    expect(mockGetFeatures).toHaveBeenCalledTimes(1);

    // Verify task rows
    expect(screen.getByTestId('task-row-TSK-001')).toBeDefined();
    expect(screen.getByTestId('task-title-TSK-001').textContent).toBe('Setup task database schema');
    expect(screen.getByTestId('task-phase-TSK-001').textContent).toBe('Phase TSK');
    expect(screen.getByTestId('task-feature-TSK-001').textContent).toBe('FEAT-001');

    expect(screen.getByTestId('task-row-TSK-002')).toBeDefined();
    expect(screen.getByTestId('task-dependencies-TSK-002').textContent).toBe('TSK-001');

    // Verify task metrics
    expect(screen.getByTestId('metric-total-tasks').textContent).toContain('3');
    expect(screen.getByTestId('metric-done-tasks').textContent).toContain('1');
    expect(screen.getByTestId('metric-running-tasks').textContent).toContain('1');
    expect(screen.getByTestId('metric-failed-tasks').textContent).toContain('1');
  });

  it('switches between Tasks and Features tabs', async () => {
    const mockGetTasks = vi.fn().mockResolvedValue(mockTasks);
    const mockGetFeatures = vi.fn().mockResolvedValue(mockFeatures);
    const mockApi = {
      getTasks: mockGetTasks,
      getFeatures: mockGetFeatures,
    } as unknown as ApiClient;

    render(<TaskFeatureDashboard apiClient={mockApi} />);

    await waitFor(() => {
      expect(screen.getByTestId('tasks-table')).toBeDefined();
    });

    // Click on Features tab
    fireEvent.click(screen.getByTestId('tab-features'));

    await waitFor(() => {
      expect(screen.getByTestId('features-table')).toBeDefined();
    });

    // Check features table rows
    expect(screen.getByTestId('feature-row-FEAT-001')).toBeDefined();
    expect(screen.getByTestId('feature-name-FEAT-001').textContent).toBe('Task Import System');
    expect(screen.getByTestId('feature-required-tasks-FEAT-001').textContent).toContain('TSK-001');
    expect(screen.getByTestId('feature-required-tasks-FEAT-001').textContent).toContain('TSK-002');
    expect(screen.getByTestId('feature-tests-FEAT-001').textContent).toContain('pnpm test import');

    expect(screen.getByTestId('feature-row-FEAT-002')).toBeDefined();

    // Check feature metrics
    expect(screen.getByTestId('metric-total-features').textContent).toContain('2');
    expect(screen.getByTestId('metric-inprogress-features').textContent).toContain('1');
    expect(screen.getByTestId('metric-todo-features').textContent).toContain('1');
  });

  it('applies task status filter and re-queries API', async () => {
    const mockGetTasks = vi.fn().mockImplementation((filter?: { status?: string }) => {
      if (filter?.status === 'DONE') {
        return Promise.resolve(mockTasks.filter((t) => t.status === 'DONE'));
      }
      return Promise.resolve(mockTasks);
    });
    const mockGetFeatures = vi.fn().mockResolvedValue(mockFeatures);
    const mockApi = {
      getTasks: mockGetTasks,
      getFeatures: mockGetFeatures,
    } as unknown as ApiClient;

    render(<TaskFeatureDashboard apiClient={mockApi} />);

    await waitFor(() => {
      expect(mockGetTasks).toHaveBeenCalledTimes(1);
    });

    const statusSelect = screen.getByTestId('filter-task-status');
    fireEvent.change(statusSelect, { target: { value: 'DONE' } });

    await waitFor(() => {
      expect(mockGetTasks).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'DONE',
        }),
      );
    });

    // After filtering DONE, only TSK-001 should be rendered
    await waitFor(() => {
      expect(screen.getByTestId('task-row-TSK-001')).toBeDefined();
      expect(screen.queryByTestId('task-row-TSK-002')).toBeNull();
      expect(screen.queryByTestId('task-row-TSK-003')).toBeNull();
    });
  });

  it('applies task search query and re-queries API', async () => {
    const mockGetTasks = vi.fn().mockImplementation((filter?: { search?: string }) => {
      if (filter?.search === 'parser') {
        return Promise.resolve(mockTasks.filter((t) => t.title.toLowerCase().includes('parser')));
      }
      return Promise.resolve(mockTasks);
    });
    const mockGetFeatures = vi.fn().mockResolvedValue(mockFeatures);
    const mockApi = {
      getTasks: mockGetTasks,
      getFeatures: mockGetFeatures,
    } as unknown as ApiClient;

    render(<TaskFeatureDashboard apiClient={mockApi} />);

    await waitFor(() => {
      expect(mockGetTasks).toHaveBeenCalledTimes(1);
    });

    const searchInput = screen.getByTestId('filter-task-search');
    fireEvent.change(searchInput, { target: { value: 'parser' } });

    await waitFor(() => {
      expect(mockGetTasks).toHaveBeenCalledWith(
        expect.objectContaining({
          search: 'parser',
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('task-row-TSK-002')).toBeDefined();
      expect(screen.queryByTestId('task-row-TSK-001')).toBeNull();
    });
  });

  it('clears filters when reset filters button is clicked', async () => {
    const mockGetTasks = vi.fn().mockResolvedValue(mockTasks);
    const mockGetFeatures = vi.fn().mockResolvedValue(mockFeatures);
    const mockApi = {
      getTasks: mockGetTasks,
      getFeatures: mockGetFeatures,
    } as unknown as ApiClient;

    render(<TaskFeatureDashboard apiClient={mockApi} />);

    await waitFor(() => {
      expect(mockGetTasks).toHaveBeenCalledTimes(1);
    });

    const statusSelect = screen.getByTestId('filter-task-status');
    fireEvent.change(statusSelect, { target: { value: 'FAILED' } });

    const resetBtn = screen.getByTestId('btn-reset-filters');
    expect(resetBtn.hasAttribute('disabled')).toBe(false);

    fireEvent.click(resetBtn);

    await waitFor(() => {
      expect((screen.getByTestId('filter-task-status') as HTMLSelectElement).value).toBe('');
    });
  });

  it('displays empty state when no tasks match filter', async () => {
    const mockGetTasks = vi.fn().mockResolvedValue([]);
    const mockGetFeatures = vi.fn().mockResolvedValue(mockFeatures);
    const mockApi = {
      getTasks: mockGetTasks,
      getFeatures: mockGetFeatures,
    } as unknown as ApiClient;

    render(<TaskFeatureDashboard apiClient={mockApi} />);

    await waitFor(() => {
      expect(screen.getByTestId('empty-tasks-state')).toBeDefined();
    });

    expect(screen.getByTestId('empty-tasks-state').textContent).toContain(
      'Không tìm thấy tác vụ nào',
    );
  });

  it('displays error banner and allows retry when API call fails', async () => {
    const mockGetTasks = vi
      .fn()
      .mockRejectedValueOnce(new Error('Network disconnected'))
      .mockResolvedValueOnce(mockTasks);
    const mockGetFeatures = vi.fn().mockResolvedValue(mockFeatures);
    const mockApi = {
      getTasks: mockGetTasks,
      getFeatures: mockGetFeatures,
    } as unknown as ApiClient;

    render(<TaskFeatureDashboard apiClient={mockApi} />);

    await waitFor(() => {
      expect(screen.getByTestId('error-banner')).toBeDefined();
      expect(screen.getByTestId('error-banner').textContent).toContain('Network disconnected');
    });

    const retryBtn = screen.getByTestId('btn-retry');
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.queryByTestId('error-banner')).toBeNull();
      expect(screen.getByTestId('tasks-table')).toBeDefined();
    });
  });

  it('re-fetches from API when refresh button is clicked', async () => {
    const mockGetTasks = vi.fn().mockResolvedValue(mockTasks);
    const mockGetFeatures = vi.fn().mockResolvedValue(mockFeatures);
    const mockApi = {
      getTasks: mockGetTasks,
      getFeatures: mockGetFeatures,
    } as unknown as ApiClient;

    render(<TaskFeatureDashboard apiClient={mockApi} />);

    await waitFor(() => {
      expect(mockGetTasks).toHaveBeenCalledTimes(1);
    });

    const refreshBtn = screen.getByTestId('btn-refresh');
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(mockGetTasks).toHaveBeenCalledTimes(2);
      expect(mockGetFeatures).toHaveBeenCalledTimes(2);
    });
  });
});
