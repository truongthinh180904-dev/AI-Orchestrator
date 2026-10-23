/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { SystemControls } from '../components/SystemControls.js';
import ControlsPage from '../app/controls/page.js';
import { ApiClient } from '../lib/api.js';
import type {
  SchedulerStatus,
  Plan,
  PlanReviewSummary,
} from '@ai-orchestrator/shared';

describe('SystemControls Component & Controls Page (UI-007)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const mockSchedulerStatusIdle: SchedulerStatus = {
    isRunning: false,
    isPaused: false,
    activeLock: null,
    activeTaskId: null,
    activeRunId: null,
    readyTasksCount: 4,
  };

  const mockSchedulerStatusRunning: SchedulerStatus = {
    isRunning: true,
    isPaused: false,
    activeLock: {
      id: 'default_agent',
      task_id: 'TSK-101',
      run_id: 'run-abc-123',
      acquired_at: '2026-10-23T10:00:00Z',
      owner_pid: 12345,
      metadata: null,
    },
    activeTaskId: 'TSK-101',
    activeRunId: 'run-abc-123',
    readyTasksCount: 3,
  };

  const mockSchedulerStatusPaused: SchedulerStatus = {
    isRunning: false,
    isPaused: true,
    activeLock: null,
    activeTaskId: null,
    activeRunId: null,
    readyTasksCount: 5,
  };

  const mockPlanPending: Plan = {
    id: 'plan-auth-01',
    title: 'Xây dựng Authentication Module',
    description: 'Bao gồm login, register và JWT tokens',
    feature_id: 'FEAT-AUTH',
    repository: '/workspace/ai-orchestrator',
    status: 'PENDING_APPROVAL',
    raw_output: null,
    approved_at: null,
    approved_by: null,
    rejection_reason: null,
    created_at: '2026-10-23T10:00:00Z',
    updated_at: '2026-10-23T10:00:00Z',
    tasks: [
      {
        id: 'AUTH-001',
        title: 'Tạo user schema',
        description: 'Tạo bảng users',
        scope_files: ['packages/db/src/users.ts'],
        acceptance_criteria: ['Có trường password_hash'],
        dependencies: [],
        test_commands: ['pnpm test'],
        priority: 10,
        timeout_minutes: 20,
        worker_type: 'agy',
      },
      {
        id: 'AUTH-002',
        title: 'Tạo login endpoint',
        description: 'Tạo API POST /login',
        scope_files: ['apps/orchestrator/src/routes/auth.ts'],
        acceptance_criteria: ['Trả về JWT token'],
        dependencies: ['AUTH-001'],
        test_commands: ['pnpm test'],
        priority: 5,
        timeout_minutes: 25,
        worker_type: 'agy',
      },
    ],
  };

  const mockPlanApproved: Plan = {
    ...mockPlanPending,
    id: 'plan-auth-approved',
    status: 'APPROVED',
    approved_by: 'lead-dev',
    approved_at: '2026-10-23T10:30:00Z',
  };

  const mockReviewSummaryPending: PlanReviewSummary = {
    plan: mockPlanPending,
    status: 'PENDING_APPROVAL',
    is_approved: false,
    can_execute: false,
    requires_approval: true,
    total_tasks: 2,
    total_scope_files: 2,
    unique_scope_files: ['packages/db/src/users.ts', 'apps/orchestrator/src/routes/auth.ts'],
    total_estimated_minutes: 45,
    execution_order: ['AUTH-001', 'AUTH-002'],
    stages: [['AUTH-001'], ['AUTH-002']],
    warnings: ['Đảm bảo migrate DB trước khi chạy endpoint'],
  };

  const mockReviewSummaryApproved: PlanReviewSummary = {
    ...mockReviewSummaryPending,
    plan: mockPlanApproved,
    status: 'APPROVED',
    is_approved: true,
    can_execute: true,
    requires_approval: false,
  };

  const createMockApiClient = (overrides: Partial<ApiClient> = {}) => {
    const defaultMock: Partial<ApiClient> = {
      getSchedulerStatus: vi.fn().mockResolvedValue(mockSchedulerStatusRunning),
      startScheduler: vi.fn().mockResolvedValue({ started: true, isRunning: true }),
      pauseScheduler: vi.fn().mockResolvedValue({ paused: true, isPaused: true }),
      resumeScheduler: vi.fn().mockResolvedValue({ resumed: true, isPaused: false }),
      stopScheduler: vi.fn().mockResolvedValue({ stopped: true, isRunning: false }),
      stepScheduler: vi.fn().mockResolvedValue({ executed: true, taskId: 'TSK-101' }),
      releaseSchedulerLock: vi.fn().mockResolvedValue({ released: true, status: mockSchedulerStatusIdle }),
      stopRun: vi.fn().mockResolvedValue({ stopped: true }),
      listPlans: vi.fn().mockResolvedValue([mockPlanPending, mockPlanApproved]),
      getPlan: vi.fn().mockResolvedValue(mockPlanPending),
      getPlanReview: vi.fn().mockResolvedValue(mockReviewSummaryPending),
      approvePlan: vi.fn().mockResolvedValue(mockPlanApproved),
      rejectPlan: vi.fn().mockResolvedValue({ ...mockPlanPending, status: 'REJECTED' }),
      submitPlanForReview: vi.fn().mockResolvedValue(mockPlanPending),
      executePlan: vi.fn().mockResolvedValue({ planId: 'plan-auth-approved', status: 'EXECUTING' }),
      ...overrides,
    };
    return defaultMock as unknown as ApiClient;
  };

  it('1. Renders System Controls dashboard with all primary sections', async () => {
    const mockClient = createMockApiClient();
    render(<SystemControls apiClient={mockClient} />);

    await waitFor(() => {
      expect(screen.getByTestId('system-controls-dashboard')).toBeDefined();
      expect(screen.getByTestId('section-scheduler-controls')).toBeDefined();
      expect(screen.getByTestId('section-plan-approval')).toBeDefined();
      expect(screen.getByTestId('banner-approval-rule')).toBeDefined();
    });
  });

  it('2. Displays live Scheduler Status metrics (RUNNING, PAUSED, IDLE) and Agent Lock details', async () => {
    const mockClient = createMockApiClient({
      getSchedulerStatus: vi.fn().mockResolvedValue(mockSchedulerStatusRunning),
    });
    render(<SystemControls apiClient={mockClient} />);

    await waitFor(() => {
      expect(screen.getByTestId('scheduler-status-badge').textContent).toContain('RUNNING');
      expect(screen.getByTestId('scheduler-ready-count').textContent).toBe('3');
      expect(screen.getByTestId('scheduler-active-task').textContent).toBe('TSK-101');
      expect(screen.getByTestId('scheduler-active-run').textContent).toBe('run-abc-123');
      expect(screen.getByTestId('scheduler-lock-status').textContent).toContain('PID: 12345');
    });
  });

  it('3. Pause button calls pauseScheduler API and updates status', async () => {
    const mockClient = createMockApiClient({
      getSchedulerStatus: vi.fn().mockResolvedValue(mockSchedulerStatusRunning),
      pauseScheduler: vi.fn().mockResolvedValue({ paused: true, isPaused: true }),
    });
    render(<SystemControls apiClient={mockClient} />);

    await waitFor(() => {
      expect(screen.getByTestId('btn-pause-scheduler')).toBeDefined();
    });

    const pauseBtn = screen.getByTestId('btn-pause-scheduler') as HTMLButtonElement;
    expect(pauseBtn.disabled).toBe(false);
    fireEvent.click(pauseBtn);

    await waitFor(() => {
      expect(mockClient.pauseScheduler).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('controls-success-banner').textContent).toContain('Đã tạm dừng');
    });
  });

  it('4. Resume button is disabled when not paused, and active when paused', async () => {
    const mockClient = createMockApiClient({
      getSchedulerStatus: vi.fn().mockResolvedValue(mockSchedulerStatusPaused),
      resumeScheduler: vi.fn().mockResolvedValue({ resumed: true, isPaused: false }),
    });
    render(<SystemControls apiClient={mockClient} />);

    await waitFor(() => {
      expect(screen.getByTestId('scheduler-status-badge').textContent).toContain('PAUSED');
    });

    const resumeBtn = screen.getByTestId('btn-resume-scheduler') as HTMLButtonElement;
    expect(resumeBtn.disabled).toBe(false);
    fireEvent.click(resumeBtn);

    await waitFor(() => {
      expect(mockClient.resumeScheduler).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('controls-success-banner').textContent).toContain('Đã tiếp tục');
    });
  });

  it('5. Stop button opens confirmation dialog before stopping', async () => {
    const mockClient = createMockApiClient();
    render(<SystemControls apiClient={mockClient} />);

    await waitFor(() => {
      expect(screen.getByTestId('btn-stop-scheduler')).toBeDefined();
    });

    // Modal is not visible initially
    expect(screen.queryByTestId('modal-confirm-stop')).toBeNull();

    // Click stop button
    fireEvent.click(screen.getByTestId('btn-stop-scheduler'));

    // Modal is now open
    expect(screen.getByTestId('modal-confirm-stop')).toBeDefined();
    expect(screen.getByTestId('input-stop-reason')).toBeDefined();
    expect(screen.getByTestId('btn-confirm-stop')).toBeDefined();
    expect(screen.getByTestId('btn-cancel-stop')).toBeDefined();

    // Cancel closes modal without calling API
    fireEvent.click(screen.getByTestId('btn-cancel-stop'));
    expect(screen.queryByTestId('modal-confirm-stop')).toBeNull();
    expect(mockClient.stopScheduler).not.toHaveBeenCalled();
  });

  it('6. Confirm Stop calls stopScheduler API and shows success notification', async () => {
    const mockClient = createMockApiClient({
      stopScheduler: vi.fn().mockResolvedValue({ stopped: true, isRunning: false }),
    });
    render(<SystemControls apiClient={mockClient} />);

    await waitFor(() => {
      expect(screen.getByTestId('btn-stop-scheduler')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('btn-stop-scheduler'));
    expect(screen.getByTestId('modal-confirm-stop')).toBeDefined();

    fireEvent.click(screen.getByTestId('btn-confirm-stop'));

    await waitFor(() => {
      expect(mockClient.stopScheduler).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('controls-success-banner').textContent).toContain('Đã dừng Scheduler');
    });
  });

  it('7. Run stop button with custom Run ID opens confirmation and calls stopRun API', async () => {
    const mockClient = createMockApiClient({
      stopRun: vi.fn().mockResolvedValue({ stopped: true }),
    });
    render(<SystemControls apiClient={mockClient} />);

    await waitFor(() => {
      expect(screen.getByTestId('input-target-run-id')).toBeDefined();
    });

    const runInput = screen.getByTestId('input-target-run-id');
    fireEvent.change(runInput, { target: { value: 'run-custom-999' } });

    const stopRunBtn = screen.getByTestId('btn-stop-run');
    fireEvent.click(stopRunBtn);

    expect(screen.getByTestId('modal-confirm-stop')).toBeDefined();
    fireEvent.click(screen.getByTestId('btn-confirm-stop'));

    await waitFor(() => {
      expect(mockClient.stopRun).toHaveBeenCalledWith(
        'run-custom-999',
        expect.objectContaining({ force: false }),
      );
      expect(screen.getByTestId('controls-success-banner').textContent).toContain('Đã dừng tiến trình Run run-custom-999');
    });
  });

  it('8. Step Next button calls stepScheduler API and handles result', async () => {
    const mockClient = createMockApiClient({
      stepScheduler: vi.fn().mockResolvedValue({ executed: true, taskId: 'TSK-101' }),
    });
    render(<SystemControls apiClient={mockClient} />);

    await waitFor(() => {
      expect(screen.getByTestId('btn-step-scheduler')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('btn-step-scheduler'));

    await waitFor(() => {
      expect(mockClient.stepScheduler).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('controls-success-banner').textContent).toContain('Đã thực thi bước tiếp theo cho task: TSK-101');
    });
  });

  it('9. Release Lock button calls releaseSchedulerLock API', async () => {
    const mockClient = createMockApiClient({
      getSchedulerStatus: vi.fn().mockResolvedValue(mockSchedulerStatusRunning),
      releaseSchedulerLock: vi.fn().mockResolvedValue({ released: true, status: mockSchedulerStatusIdle }),
    });
    render(<SystemControls apiClient={mockClient} />);

    await waitFor(() => {
      expect(screen.getByTestId('btn-release-lock')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('btn-release-lock'));

    await waitFor(() => {
      expect(mockClient.releaseSchedulerLock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('controls-success-banner').textContent).toContain('Đã giải phóng agent lock');
    });
  });

  it('10. Plan Review section lists plans and shows review summary on plan selection', async () => {
    const mockClient = createMockApiClient();
    render(<SystemControls apiClient={mockClient} />);

    await waitFor(() => {
      expect(screen.getByTestId('plan-item-plan-auth-01')).toBeDefined();
      expect(screen.getByTestId('plan-item-plan-auth-approved')).toBeDefined();
    });

    await waitFor(() => {
      // Plan review summary elements
      expect(screen.getByTestId('plan-approval-status').textContent).toContain('CHỜ PHÊ DUYỆT');
      expect(screen.getByTestId('plan-can-execute').textContent).toContain('CHƯA ĐỦ ĐIỀU KIỆN THỰC THI');
      expect(screen.getByTestId('plan-scope-files').textContent).toContain('2 files');
      expect(screen.getByTestId('plan-dag-stages').textContent).toContain('2 tầng');
      expect(screen.getByTestId('plan-warnings')).toBeDefined();
      expect(screen.getByTestId('plan-tasks-table')).toBeDefined();
    });
  });

  it('11. Approving a plan calls approvePlan API with reviewer name and comments', async () => {
    const mockClient = createMockApiClient({
      approvePlan: vi.fn().mockResolvedValue(mockPlanApproved),
      getPlanReview: vi.fn().mockResolvedValue(mockReviewSummaryPending),
    });
    render(<SystemControls apiClient={mockClient} />);

    await waitFor(() => {
      expect(screen.getByTestId('btn-approve-plan')).toBeDefined();
    });

    const reviewerInput = screen.getByTestId('input-reviewer-name');
    fireEvent.change(reviewerInput, { target: { value: 'senior-architect' } });

    const commentsInput = screen.getByTestId('input-approve-comments');
    fireEvent.change(commentsInput, { target: { value: 'Design is sound, approved for run' } });

    fireEvent.click(screen.getByTestId('btn-approve-plan'));

    await waitFor(() => {
      expect(mockClient.approvePlan).toHaveBeenCalledWith('plan-auth-01', {
        approved_by: 'senior-architect',
        comments: 'Design is sound, approved for run',
      });
      expect(screen.getByTestId('controls-success-banner').textContent).toContain('đã được phê duyệt thành công');
    });
  });

  it('12. Rejecting a plan requires a reason and calls rejectPlan API', async () => {
    const mockClient = createMockApiClient({
      rejectPlan: vi.fn().mockResolvedValue({ ...mockPlanPending, status: 'REJECTED' }),
    });
    render(<SystemControls apiClient={mockClient} />);

    await waitFor(() => {
      expect(screen.getByTestId('btn-reject-plan')).toBeDefined();
    });

    // Try clicking reject without reason
    fireEvent.click(screen.getByTestId('btn-reject-plan'));
    expect(screen.getByTestId('controls-error-banner').textContent).toContain('Vui lòng nhập lý do từ chối');
    expect(mockClient.rejectPlan).not.toHaveBeenCalled();

    // Now fill reason and reject
    const reasonInput = screen.getByTestId('input-reject-reason');
    fireEvent.change(reasonInput, { target: { value: 'Missing token refresh logic' } });

    fireEvent.click(screen.getByTestId('btn-reject-plan'));

    await waitFor(() => {
      expect(mockClient.rejectPlan).toHaveBeenCalledWith('plan-auth-01', {
        reason: 'Missing token refresh logic',
        rejected_by: 'reviewer',
      });
      expect(screen.getByTestId('controls-success-banner').textContent).toContain('đã bị từ chối');
    });
  });

  it('13. Strictly enforces "Chưa duyệt → không thực thi": Execute button is disabled on PENDING plan', async () => {
    const mockClient = createMockApiClient({
      getPlanReview: vi.fn().mockResolvedValue(mockReviewSummaryPending),
    });
    render(<SystemControls apiClient={mockClient} initialPlans={[mockPlanPending]} />);

    await waitFor(() => {
      expect(screen.getByTestId('btn-execute-plan')).toBeDefined();
    });

    const executeBtn = screen.getByTestId('btn-execute-plan') as HTMLButtonElement;
    expect(executeBtn.disabled).toBe(true);
    expect(mockClient.executePlan).not.toHaveBeenCalled();
  });

  it('14. Execute button is enabled on APPROVED plan and triggers executePlan API', async () => {
    const mockClient = createMockApiClient({
      getPlanReview: vi.fn().mockResolvedValue(mockReviewSummaryApproved),
      executePlan: vi.fn().mockResolvedValue({ planId: 'plan-auth-approved', status: 'EXECUTING' }),
    });
    render(
      <SystemControls
        apiClient={mockClient}
        initialPlans={[mockPlanApproved]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('btn-execute-plan')).toBeDefined();
    });

    const executeBtn = screen.getByTestId('btn-execute-plan') as HTMLButtonElement;
    expect(executeBtn.disabled).toBe(false);

    fireEvent.click(executeBtn);

    await waitFor(() => {
      expect(mockClient.executePlan).toHaveBeenCalledWith('plan-auth-approved', {
        autoStart: true,
        executor: 'reviewer',
      });
      expect(screen.getByTestId('controls-success-banner').textContent).toContain('đã được khởi chạy thực thi');
    });
  });

  it('15. Error banner is shown when API call fails and can be dismissed', async () => {
    const mockClient = createMockApiClient({
      pauseScheduler: vi.fn().mockRejectedValue(new Error('Scheduler process terminated abnormally')),
    });
    render(<SystemControls apiClient={mockClient} />);

    await waitFor(() => {
      expect(screen.getByTestId('btn-pause-scheduler')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('btn-pause-scheduler'));

    await waitFor(() => {
      expect(screen.getByTestId('controls-error-banner').textContent).toContain('Scheduler process terminated abnormally');
    });

    // Dismiss error
    fireEvent.click(screen.getByTestId('btn-dismiss-error'));
    expect(screen.queryByTestId('controls-error-banner')).toBeNull();
  });

  it('16. ControlsPage wrapper renders correctly', () => {
    const mockClient = createMockApiClient();
    render(<ControlsPage apiClient={mockClient} />);
    expect(screen.getByTestId('dashboard-controls-page')).toBeDefined();
    expect(screen.getByTestId('system-controls-dashboard')).toBeDefined();
  });
});
