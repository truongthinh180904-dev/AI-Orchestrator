/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { TestReportReviewFindings } from '../components/TestReportReviewFindings.js';
import { TaskDetail } from '../components/TaskDetail.js';
import TaskQualityPage from '../app/tasks/[id]/quality/page.js';
import QualityPage from '../app/quality/page.js';
import { api } from '../lib/api.js';
import type {
  QualityGateResult,
  QualityCommandRecord,
  ReviewFindingRecord,
  TaskWithDependencies,
  TaskRunHistory,
} from '@ai-orchestrator/shared';

describe('TestReportReviewFindings Component & Quality Pages (UI-006)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const createMockTask = (overrides: Partial<TaskWithDependencies>): TaskWithDependencies => ({
    id: overrides.id ?? 'TSK-01',
    feature_id: overrides.feature_id ?? 'FEAT-1',
    plan_id: null,
    title: overrides.title ?? 'Test task',
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
    status: overrides.status ?? 'DONE',
    attempts: 1,
    created_at: '2026-10-23T00:00:00.000Z',
    updated_at: '2026-10-23T00:00:00.000Z',
    dependencies: [],
    ...overrides,
  });

  const mockPassedEvaluation: QualityGateResult = {
    id: 'qg-eval-pass-001',
    task_id: 'TSK-001',
    run_id: 'run-pass-001',
    repo_path: '/workspace/test-repo',
    passed: true,
    status: 'PASSED',
    summary: 'Quality Gate PASSED: All verification criteria met.',
    policy: {
      requireFormatLintTypecheck: true,
      requireTest: true,
      requireBuild: false,
      requireCleanScope: true,
      requireReviewClean: true,
      requireNoSecrets: true,
      requireAuditClean: true,
      rejectCliSuccessOnly: true,
      allowedOutOfScopeFiles: [],
      maxReviewHighFindings: 0,
      maxReviewCriticalFindings: 0,
      maxAuditHighFindings: 0,
      maxAuditCriticalFindings: 0,
    },
    rule_evaluations: [
      {
        rule_id: 'CLI_SUCCESS_DISTINCTION',
        name: 'Distinction between CLI exit 0 and verification evidence',
        stage: 'governance',
        passed: true,
        status: 'PASSED',
        message: 'CLI exited with code 0 and required verification evidence was collected.',
        details: {},
      },
      {
        rule_id: 'FORMAT_LINT_TYPECHECK',
        name: 'Format, Lint, and Typecheck exit 0',
        stage: 'lint',
        passed: true,
        status: 'PASSED',
        message: 'All 2 formatting/linting/typechecking commands passed with exit code 0.',
        details: {},
      },
      {
        rule_id: 'UNIT_TESTS',
        name: 'Unit test execution exit 0',
        stage: 'test',
        passed: true,
        status: 'PASSED',
        message: 'All 1 test commands passed with exit code 0.',
        details: {},
      },
      {
        rule_id: 'SCOPE_COMPLIANCE',
        name: 'No out-of-scope files modified',
        stage: 'scope',
        passed: true,
        status: 'PASSED',
        message: 'All modified files are strictly within declared task scope.',
        details: {},
      },
      {
        rule_id: 'REVIEW_FINDINGS',
        name: 'Reviewer Agent findings severity check',
        stage: 'review',
        passed: true,
        status: 'PASSED',
        message: 'No blocking findings (high or critical severity) found.',
        details: {},
      },
      {
        rule_id: 'SECRET_SCAN',
        name: 'No unmasked secrets detected',
        stage: 'security',
        passed: true,
        status: 'PASSED',
        message: 'Secret scanner found 0 exposed credentials or keys.',
        details: {},
      },
      {
        rule_id: 'DEPENDENCY_AUDIT',
        name: 'Dependency audit clean',
        stage: 'security',
        passed: true,
        status: 'PASSED',
        message: 'pnpm audit reported 0 high or critical vulnerabilities.',
        details: {},
      },
    ],
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
      reviewFindingsCount: 1,
      reviewHighCount: 0,
      reviewCriticalCount: 0,
      secretFindingsCount: 0,
      auditHighCriticalCount: 0,
    },
    command_records: [],
    scope_result: null,
    review_result: null,
    security_result: null,
    duration_ms: 1250,
    evaluated_at: '2026-10-23T10:00:00.000Z',
  };

  const mockFailedEvaluation: QualityGateResult = {
    id: 'qg-eval-fail-002',
    task_id: 'TSK-002',
    run_id: 'run-fail-002',
    repo_path: '/workspace/test-repo',
    passed: false,
    status: 'FAILED',
    summary: 'Quality Gate FAILED: Không PASS chỉ vì CLI báo SUCCESS. Test failed.',
    policy: mockPassedEvaluation.policy,
    rule_evaluations: [
      {
        rule_id: 'CLI_SUCCESS_DISTINCTION',
        name: 'Distinction between CLI exit 0 and verification evidence',
        stage: 'governance',
        passed: false,
        status: 'FAILED',
        message: 'Không PASS chỉ vì CLI báo SUCCESS! Lệnh kiểm tra test thất bại.',
        details: {},
      },
      {
        rule_id: 'UNIT_TESTS',
        name: 'Unit test execution exit 0',
        stage: 'test',
        passed: false,
        status: 'FAILED',
        message: 'Lệnh test vitest run thất bại với exit code 1.',
        details: {},
      },
      {
        rule_id: 'SCOPE_COMPLIANCE',
        name: 'No out-of-scope files modified',
        stage: 'scope',
        passed: false,
        status: 'FAILED',
        message: 'Phát hiện 1 file lạ ngoài phạm vi.',
        details: {},
      },
    ],
    evidence_summary: {
      cliExitCode: 0,
      cliStatus: 'SUCCESS',
      cliSucceeded: true,
      totalCommands: 2,
      passedCommands: 1,
      failedCommands: 1,
      skippedCommands: 0,
      outOfScopeFilesCount: 1,
      outOfScopeFiles: ['alien-file.ts'],
      reviewFindingsCount: 2,
      reviewHighCount: 1,
      reviewCriticalCount: 1,
      secretFindingsCount: 1,
      auditHighCriticalCount: 1,
    },
    command_records: [],
    scope_result: null,
    review_result: null,
    security_result: null,
    duration_ms: 840,
    evaluated_at: '2026-10-23T11:00:00.000Z',
  };

  const mockCommandRecords: QualityCommandRecord[] = [
    {
      id: 'cmd-rec-01',
      task_id: 'TSK-001',
      run_id: 'run-pass-001',
      command_id: 'cmd-1',
      name: 'ESLint check',
      command: 'pnpm lint',
      exe: 'pnpm',
      args: ['lint'],
      cwd: '.',
      stage: 'lint',
      exit_code: 0,
      signal: null,
      duration_ms: 320,
      stdout: 'All files passed lint check.\n0 errors, 0 warnings.',
      stderr: '',
      status: 'SUCCESS',
      started_at: '2026-10-23T10:00:00.000Z',
      finished_at: '2026-10-23T10:00:01.000Z',
      created_at: '2026-10-23T10:00:01.000Z',
    },
    {
      id: 'cmd-rec-02',
      task_id: 'TSK-001',
      run_id: 'run-pass-001',
      command_id: 'cmd-2',
      name: 'Unit tests',
      command: 'pnpm test',
      exe: 'pnpm',
      args: ['test'],
      cwd: '.',
      stage: 'test',
      exit_code: 0,
      signal: null,
      duration_ms: 650,
      stdout: 'PASS src/__tests__/unit.test.ts (5 tests passed)',
      stderr: '',
      status: 'SUCCESS',
      started_at: '2026-10-23T10:00:01.000Z',
      finished_at: '2026-10-23T10:00:02.000Z',
      created_at: '2026-10-23T10:00:02.000Z',
    },
    {
      id: 'cmd-rec-03',
      task_id: 'TSK-001',
      run_id: 'run-pass-001',
      command_id: 'cmd-3',
      name: 'Vitest fail test',
      command: 'vitest run failed.test.ts',
      exe: 'vitest',
      args: ['run', 'failed.test.ts'],
      cwd: '.',
      stage: 'test',
      exit_code: 1,
      signal: null,
      duration_ms: 410,
      stdout: 'FAIL src/__tests__/failed.test.ts',
      stderr: 'AssertionError: expected true to be false',
      status: 'FAILURE',
      started_at: '2026-10-23T10:00:02.000Z',
      finished_at: '2026-10-23T10:00:03.000Z',
      created_at: '2026-10-23T10:00:03.000Z',
    },
  ];

  const mockReviewFindings: ReviewFindingRecord[] = [
    {
      id: 'finding-01',
      task_id: 'TSK-001',
      run_id: 'run-pass-001',
      severity: 'critical',
      file: 'src/auth/jwt.ts',
      line: 42,
      message: 'Hardcoded secret token detected in signing method.',
      category: 'security',
      rule_id: 'SEC-001',
      suggestion: 'Use process.env.JWT_SECRET instead of string constant.',
      created_at: '2026-10-23T10:00:00.000Z',
    },
    {
      id: 'finding-02',
      task_id: 'TSK-001',
      run_id: 'run-pass-001',
      severity: 'high',
      file: 'src/db/query.ts',
      line: 88,
      message: 'Potential SQL injection risk in dynamic query concatenation.',
      category: 'correctness',
      rule_id: 'DB-002',
      suggestion: 'Use parameterized statements with prepared query placeholders.',
      created_at: '2026-10-23T10:00:00.000Z',
    },
    {
      id: 'finding-03',
      task_id: 'TSK-001',
      run_id: 'run-pass-001',
      severity: 'medium',
      file: 'src/utils/format.ts',
      line: 15,
      message: 'Unbounded loop possible when parsing large payload string.',
      category: 'performance',
      rule_id: 'PERF-003',
      suggestion: 'Add max length check before tokenization.',
      created_at: '2026-10-23T10:00:00.000Z',
    },
    {
      id: 'finding-04',
      task_id: 'TSK-001',
      run_id: 'run-pass-001',
      severity: 'low',
      file: 'src/index.ts',
      line: 120,
      message: 'Missing return type annotation on exported function.',
      category: 'style',
      rule_id: 'TS-004',
      suggestion: 'Explicitly specify : Promise<void>.',
      created_at: '2026-10-23T10:00:00.000Z',
    },
  ];

  it('1. Renders empty state when no data exists with trigger button', () => {
    render(
      <TestReportReviewFindings
        taskId="TSK-EMPTY"
        autoFetch={false}
        initialEvaluation={null}
        initialRecords={[]}
        initialFindings={[]}
      />,
    );

    expect(screen.getByTestId('evidence-empty')).toBeDefined();
    expect(screen.getByText(/Chưa có bằng chứng kiểm định/i)).toBeDefined();
    expect(screen.getByTestId('btn-run-first-verify')).toBeDefined();
  });

  it('2. Renders Quality Gate PASSED evaluation summary card and metrics', () => {
    render(
      <TestReportReviewFindings
        taskId="TSK-001"
        autoFetch={false}
        initialEvaluation={mockPassedEvaluation}
        initialRecords={mockCommandRecords}
        initialFindings={mockReviewFindings}
      />,
    );

    expect(screen.getByTestId('evidence-summary-card')).toBeDefined();
    expect(screen.getByTestId('gate-status-passed')).toBeDefined();
    expect(screen.getByText(/✅ ĐẠT \(PASSED\)/i)).toBeDefined();
    expect(screen.getByTestId('gate-summary-text').textContent).toContain('All verification criteria met');
    expect(screen.getByTestId('gate-duration').textContent).toContain('1250ms');
    expect(screen.getByTestId('metric-commands-passed')).toBeDefined();
    expect(screen.getByTestId('metric-scope-clean').textContent).toContain('Sạch (0 file lạ)');
    expect(screen.getByTestId('metric-security-issues').textContent).toContain('An toàn');
  });

  it('3. Renders Quality Gate FAILED evaluation and CLI Success distinction warning banner', () => {
    render(
      <TestReportReviewFindings
        taskId="TSK-002"
        autoFetch={false}
        initialEvaluation={mockFailedEvaluation}
        initialRecords={mockCommandRecords}
        initialFindings={mockReviewFindings}
      />,
    );

    expect(screen.getByTestId('gate-status-failed')).toBeDefined();
    expect(screen.getByText(/❌ THẤT BẠI \(FAILED\)/i)).toBeDefined();
    expect(screen.getByTestId('cli-success-rejected-banner')).toBeDefined();
    expect(screen.getByTestId('cli-success-rejected-banner').textContent).toContain(
      'Không PASS chỉ vì CLI báo SUCCESS',
    );
    expect(screen.getByTestId('metric-commands-failed').textContent).toContain('1');
    expect(screen.getByTestId('metric-scope-clean').textContent).toContain('1 file ngoài scope');
  });

  it('4. Renders individual rule evaluations list with status badges and messages', () => {
    render(
      <TestReportReviewFindings
        taskId="TSK-001"
        autoFetch={false}
        initialEvaluation={mockPassedEvaluation}
      />,
    );

    expect(screen.getByTestId('section-rule-evaluations')).toBeDefined();
    expect(screen.getByTestId('rule-item-CLI_SUCCESS_DISTINCTION')).toBeDefined();
    expect(screen.getByTestId('rule-status-CLI_SUCCESS_DISTINCTION').textContent).toBe('PASSED');
    expect(screen.getByTestId('rule-item-FORMAT_LINT_TYPECHECK')).toBeDefined();
    expect(screen.getByTestId('rule-item-UNIT_TESTS')).toBeDefined();
    expect(screen.getByTestId('rule-item-SCOPE_COMPLIANCE')).toBeDefined();
  });

  it('5. Switches to test commands tab, inspects command items, and toggles stdout/stderr', () => {
    render(
      <TestReportReviewFindings
        taskId="TSK-001"
        autoFetch={false}
        initialEvaluation={mockPassedEvaluation}
        initialRecords={mockCommandRecords}
      />,
    );

    // Switch to commands tab
    const commandsTabBtn = screen.getByTestId('nav-commands-tab');
    fireEvent.click(commandsTabBtn);

    expect(screen.getByTestId('section-quality-commands')).toBeDefined();
    expect(screen.getByTestId('command-item-cmd-rec-01')).toBeDefined();
    expect(screen.getByTestId('cmd-string-cmd-rec-01').textContent).toBe('pnpm lint');
    expect(screen.getByTestId('cmd-exit-code-cmd-rec-01').textContent).toContain('Exit 0');

    // Toggle output
    const toggleBtn = screen.getByTestId('cmd-toggle-output-cmd-rec-01');
    fireEvent.click(toggleBtn);
    expect(screen.getByTestId('cmd-stdout-cmd-rec-01').textContent).toContain('0 errors, 0 warnings');

    // Test command with failure
    expect(screen.getByTestId('command-item-cmd-rec-03')).toBeDefined();
    const toggleFailBtn = screen.getByTestId('cmd-toggle-output-cmd-rec-03');
    fireEvent.click(toggleFailBtn);
    expect(screen.getByTestId('cmd-stderr-cmd-rec-03').textContent).toContain('AssertionError');
  });

  it('6. Filters command records by stage and search input', () => {
    render(
      <TestReportReviewFindings
        taskId="TSK-001"
        autoFetch={false}
        initialEvaluation={mockPassedEvaluation}
        initialRecords={mockCommandRecords}
      />,
    );

    fireEvent.click(screen.getByTestId('nav-commands-tab'));

    // Filter by stage 'lint'
    const stageSelect = screen.getByTestId('filter-command-stage');
    fireEvent.change(stageSelect, { target: { value: 'lint' } });

    expect(screen.getByTestId('command-item-cmd-rec-01')).toBeDefined();
    expect(screen.queryByTestId('command-item-cmd-rec-02')).toBeNull();

    // Reset filter and search by query
    fireEvent.change(stageSelect, { target: { value: 'all' } });
    const searchInput = screen.getByTestId('search-commands-input');
    fireEvent.change(searchInput, { target: { value: 'vitest' } });

    expect(screen.queryByTestId('command-item-cmd-rec-01')).toBeNull();
    expect(screen.getByTestId('command-item-cmd-rec-03')).toBeDefined();
  });

  it('7. Switches to review findings tab and displays severity, file:line, and suggestions', () => {
    render(
      <TestReportReviewFindings
        taskId="TSK-001"
        autoFetch={false}
        initialEvaluation={mockPassedEvaluation}
        initialFindings={mockReviewFindings}
      />,
    );

    fireEvent.click(screen.getByTestId('nav-findings-tab'));

    expect(screen.getByTestId('section-review-findings')).toBeDefined();
    expect(screen.getByTestId('finding-item-finding-01')).toBeDefined();
    expect(screen.getByTestId('badge-severity-critical')).toBeDefined();
    expect(screen.getByTestId('finding-file-line-finding-01').textContent).toBe('src/auth/jwt.ts:42');
    expect(screen.getByTestId('finding-message-finding-01').textContent).toContain('Hardcoded secret token');
    expect(screen.getByTestId('finding-suggestion-finding-01').textContent).toContain('process.env.JWT_SECRET');
  });

  it('8. Filters review findings by severity and search query', () => {
    render(
      <TestReportReviewFindings
        taskId="TSK-001"
        autoFetch={false}
        initialEvaluation={mockPassedEvaluation}
        initialFindings={mockReviewFindings}
      />,
    );

    fireEvent.click(screen.getByTestId('nav-findings-tab'));

    // Filter by 'critical'
    fireEvent.click(screen.getByTestId('filter-severity-critical'));
    expect(screen.getByTestId('finding-item-finding-01')).toBeDefined();
    expect(screen.queryByTestId('finding-item-finding-02')).toBeNull();
    expect(screen.queryByTestId('finding-item-finding-03')).toBeNull();

    // Filter by 'all' and search
    fireEvent.click(screen.getByTestId('filter-severity-all'));
    const searchInput = screen.getByTestId('search-findings-input');
    fireEvent.change(searchInput, { target: { value: 'sql' } });

    expect(screen.queryByTestId('finding-item-finding-01')).toBeNull();
    expect(screen.getByTestId('finding-item-finding-02')).toBeDefined();
  });

  it('9. Renders clean state when 0 review findings are present', () => {
    render(
      <TestReportReviewFindings
        taskId="TSK-001"
        autoFetch={false}
        initialEvaluation={mockPassedEvaluation}
        initialFindings={[]}
      />,
    );

    fireEvent.click(screen.getByTestId('nav-findings-tab'));
    expect(screen.getByTestId('findings-empty-clean')).toBeDefined();
    expect(screen.getByTestId('findings-empty-clean').textContent).toContain('Không phát hiện vi phạm nào');
  });

  it('10. Renders Scope & Security evidence tab with clean status vs alien files', () => {
    render(
      <TestReportReviewFindings
        taskId="TSK-002"
        autoFetch={false}
        initialEvaluation={mockFailedEvaluation}
      />,
    );

    fireEvent.click(screen.getByTestId('nav-scope-tab'));

    expect(screen.getByTestId('section-scope-security')).toBeDefined();
    expect(screen.getByTestId('scope-status-badge').textContent).toBe('PHÁT HIỆN FILE LẠ');
    expect(screen.getByTestId('evidence-scope-files').textContent).toContain('alien-file.ts');
    expect(screen.getByTestId('evidence-secrets-count').textContent).toContain('1 phát hiện');
    expect(screen.getByTestId('evidence-audit-count').textContent).toContain('1 lỗ hổng');
  });

  it('11. Triggers verification when clicking Run Verification button', async () => {
    const verifySpy = vi.spyOn(api, 'verifyTask').mockResolvedValue({
      result: mockPassedEvaluation,
      task: createMockTask({
        id: 'TSK-001',
        feature_id: 'FEAT-01',
        title: 'Task 1',
        status: 'DONE',
      }),
    });

    render(
      <TestReportReviewFindings
        taskId="TSK-001"
        autoFetch={false}
        initialEvaluation={null}
        initialRecords={[]}
      />,
    );

    const verifyBtn = screen.getByTestId('btn-verify-task');
    fireEvent.click(verifyBtn);

    await waitFor(() => {
      expect(verifySpy).toHaveBeenCalledWith('TSK-001', expect.any(Object));
    });

    await waitFor(() => {
      expect(screen.getByTestId('evidence-summary-card')).toBeDefined();
      expect(screen.getByTestId('evidence-success-notice')).toBeDefined();
    });
  });

  it('12. Copies Markdown report to clipboard', async () => {
    const clipboardSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: clipboardSpy,
      },
      configurable: true,
      writable: true,
    });

    render(
      <TestReportReviewFindings
        taskId="TSK-001"
        autoFetch={false}
        initialEvaluation={mockPassedEvaluation}
      />,
    );

    const copyBtn = screen.getByTestId('btn-copy-markdown-report');
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(clipboardSpy).toHaveBeenCalled();
    });

    expect(screen.getByTestId('evidence-success-notice').textContent).toContain('clipboard');
  });

  it('13. Integrates into TaskDetail via tab-quality', async () => {
    const mockTask: TaskWithDependencies = createMockTask({
      id: 'TSK-DETAIL-01',
      title: 'Task for testing quality tab',
      feature_id: 'FEAT-01',
      status: 'VERIFYING',
    });

    const mockRun = {
      id: 'run-1',
      task_id: 'TSK-DETAIL-01',
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
      taskId: 'TSK-DETAIL-01',
      taskTitle: 'Task for testing quality tab',
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
      getTaskQualityGateLatest: vi.fn().mockResolvedValue(mockPassedEvaluation),
      getTaskQualityRecords: vi.fn().mockResolvedValue(mockCommandRecords),
      getTaskReviewFindings: vi.fn().mockResolvedValue(mockReviewFindings),
      getTaskQualityGateHistory: vi.fn().mockResolvedValue([mockPassedEvaluation]),
      getRunQualityRecords: vi.fn().mockResolvedValue(mockCommandRecords),
      getRunReviewFindings: vi.fn().mockResolvedValue(mockReviewFindings),
    } as unknown as typeof api;

    render(<TaskDetail taskId="TSK-DETAIL-01" apiClient={mockApi} />);

    await waitFor(() => {
      expect(screen.getByTestId('tab-quality')).toBeDefined();
    });

    const qualityTab = screen.getByTestId('tab-quality');
    fireEvent.click(qualityTab);

    await waitFor(() => {
      expect(screen.getByTestId('run-quality-container')).toBeDefined();
      expect(screen.getByTestId('quality-evidence-viewer')).toBeDefined();
    });
  });

  it('14. Renders TaskQualityPage with back link and quality viewer', async () => {
    const mockApi = {
      getTaskQualityGateLatest: vi.fn().mockResolvedValue(mockPassedEvaluation),
      getTaskQualityGateHistory: vi.fn().mockResolvedValue([mockPassedEvaluation]),
      getTaskQualityRecords: vi.fn().mockResolvedValue(mockCommandRecords),
      getTaskReviewFindings: vi.fn().mockResolvedValue(mockReviewFindings),
    } as unknown as typeof api;

    render(<TaskQualityPage params={{ id: 'TSK-001' }} apiClient={mockApi} />);

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-task-quality-page')).toBeDefined();
      expect(screen.getByText(/Quay lại chi tiết tác vụ TSK-001/i)).toBeDefined();
      expect(screen.getByTestId('quality-evidence-viewer')).toBeDefined();
    });
  });

  it('15. Renders standalone QualityPage with task selector', async () => {
    const mockTaskList: TaskWithDependencies[] = [
      createMockTask({
        id: 'TSK-SEL-01',
        title: 'Selector Task 1',
        feature_id: 'FEAT-01',
        status: 'DONE',
      }),
    ];

    const mockApi = {
      getTasks: vi.fn().mockResolvedValue(mockTaskList),
      getTaskQualityGateLatest: vi.fn().mockResolvedValue(mockPassedEvaluation),
      getTaskQualityGateHistory: vi.fn().mockResolvedValue([mockPassedEvaluation]),
      getTaskQualityRecords: vi.fn().mockResolvedValue(mockCommandRecords),
      getTaskReviewFindings: vi.fn().mockResolvedValue(mockReviewFindings),
    } as unknown as typeof api;

    render(<QualityPage apiClient={mockApi} />);

    await waitFor(() => {
      expect(screen.getByTestId('dashboard-quality-page')).toBeDefined();
      expect(screen.getByTestId('quality-task-select')).toBeDefined();
    });

    // Enter custom task
    const customInput = screen.getByTestId('quality-custom-task-input');
    fireEvent.change(customInput, { target: { value: 'TSK-CUSTOM' } });

    await waitFor(() => {
      expect(screen.getByTestId('evidence-task-badge').textContent).toBe('TSK-CUSTOM');
    });
  });
});
