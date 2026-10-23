/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ReleaseDashboard } from '../components/ReleaseDashboard.js';
import ReleasesPage from '../app/releases/page.js';
import { ApiClient } from '../lib/api.js';
import type {
  FeatureRelease,
  FeatureReleaseReportResult,
  FeatureReleaseCheckResult,
  Feature,
} from '@ai-orchestrator/shared';

describe('ReleaseDashboard Component & Releases Page (UI-008)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const mockFeatures: Feature[] = [
    {
      id: 'FEAT-001',
      name: 'Authentication Module',
      description: 'Hệ thống đăng nhập và bảo mật',
      required_tasks: ['TSK-001', 'TSK-002'],
      integration_tests: ['pnpm test:auth'],
      release_policy: 'standard',
      status: 'DONE',
      created_at: '2026-10-23T08:00:00Z',
      updated_at: '2026-10-23T09:00:00Z',
    },
    {
      id: 'FEAT-002',
      name: 'Payment Processing',
      description: 'Cổng thanh toán thẻ tín dụng',
      required_tasks: ['TSK-003'],
      integration_tests: [],
      release_policy: null,
      status: 'DONE',
      created_at: '2026-10-23T09:00:00Z',
      updated_at: '2026-10-23T10:00:00Z',
    },
  ];

  const mockReleases: FeatureRelease[] = [
    {
      id: 'rel-auth-123',
      feature_id: 'FEAT-001',
      branch: 'feature/FEAT-001-auth',
      base_branch: 'main',
      commit_sha: 'a1b2c3d4e5f67890123456789abcdef012345678',
      pr_url: 'https://github.com/my-org/ai-orchestrator/pull/101',
      status: 'READY_FOR_REVIEW',
      metadata: { pr_number: 101 },
      created_at: '2026-10-23T10:00:00Z',
      updated_at: '2026-10-23T10:30:00Z',
    },
    {
      id: 'rel-pay-456',
      feature_id: 'FEAT-002',
      branch: 'feature/FEAT-002-payment',
      base_branch: 'dev',
      commit_sha: 'f1e2d3c4b5a67890123456789abcdef098765432',
      pr_url: null,
      status: 'PUSHED',
      metadata: {},
      created_at: '2026-10-23T11:00:00Z',
      updated_at: '2026-10-23T11:15:00Z',
    },
  ];

  const mockReport: FeatureReleaseReportResult = {
    feature_id: 'FEAT-001',
    feature_name: 'Authentication Module',
    release_id: 'rel-auth-123',
    branch: 'feature/FEAT-001-auth',
    base_branch: 'main',
    commit_sha: 'a1b2c3d4e5f67890123456789abcdef012345678',
    pr_url: 'https://github.com/my-org/ai-orchestrator/pull/101',
    status: 'READY_FOR_REVIEW',
    report_content: '# Feature Release Report: FEAT-001\n\nAll tasks DONE and verified.',
    report_path: 'reports/FEAT-001.md',
    report_id: 'rep-001',
    generated_at: '2026-10-23T10:30:00Z',
  };

  const mockReadinessResult: FeatureReleaseCheckResult = {
    feature_id: 'FEAT-001',
    feature_name: 'Authentication Module',
    can_release: true,
    status: 'READY',
    blocking_reasons: [],
    rule_evaluations: [
      {
        rule_id: 'RULE_REQUIRED_DONE',
        name: 'Required Tasks Completed',
        passed: true,
        status: 'PASSED',
        message: 'All 2 required tasks are DONE',
        details: {},
      },
      {
        rule_id: 'RULE_QUALITY_GATE',
        name: 'Quality Gate Compliance',
        passed: true,
        status: 'PASSED',
        message: 'Quality Gate passed',
        details: {},
      },
    ],
    task_summary: {
      total_tasks: 2,
      required_count: 2,
      completed_count: 2,
      pending_count: 0,
      failed_count: 0,
      missing_count: 0,
      is_all_required_done: true,
      ready_for_release: true,
    },
    manifest: {
      feature_id: 'FEAT-001',
      feature_name: 'Authentication Module',
      description: null,
      status: 'DONE',
      release_policy: 'standard',
      integration_tests: [],
      required_task_ids: ['TSK-001', 'TSK-002'],
      all_task_ids: ['TSK-001', 'TSK-002'],
      tasks: [],
      missing_task_ids: [],
      summary: {
        total_tasks: 2,
        required_count: 2,
        completed_count: 2,
        pending_count: 0,
        failed_count: 0,
        missing_count: 0,
        is_all_required_done: true,
        ready_for_release: true,
      },
    },
    integration_test_results: [],
    checked_at: '2026-10-23T10:00:00Z',
  };

  const createMockApiClient = (overrides?: Partial<ApiClient>): ApiClient => {
    const defaultMock: Partial<ApiClient> = {
      getReleases: vi.fn().mockResolvedValue(mockReleases),
      getFeatures: vi.fn().mockResolvedValue(mockFeatures),
      getFeatureReleaseReport: vi.fn().mockResolvedValue(mockReport),
      checkFeatureReleaseReadiness: vi.fn().mockResolvedValue(mockReadinessResult),
      createFeaturePr: vi.fn().mockResolvedValue({
        release_id: 'rel-pay-456',
        feature_id: 'FEAT-002',
        branch: 'feature/FEAT-002-payment',
        base_branch: 'dev',
        commit_sha: 'f1e2d3c4b5a67890123456789abcdef098765432',
        pr_url: 'https://github.com/my-org/ai-orchestrator/pull/102',
        pr_number: 102,
        status: 'READY_FOR_REVIEW',
        quality_report_id: 'rep-002',
        quality_report_path: 'reports/FEAT-002.md',
        created_at: '2026-10-23T11:20:00Z',
      }),
    };
    return { ...defaultMock, ...overrides } as unknown as ApiClient;
  };

  // --- Tiêu chí nghiệm thu 1: Hiện branch, SHA, PR URL ---
  it('Tiêu chí nghiệm thu UI-008: Hiển thị đầy đủ branch, SHA, PR URL cho các bản ghi release', async () => {
    const mockClient = createMockApiClient();
    render(
      <ReleaseDashboard
        apiClient={mockClient}
        initialReleases={mockReleases}
        initialFeatures={mockFeatures}
      />,
    );

    // 1. Kiểm tra hiện branch
    const branchCell = screen.getByTestId('release-branch-rel-auth-123');
    expect(branchCell).toBeDefined();
    expect(branchCell.textContent).toContain('feature/FEAT-001-auth');

    const branchCell2 = screen.getByTestId('release-branch-rel-pay-456');
    expect(branchCell2.textContent).toContain('feature/FEAT-002-payment');

    // 2. Kiểm tra hiện SHA (short SHA và full SHA tooltip)
    const shaCell = screen.getByTestId('release-sha-rel-auth-123');
    expect(shaCell).toBeDefined();
    expect(shaCell.textContent).toBe('a1b2c3d');
    expect(shaCell.getAttribute('title')).toBe('a1b2c3d4e5f67890123456789abcdef012345678');

    // 3. Kiểm tra hiện PR URL (thẻ link có href đúng, target _blank)
    const prLink = screen.getByTestId('release-pr-link-rel-auth-123') as HTMLAnchorElement;
    expect(prLink).toBeDefined();
    expect(prLink.href).toBe('https://github.com/my-org/ai-orchestrator/pull/101');
    expect(prLink.target).toBe('_blank');
    expect(prLink.textContent).toContain('PR #101');

    // Release 2 chưa có PR URL -> hiển thị "Chưa tạo PR" và nút "+ Tạo PR"
    expect(screen.getByTestId('release-no-pr-rel-pay-456')).toBeDefined();
    expect(screen.getByTestId('btn-create-pr-row-rel-pay-456')).toBeDefined();
  });

  it('Hiển thị chỉ số tổng quan (Metrics grid: Total, Ready for Review, Pushed, Merged)', () => {
    const mockClient = createMockApiClient();
    render(
      <ReleaseDashboard
        apiClient={mockClient}
        initialReleases={mockReleases}
        initialFeatures={mockFeatures}
      />,
    );

    expect(screen.getByTestId('metric-total-releases').textContent).toBe('2');
    expect(screen.getByTestId('metric-ready-for-review').textContent).toBe('1');
    expect(screen.getByTestId('metric-pushed').textContent).toBe('1');
    expect(screen.getByTestId('metric-merged').textContent).toBe('0');
  });

  it('Hỗ trợ sao chép Commit SHA vào clipboard', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: writeTextMock,
      },
      configurable: true,
      writable: true,
    });

    const mockClient = createMockApiClient();
    render(
      <ReleaseDashboard
        apiClient={mockClient}
        initialReleases={mockReleases}
        initialFeatures={mockFeatures}
      />,
    );

    const copyBtn = screen.getByTestId('btn-copy-sha-rel-auth-123');
    fireEvent.click(copyBtn);

    expect(writeTextMock).toHaveBeenCalledWith('a1b2c3d4e5f67890123456789abcdef012345678');
    await waitFor(() => {
      expect(copyBtn.textContent).toContain('Đã chép');
    });
  });

  it('Lọc release theo trạng thái (status filter)', () => {
    const mockClient = createMockApiClient();
    render(
      <ReleaseDashboard
        apiClient={mockClient}
        initialReleases={mockReleases}
        initialFeatures={mockFeatures}
      />,
    );

    const select = screen.getByTestId('select-status-filter');
    fireEvent.change(select, { target: { value: 'PUSHED' } });

    // FEAT-002 là PUSHED, FEAT-001 là READY_FOR_REVIEW
    expect(screen.queryByTestId('release-row-rel-pay-456')).not.toBeNull();
    expect(screen.queryByTestId('release-row-rel-auth-123')).toBeNull();
  });

  it('Tìm kiếm release theo từ khóa (Feature ID, Branch, SHA)', () => {
    const mockClient = createMockApiClient();
    render(
      <ReleaseDashboard
        apiClient={mockClient}
        initialReleases={mockReleases}
        initialFeatures={mockFeatures}
      />,
    );

    const searchInput = screen.getByTestId('input-search-releases');
    fireEvent.change(searchInput, { target: { value: 'FEAT-002' } });

    expect(screen.queryByTestId('release-row-rel-pay-456')).not.toBeNull();
    expect(screen.queryByTestId('release-row-rel-auth-123')).toBeNull();

    // Xóa tìm kiếm
    const clearBtn = screen.getByTestId('btn-clear-search');
    fireEvent.click(clearBtn);
    expect(screen.queryByTestId('release-row-rel-auth-123')).not.toBeNull();
    expect(screen.queryByTestId('release-row-rel-pay-456')).not.toBeNull();
  });

  it('Xem báo cáo phát hành (Release Report modal) hiển thị nội dung Markdown', async () => {
    const mockClient = createMockApiClient();
    render(
      <ReleaseDashboard
        apiClient={mockClient}
        initialReleases={mockReleases}
        initialFeatures={mockFeatures}
      />,
    );

    const viewReportBtn = screen.getByTestId('btn-view-report-rel-auth-123');
    fireEvent.click(viewReportBtn);

    expect(mockClient.getFeatureReleaseReport).toHaveBeenCalledWith('FEAT-001');

    await waitFor(() => {
      expect(screen.getByTestId('modal-release-report')).toBeDefined();
    });

    const markdownBox = screen.getByTestId('release-report-markdown-content');
    expect(markdownBox.textContent).toContain('# Feature Release Report: FEAT-001');

    // Đóng modal
    const closeBtn = screen.getByTestId('btn-close-report-modal');
    fireEvent.click(closeBtn);
    expect(screen.queryByTestId('modal-release-report')).toBeNull();
  });

  it('Kiểm tra điều kiện phát hành (Readiness Check) hiển thị modal kết quả', async () => {
    const mockClient = createMockApiClient();
    render(
      <ReleaseDashboard
        apiClient={mockClient}
        initialReleases={mockReleases}
        initialFeatures={mockFeatures}
      />,
    );

    const checkBtn = screen.getByTestId('btn-check-readiness-rel-auth-123');
    fireEvent.click(checkBtn);

    expect(mockClient.checkFeatureReleaseReadiness).toHaveBeenCalledWith('FEAT-001');

    await waitFor(() => {
      expect(screen.getByTestId('modal-readiness-check')).toBeDefined();
    });

    expect(screen.getByTestId('readiness-status-badge').textContent).toContain('ĐỦ ĐIỀU KIỆN PHÁT HÀNH');

    // Đóng modal
    const dismissBtn = screen.getByTestId('btn-dismiss-readiness-modal');
    fireEvent.click(dismissBtn);
    expect(screen.queryByTestId('modal-readiness-check')).toBeNull();
  });

  it('Mở modal tạo PR và gọi API createFeaturePr thành công', async () => {
    const mockClient = createMockApiClient();
    render(
      <ReleaseDashboard
        apiClient={mockClient}
        initialReleases={mockReleases}
        initialFeatures={mockFeatures}
      />,
    );

    const openPrBtn = screen.getByTestId('btn-create-pr-row-rel-pay-456');
    fireEvent.click(openPrBtn);

    expect(screen.getByTestId('modal-create-pr')).toBeDefined();

    const titleInput = screen.getByTestId('input-pr-title');
    fireEvent.change(titleInput, { target: { value: 'feat(FEAT-002): ship payments' } });

    const submitPrBtn = screen.getByTestId('btn-submit-create-pr');
    fireEvent.click(submitPrBtn);

    await waitFor(() => {
      expect(mockClient.createFeaturePr).toHaveBeenCalledWith(
        'FEAT-002',
        expect.objectContaining({
          title: 'feat(FEAT-002): ship payments',
          base_branch: 'dev',
          draft: false,
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('release-success-banner')).toBeDefined();
    });
  });

  it('Hiển thị trạng thái rỗng (Empty State) khi không có release nào', async () => {
    const mockClient = createMockApiClient({
      getReleases: vi.fn().mockResolvedValue([]),
    });
    render(
      <ReleaseDashboard
        apiClient={mockClient}
        initialReleases={[]}
        initialFeatures={mockFeatures}
      />,
    );

    // Ban đầu initialReleases=[] loading=false sau fetch
    await waitFor(() => {
      expect(screen.getByTestId('releases-empty')).toBeDefined();
    });
  });

  it('Hiển thị trạng thái lỗi (Error State) khi API client gặp lỗi và cho phép thử lại', async () => {
    const mockClient = createMockApiClient({
      getReleases: vi.fn().mockRejectedValueOnce(new Error('Network error 500')),
    });

    render(<ReleaseDashboard apiClient={mockClient} initialReleases={[]} initialFeatures={[]} />);

    await waitFor(() => {
      expect(screen.getByTestId('release-error-banner')).toBeDefined();
      expect(screen.getByTestId('release-error-banner').textContent).toContain('Network error 500');
    });

    // Thử lại
    (mockClient.getReleases as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockReleases);
    const refreshBtn = screen.getByTestId('btn-refresh-releases');
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(screen.queryByTestId('release-error-banner')).toBeNull();
      expect(screen.getByTestId('release-branch-rel-auth-123')).toBeDefined();
    });
  });

  it('ReleasesPage app router component render tích hợp hoàn chỉnh', () => {
    const mockClient = createMockApiClient();
    render(
      <ReleasesPage
        apiClient={mockClient}
        initialReleases={mockReleases}
        initialFeatures={mockFeatures}
      />,
    );

    expect(screen.getByTestId('dashboard-releases-page')).toBeDefined();
    expect(screen.getByTestId('release-dashboard-container')).toBeDefined();
  });
});
