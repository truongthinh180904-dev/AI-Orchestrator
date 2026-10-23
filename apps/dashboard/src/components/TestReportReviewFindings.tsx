'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  type QualityGateResult,
  type QualityCommandRecord,
  type ReviewFindingRecord,
  type FindingSeverity,
  type TaskWithDependencies,
  formatQualityGateMarkdownReport,
} from '@ai-orchestrator/shared';
import { ApiClient, api as defaultApi } from '../lib/api.js';

export interface TestReportReviewFindingsProps {
  taskId?: string;
  runId?: string;
  apiClient?: ApiClient;
  initialEvaluation?: QualityGateResult | null;
  initialRecords?: QualityCommandRecord[];
  initialFindings?: ReviewFindingRecord[];
  autoFetch?: boolean;
  onVerified?: (res: { result: QualityGateResult; task: TaskWithDependencies }) => void;
}

export const TestReportReviewFindings: React.FC<TestReportReviewFindingsProps> = ({
  taskId,
  runId,
  apiClient,
  initialEvaluation = null,
  initialRecords = [],
  initialFindings = [],
  autoFetch = true,
  onVerified,
}) => {
  const client = apiClient ?? defaultApi;
  const [evaluation, setEvaluation] = useState<QualityGateResult | null>(initialEvaluation);
  const [history, setHistory] = useState<QualityGateResult[]>([]);
  const [selectedEvaluationId, setSelectedEvaluationId] = useState<string>('');
  const [commandRecords, setCommandRecords] = useState<QualityCommandRecord[]>(initialRecords);
  const [reviewFindings, setReviewFindings] = useState<ReviewFindingRecord[]>(initialFindings);
  const [loading, setLoading] = useState<boolean>(false);
  const [verifying, setVerifying] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  // Filters
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [commandStatusFilter, setCommandStatusFilter] = useState<string>('all');
  const [commandSearch, setCommandSearch] = useState<string>('');
  const [expandedCommands, setExpandedCommands] = useState<Record<string, boolean>>({});

  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [findingSearch, setFindingSearch] = useState<string>('');

  // Active section tab
  const [activeSection, setActiveSection] = useState<'rules' | 'commands' | 'findings' | 'scope_security'>('rules');

  const fetchEvidence = useCallback(async () => {
    if (!taskId && !runId) return;
    setLoading(true);
    setError(null);

    try {
      if (taskId) {
        // Fetch latest quality gate evaluation
        try {
          const latestEval = await client.getTaskQualityGateLatest(taskId);
          setEvaluation(latestEval);
          setSelectedEvaluationId(latestEval.id);
        } catch {
          // If 404 or not found, leave as null
          setEvaluation(null);
        }

        // Fetch history
        try {
          const evalHistory = await client.getTaskQualityGateHistory(taskId);
          setHistory(evalHistory);
        } catch {
          setHistory([]);
        }

        // Fetch command records
        try {
          const records = await client.getTaskQualityRecords(taskId);
          setCommandRecords(records);
        } catch {
          // fallback to records inside evaluation if available
        }

        // Fetch review findings
        try {
          const findings = await client.getTaskReviewFindings(taskId);
          setReviewFindings(findings);
        } catch {
          // fallback to findings inside evaluation if available
        }
      } else if (runId) {
        // Fetch run-specific records
        try {
          const records = await client.getRunQualityRecords(runId);
          setCommandRecords(records);
        } catch {
          // ignore
        }
        try {
          const findings = await client.getRunReviewFindings(runId);
          setReviewFindings(findings);
        } catch {
          // ignore
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Không thể tải dữ liệu kiểm định: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [taskId, runId, client]);

  useEffect(() => {
    if (autoFetch && (taskId || runId)) {
      void fetchEvidence();
    }
  }, [autoFetch, taskId, runId, fetchEvidence]);

  // When switching selected evaluation from history
  const handleSelectEvaluation = useCallback((id: string) => {
    setSelectedEvaluationId(id);
    const found = history.find((h) => h.id === id);
    if (found) {
      setEvaluation(found);
    }
  }, [history]);

  // Run verification
  const handleRunVerification = async () => {
    if (!taskId) return;
    setVerifying(true);
    setError(null);
    setSuccessNotice(null);

    try {
      const res = await client.verifyTask(taskId, {
        runId: runId ?? undefined,
        autoTransition: true,
      });

      setEvaluation(res.result);
      setSelectedEvaluationId(res.result.id);
      setSuccessNotice(`Kiểm định hoàn tất: Trạng thái task hiện tại là ${res.task.status}.`);
      onVerified?.(res);
      await fetchEvidence();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Lỗi khi chạy kiểm định Quality Gate: ${msg}`);
    } finally {
      setVerifying(false);
    }
  };

  // Toggle command output
  const toggleCommandExpanded = (cmdId: string) => {
    setExpandedCommands((prev) => ({
      ...prev,
      [cmdId]: !prev[cmdId],
    }));
  };

  // Copy Markdown Report
  const handleCopyMarkdown = async () => {
    if (!evaluation) return;
    try {
      const markdown = formatQualityGateMarkdownReport(evaluation);
      await navigator.clipboard.writeText(markdown);
      setSuccessNotice('Đã sao chép báo cáo Markdown vào clipboard!');
      setTimeout(() => setSuccessNotice(null), 3500);
    } catch (err) {
      setError(`Không thể sao chép báo cáo: ${String(err)}`);
    }
  };

  // Merged command records: prefer commandRecords state, fallback to evaluation.command_records
  const effectiveCommandRecords = useMemo(() => {
    if (commandRecords && commandRecords.length > 0) return commandRecords;
    return evaluation?.command_records ?? [];
  }, [commandRecords, evaluation]);

  // Merged review findings: prefer reviewFindings state, fallback to evaluation.review_result.findings
  const effectiveReviewFindings = useMemo(() => {
    if (reviewFindings && reviewFindings.length > 0) return reviewFindings;
    const findingsFromEval = evaluation?.review_result?.findings ?? [];
    return findingsFromEval.map((f, idx) => ({
      id: f.id ?? `eval-finding-${idx}`,
      task_id: taskId ?? null,
      run_id: runId ?? null,
      severity: f.severity,
      file: f.file,
      line: f.line,
      message: f.message,
      category: f.category ?? null,
      rule_id: f.rule_id ?? null,
      suggestion: f.suggestion ?? null,
      created_at: evaluation?.evaluated_at ?? new Date().toISOString(),
    }));
  }, [reviewFindings, evaluation, taskId, runId]);

  // Filtered commands
  const filteredCommands = useMemo(() => {
    return effectiveCommandRecords.filter((cmd) => {
      if (stageFilter !== 'all' && cmd.stage !== stageFilter) return false;
      if (commandStatusFilter !== 'all') {
        const isPassed = cmd.status === 'SUCCESS' || cmd.exit_code === 0;
        if (commandStatusFilter === 'passed' && !isPassed) return false;
        if (commandStatusFilter === 'failed' && isPassed) return false;
      }
      if (commandSearch.trim()) {
        const q = commandSearch.toLowerCase();
        const matchesCmd = cmd.command.toLowerCase().includes(q);
        const matchesStage = cmd.stage.toLowerCase().includes(q);
        if (!matchesCmd && !matchesStage) return false;
      }
      return true;
    });
  }, [effectiveCommandRecords, stageFilter, commandStatusFilter, commandSearch]);

  // Filtered review findings
  const filteredFindings = useMemo(() => {
    return effectiveReviewFindings.filter((f) => {
      if (severityFilter !== 'all' && f.severity !== severityFilter) return false;
      if (findingSearch.trim()) {
        const q = findingSearch.toLowerCase();
        const matchesFile = f.file.toLowerCase().includes(q);
        const matchesMsg = f.message.toLowerCase().includes(q);
        const matchesCat = (f.category ?? '').toLowerCase().includes(q);
        if (!matchesFile && !matchesMsg && !matchesCat) return false;
      }
      return true;
    });
  }, [effectiveReviewFindings, severityFilter, findingSearch]);

  // Severity counts
  const severityCounts = useMemo(() => {
    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const f of effectiveReviewFindings) {
      if (f.severity in counts) {
        counts[f.severity as FindingSeverity]++;
      }
    }
    return counts;
  }, [effectiveReviewFindings]);

  // Check if CLI Success was rejected
  const isCliSuccessRejected = useMemo(() => {
    if (!evaluation) return false;
    if (evaluation.passed) return false;
    return (
      evaluation.summary.includes('Không PASS chỉ vì CLI báo SUCCESS') ||
      (evaluation.evidence_summary?.cliSucceeded === true && !evaluation.passed) ||
      evaluation.rule_evaluations.some(
        (r) =>
          (r.rule_id === 'CLI_SUCCESS_DISTINCTION' || r.rule_id === 'VERIFICATION_EVIDENCE_EXISTS') &&
          !r.passed,
      )
    );
  }, [evaluation]);

  return (
    <div
      data-testid="quality-evidence-viewer"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        backgroundColor: '#ffffff',
        borderRadius: '8px',
        border: '1px solid #e2e8f0',
        padding: '20px',
      }}
    >
      {/* Top Header / Actions */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
          borderBottom: '1px solid #f1f5f9',
          paddingBottom: '14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>
            🧪 Báo Cáo Kiểm Thử & Review Findings
          </h3>
          {taskId && (
            <span
              data-testid="evidence-task-badge"
              style={{
                fontSize: '12px',
                fontWeight: 600,
                padding: '2px 8px',
                borderRadius: '6px',
                backgroundColor: '#eff6ff',
                color: '#1d4ed8',
                border: '1px solid #bfdbfe',
              }}
            >
              {taskId}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {history.length > 1 && (
            <select
              data-testid="select-evaluation-history"
              value={selectedEvaluationId}
              onChange={(e) => handleSelectEvaluation(e.target.value)}
              style={{
                fontSize: '12px',
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
                backgroundColor: '#f8fafc',
                color: '#334155',
              }}
            >
              {history.map((h, i) => (
                <option key={h.id} value={h.id}>
                  Lần {history.length - i} ({h.status} - {new Date(h.evaluated_at).toLocaleTimeString()})
                </option>
              ))}
            </select>
          )}

          {evaluation && (
            <button
              type="button"
              data-testid="btn-copy-markdown-report"
              onClick={handleCopyMarkdown}
              style={{
                padding: '6px 12px',
                fontSize: '12px',
                fontWeight: 600,
                color: '#475569',
                backgroundColor: '#f1f5f9',
                border: '1px solid #cbd5e1',
                borderRadius: '6px',
                cursor: 'pointer',
              }}
            >
              📋 Sao chép Markdown
            </button>
          )}

          <button
            type="button"
            data-testid="btn-refresh-evidence"
            onClick={fetchEvidence}
            disabled={loading || verifying}
            style={{
              padding: '6px 12px',
              fontSize: '12px',
              fontWeight: 600,
              color: '#334155',
              backgroundColor: '#f8fafc',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              cursor: loading || verifying ? 'not-allowed' : 'pointer',
            }}
          >
            {loading ? 'Đang tải...' : '🔄 Làm mới'}
          </button>

          {taskId && (
            <button
              type="button"
              data-testid="btn-verify-task"
              onClick={handleRunVerification}
              disabled={loading || verifying}
              style={{
                padding: '6px 14px',
                fontSize: '12px',
                fontWeight: 600,
                color: '#ffffff',
                backgroundColor: verifying ? '#93c5fd' : '#2563eb',
                border: 'none',
                borderRadius: '6px',
                cursor: verifying ? 'not-allowed' : 'pointer',
              }}
            >
              {verifying ? '⏳ Đang xác minh...' : '⚡ Chạy Kiểm Định (Quality Gate)'}
            </button>
          )}
        </div>
      </div>

      {/* Notifications / Alerts */}
      {error && (
        <div
          data-testid="evidence-error"
          style={{
            padding: '12px 16px',
            backgroundColor: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: '6px',
            color: '#b91c1c',
            fontSize: '13px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{error}</span>
          <button
            type="button"
            data-testid="btn-retry-evidence"
            onClick={fetchEvidence}
            style={{
              padding: '4px 10px',
              fontSize: '12px',
              fontWeight: 600,
              backgroundColor: '#fee2e2',
              color: '#991b1b',
              border: '1px solid #fca5a5',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Thử lại
          </button>
        </div>
      )}

      {successNotice && (
        <div
          data-testid="evidence-success-notice"
          style={{
            padding: '10px 16px',
            backgroundColor: '#f0fdf4',
            border: '1px solid #bbf7d0',
            borderRadius: '6px',
            color: '#15803d',
            fontSize: '13px',
          }}
        >
          {successNotice}
        </div>
      )}

      {/* Loading state */}
      {loading && !evaluation && (
        <div
          data-testid="evidence-loading"
          style={{
            padding: '36px',
            textAlign: 'center',
            color: '#64748b',
            fontSize: '14px',
          }}
        >
          <div style={{ fontSize: '24px', marginBottom: '8px' }}>⏳</div>
          Đang nạp dữ liệu kiểm định, kết quả test và review findings...
        </div>
      )}

      {/* Rejection Banner for CLI Success distinction rule */}
      {isCliSuccessRejected && (
        <div
          data-testid="cli-success-rejected-banner"
          style={{
            padding: '12px 16px',
            backgroundColor: '#fff1f2',
            border: '1px solid #fda4af',
            borderRadius: '6px',
            color: '#be123c',
            fontSize: '13px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span>⛔ CẢNH BÁO QUY TRÌNH:</span>
          <span>Không PASS chỉ vì CLI báo SUCCESS! Lệnh kiểm tra hoặc tiêu chuẩn Quality Gate thất bại.</span>
        </div>
      )}

      {/* Quality Gate Summary Card */}
      {evaluation && (
        <div
          data-testid="evidence-summary-card"
          style={{
            backgroundColor: evaluation.passed ? '#f0fdf4' : '#fff1f2',
            border: `1px solid ${evaluation.passed ? '#86efac' : '#fecdd3'}`,
            borderRadius: '8px',
            padding: '18px',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '10px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span
                data-testid={evaluation.passed ? 'gate-status-passed' : 'gate-status-failed'}
                style={{
                  fontSize: '13px',
                  fontWeight: 800,
                  padding: '4px 10px',
                  borderRadius: '6px',
                  backgroundColor: evaluation.passed ? '#22c55e' : '#e11d48',
                  color: '#ffffff',
                }}
              >
                {evaluation.passed ? '✅ ĐẠT (PASSED)' : '❌ THẤT BẠI (FAILED)'}
              </span>
              <span style={{ fontSize: '14px', fontWeight: 700, color: '#0f172a' }}>
                Đánh giá Quality Gate (QLT-007)
              </span>
            </div>

            <div style={{ fontSize: '12px', color: '#64748b', display: 'flex', gap: '12px' }}>
              <span data-testid="gate-duration">Thời gian: {evaluation.duration_ms}ms</span>
              <span data-testid="gate-evaluated-at">
                Lúc: {new Date(evaluation.evaluated_at).toLocaleString()}
              </span>
            </div>
          </div>

          <p
            data-testid="gate-summary-text"
            style={{
              margin: 0,
              fontSize: '13px',
              color: evaluation.passed ? '#166534' : '#9f1239',
              lineHeight: 1.5,
              fontWeight: 500,
            }}
          >
            {evaluation.summary}
          </p>

          {/* Quick Metrics Bar */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
              gap: '10px',
              marginTop: '4px',
            }}
          >
            <div
              data-testid="metric-commands-passed"
              style={{
                backgroundColor: '#ffffff',
                padding: '8px 12px',
                borderRadius: '6px',
                border: '1px solid #e2e8f0',
              }}
            >
              <div style={{ fontSize: '11px', color: '#64748b' }}>Lệnh thành công</div>
              <div style={{ fontSize: '16px', fontWeight: 700, color: '#16a34a' }}>
                {evaluation.evidence_summary.passedCommands} / {evaluation.evidence_summary.totalCommands}
              </div>
            </div>

            <div
              data-testid="metric-commands-failed"
              style={{
                backgroundColor: '#ffffff',
                padding: '8px 12px',
                borderRadius: '6px',
                border: '1px solid #e2e8f0',
              }}
            >
              <div style={{ fontSize: '11px', color: '#64748b' }}>Lệnh thất bại</div>
              <div
                style={{
                  fontSize: '16px',
                  fontWeight: 700,
                  color: evaluation.evidence_summary.failedCommands > 0 ? '#dc2626' : '#64748b',
                }}
              >
                {evaluation.evidence_summary.failedCommands}
              </div>
            </div>

            <div
              data-testid="metric-scope-clean"
              style={{
                backgroundColor: '#ffffff',
                padding: '8px 12px',
                borderRadius: '6px',
                border: '1px solid #e2e8f0',
              }}
            >
              <div style={{ fontSize: '11px', color: '#64748b' }}>Phạm vi (Scope)</div>
              <div
                style={{
                  fontSize: '13px',
                  fontWeight: 700,
                  color: evaluation.evidence_summary.outOfScopeFilesCount === 0 ? '#16a34a' : '#ea580c',
                  marginTop: '2px',
                }}
              >
                {evaluation.evidence_summary.outOfScopeFilesCount === 0
                  ? 'Sạch (0 file lạ)'
                  : `${evaluation.evidence_summary.outOfScopeFilesCount} file ngoài scope`}
              </div>
            </div>

            <div
              data-testid="metric-review-findings"
              style={{
                backgroundColor: '#ffffff',
                padding: '8px 12px',
                borderRadius: '6px',
                border: '1px solid #e2e8f0',
              }}
            >
              <div style={{ fontSize: '11px', color: '#64748b' }}>Review High/Critical</div>
              <div
                style={{
                  fontSize: '16px',
                  fontWeight: 700,
                  color:
                    evaluation.evidence_summary.reviewHighCount + evaluation.evidence_summary.reviewCriticalCount > 0
                      ? '#dc2626'
                      : '#16a34a',
                }}
              >
                {evaluation.evidence_summary.reviewHighCount + evaluation.evidence_summary.reviewCriticalCount}
              </div>
            </div>

            <div
              data-testid="metric-security-issues"
              style={{
                backgroundColor: '#ffffff',
                padding: '8px 12px',
                borderRadius: '6px',
                border: '1px solid #e2e8f0',
              }}
            >
              <div style={{ fontSize: '11px', color: '#64748b' }}>Bảo mật / Audit</div>
              <div
                style={{
                  fontSize: '13px',
                  fontWeight: 700,
                  color:
                    evaluation.evidence_summary.secretFindingsCount +
                      evaluation.evidence_summary.auditHighCriticalCount >
                    0
                      ? '#dc2626'
                      : '#16a34a',
                  marginTop: '2px',
                }}
              >
                {evaluation.evidence_summary.secretFindingsCount +
                  evaluation.evidence_summary.auditHighCriticalCount ===
                0
                  ? 'An toàn'
                  : `${evaluation.evidence_summary.secretFindingsCount} secret, ${evaluation.evidence_summary.auditHighCriticalCount} audit`}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Empty State when no evaluation and no records */}
      {!loading && !evaluation && effectiveCommandRecords.length === 0 && effectiveReviewFindings.length === 0 && (
        <div
          data-testid="evidence-empty"
          style={{
            padding: '40px 20px',
            textAlign: 'center',
            backgroundColor: '#f8fafc',
            borderRadius: '8px',
            border: '1px dashed #cbd5e1',
          }}
        >
          <div style={{ fontSize: '32px', marginBottom: '10px' }}>📊</div>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '16px', color: '#1e293b' }}>
            Chưa có bằng chứng kiểm định Quality Gate
          </h4>
          <p style={{ margin: '0 0 16px 0', fontSize: '13px', color: '#64748b', maxWidth: '480px', marginInline: 'auto' }}>
            Tác vụ này chưa được kích hoạt kiểm định hoặc chưa có lệnh test / review nào được ghi nhận.
          </p>
          {taskId && (
            <button
              type="button"
              data-testid="btn-run-first-verify"
              onClick={handleRunVerification}
              disabled={verifying}
              style={{
                padding: '8px 18px',
                fontSize: '13px',
                fontWeight: 600,
                color: '#ffffff',
                backgroundColor: '#2563eb',
                border: 'none',
                borderRadius: '6px',
                cursor: verifying ? 'not-allowed' : 'pointer',
              }}
            >
              {verifying ? 'Đang kiểm định...' : '⚡ Chạy Kiểm Định Ngay'}
            </button>
          )}
        </div>
      )}

      {/* Navigation Sub-Tabs */}
      <div
        style={{
          display: 'flex',
          gap: '6px',
          borderBottom: '2px solid #e2e8f0',
          paddingBottom: '2px',
        }}
      >
        <button
          type="button"
          data-testid="nav-rules-tab"
          onClick={() => setActiveSection('rules')}
          style={{
            padding: '8px 16px',
            fontSize: '13px',
            fontWeight: 600,
            color: activeSection === 'rules' ? '#2563eb' : '#64748b',
            backgroundColor: 'transparent',
            border: 'none',
            borderBottom: activeSection === 'rules' ? '2px solid #2563eb' : '2px solid transparent',
            marginBottom: '-4px',
            cursor: 'pointer',
          }}
        >
          Quy Tắc Quality Gate ({evaluation?.rule_evaluations?.length ?? 0})
        </button>

        <button
          type="button"
          data-testid="nav-commands-tab"
          onClick={() => setActiveSection('commands')}
          style={{
            padding: '8px 16px',
            fontSize: '13px',
            fontWeight: 600,
            color: activeSection === 'commands' ? '#2563eb' : '#64748b',
            backgroundColor: 'transparent',
            border: 'none',
            borderBottom: activeSection === 'commands' ? '2px solid #2563eb' : '2px solid transparent',
            marginBottom: '-4px',
            cursor: 'pointer',
          }}
        >
          Lệnh Kiểm Thử & Test ({effectiveCommandRecords.length})
        </button>

        <button
          type="button"
          data-testid="nav-findings-tab"
          onClick={() => setActiveSection('findings')}
          style={{
            padding: '8px 16px',
            fontSize: '13px',
            fontWeight: 600,
            color: activeSection === 'findings' ? '#2563eb' : '#64748b',
            backgroundColor: 'transparent',
            border: 'none',
            borderBottom: activeSection === 'findings' ? '2px solid #2563eb' : '2px solid transparent',
            marginBottom: '-4px',
            cursor: 'pointer',
          }}
        >
          Review Findings ({effectiveReviewFindings.length})
        </button>

        <button
          type="button"
          data-testid="nav-scope-tab"
          onClick={() => setActiveSection('scope_security')}
          style={{
            padding: '8px 16px',
            fontSize: '13px',
            fontWeight: 600,
            color: activeSection === 'scope_security' ? '#2563eb' : '#64748b',
            backgroundColor: 'transparent',
            border: 'none',
            borderBottom: activeSection === 'scope_security' ? '2px solid #2563eb' : '2px solid transparent',
            marginBottom: '-4px',
            cursor: 'pointer',
          }}
        >
          Scope & Bảo Mật
        </button>
      </div>

      {/* SECTION 1: RULE EVALUATIONS */}
      {activeSection === 'rules' && (
        <div data-testid="section-rule-evaluations" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {(!evaluation || evaluation.rule_evaluations.length === 0) ? (
            <div style={{ padding: '24px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>
              Chưa có dữ liệu đánh giá quy tắc Quality Gate.
            </div>
          ) : (
            evaluation.rule_evaluations.map((rule) => {
              const isPass = rule.status === 'PASSED';
              const isFail = rule.status === 'FAILED';
              const isWarning = rule.status === 'WARNING';
              const statusColor = isPass ? '#16a34a' : isFail ? '#dc2626' : isWarning ? '#d97706' : '#64748b';
              const statusBg = isPass ? '#dcfce7' : isFail ? '#fee2e2' : isWarning ? '#fef3c7' : '#f1f5f9';

              return (
                <div
                  key={rule.rule_id}
                  data-testid={`rule-item-${rule.rule_id}`}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                    padding: '12px 14px',
                    backgroundColor: '#ffffff',
                    border: `1px solid ${isFail ? '#fecaca' : '#e2e8f0'}`,
                    borderLeft: `4px solid ${statusColor}`,
                    borderRadius: '6px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span
                        data-testid={`rule-status-${rule.rule_id}`}
                        style={{
                          fontSize: '11px',
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: '4px',
                          backgroundColor: statusBg,
                          color: statusColor,
                        }}
                      >
                        {rule.status}
                      </span>
                      <span data-testid={`rule-name-${rule.rule_id}`} style={{ fontWeight: 600, fontSize: '13px', color: '#0f172a' }}>
                        {rule.name}
                      </span>
                    </div>

                    <div style={{ display: 'flex', gap: '6px' }}>
                      <span
                        data-testid={`rule-stage-${rule.rule_id}`}
                        style={{
                          fontSize: '11px',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          backgroundColor: '#f1f5f9',
                          color: '#475569',
                        }}
                      >
                        stage: {rule.stage}
                      </span>
                      <span
                        style={{
                          fontSize: '11px',
                          padding: '2px 6px',
                          borderRadius: '4px',
                          backgroundColor: '#f8fafc',
                          color: '#94a3b8',
                          fontFamily: 'monospace',
                        }}
                      >
                        {rule.rule_id}
                      </span>
                    </div>
                  </div>

                  <p
                    data-testid={`rule-message-${rule.rule_id}`}
                    style={{
                      margin: 0,
                      fontSize: '13px',
                      color: isFail ? '#b91c1c' : '#334155',
                      lineHeight: 1.4,
                    }}
                  >
                    {rule.message}
                  </p>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* SECTION 2: QUALITY COMMAND RECORDS / TEST REPORT */}
      {activeSection === 'commands' && (
        <div data-testid="section-quality-commands" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* Controls / Filter Bar */}
          <div
            data-testid="command-filters-bar"
            style={{
              display: 'flex',
              gap: '10px',
              flexWrap: 'wrap',
              alignItems: 'center',
              backgroundColor: '#f8fafc',
              padding: '10px 12px',
              borderRadius: '6px',
            }}
          >
            <input
              type="text"
              data-testid="search-commands-input"
              placeholder="🔍 Tìm lệnh kiểm thử..."
              value={commandSearch}
              onChange={(e) => setCommandSearch(e.target.value)}
              style={{
                padding: '6px 10px',
                fontSize: '12px',
                borderRadius: '4px',
                border: '1px solid #cbd5e1',
                flexGrow: 1,
                minWidth: '180px',
              }}
            />

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '12px', color: '#64748b' }}>Giai đoạn:</span>
              <select
                data-testid="filter-command-stage"
                value={stageFilter}
                onChange={(e) => setStageFilter(e.target.value)}
                style={{
                  fontSize: '12px',
                  padding: '5px 8px',
                  borderRadius: '4px',
                  border: '1px solid #cbd5e1',
                  backgroundColor: '#ffffff',
                }}
              >
                <option value="all">Tất cả giai đoạn</option>
                <option value="test">Test</option>
                <option value="lint">Lint</option>
                <option value="typecheck">Typecheck</option>
                <option value="build">Build</option>
                <option value="security">Security</option>
                <option value="custom">Custom</option>
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '12px', color: '#64748b' }}>Trạng thái:</span>
              <select
                data-testid="filter-command-status"
                value={commandStatusFilter}
                onChange={(e) => setCommandStatusFilter(e.target.value)}
                style={{
                  fontSize: '12px',
                  padding: '5px 8px',
                  borderRadius: '4px',
                  border: '1px solid #cbd5e1',
                  backgroundColor: '#ffffff',
                }}
              >
                <option value="all">Tất cả kết quả</option>
                <option value="passed">Thành công (Exit 0)</option>
                <option value="failed">Thất bại (Non-zero)</option>
              </select>
            </div>
          </div>

          {/* Commands List */}
          {filteredCommands.length === 0 ? (
            <div data-testid="commands-empty" style={{ padding: '24px', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>
              Không có lệnh kiểm thử nào khớp với bộ lọc.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {filteredCommands.map((cmd) => {
                const isPassed = cmd.status === 'SUCCESS' || cmd.exit_code === 0;
                const isExpanded = !!expandedCommands[cmd.id];

                return (
                  <div
                    key={cmd.id}
                    data-testid={`command-item-${cmd.id}`}
                    style={{
                      border: `1px solid ${isPassed ? '#e2e8f0' : '#fecaca'}`,
                      borderRadius: '6px',
                      backgroundColor: '#ffffff',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        padding: '10px 14px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: '8px',
                        backgroundColor: isPassed ? '#f8fafc' : '#fff5f5',
                        borderBottom: isExpanded ? '1px solid #e2e8f0' : 'none',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span
                          data-testid={`cmd-exit-code-${cmd.id}`}
                          style={{
                            fontSize: '11px',
                            fontWeight: 700,
                            padding: '2px 8px',
                            borderRadius: '4px',
                            backgroundColor: isPassed ? '#dcfce7' : '#fee2e2',
                            color: isPassed ? '#16a34a' : '#dc2626',
                          }}
                        >
                          Exit {cmd.exit_code ?? 'NULL'}
                        </span>

                        <span
                          data-testid={`cmd-stage-${cmd.id}`}
                          style={{
                            fontSize: '11px',
                            fontWeight: 600,
                            padding: '2px 6px',
                            borderRadius: '4px',
                            backgroundColor: '#e0f2fe',
                            color: '#0369a1',
                          }}
                        >
                          {cmd.stage}
                        </span>

                        <code
                          data-testid={`cmd-string-${cmd.id}`}
                          style={{
                            fontSize: '13px',
                            fontWeight: 600,
                            color: '#0f172a',
                            fontFamily: 'monospace',
                          }}
                        >
                          {cmd.command}
                        </code>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span data-testid={`cmd-duration-${cmd.id}`} style={{ fontSize: '12px', color: '#64748b' }}>
                          {cmd.duration_ms}ms
                        </span>

                        <button
                          type="button"
                          data-testid={`cmd-toggle-output-${cmd.id}`}
                          onClick={() => toggleCommandExpanded(cmd.id)}
                          style={{
                            fontSize: '12px',
                            fontWeight: 600,
                            padding: '4px 8px',
                            borderRadius: '4px',
                            backgroundColor: '#ffffff',
                            border: '1px solid #cbd5e1',
                            color: '#475569',
                            cursor: 'pointer',
                          }}
                        >
                          {isExpanded ? 'Ẩn Output ▲' : 'Xem Output ▼'}
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div style={{ padding: '12px', backgroundColor: '#0f172a', color: '#f8fafc' }}>
                        {cmd.stdout && (
                          <div style={{ marginBottom: cmd.stderr ? '10px' : 0 }}>
                            <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '4px', fontWeight: 600 }}>STDOUT:</div>
                            <pre
                              data-testid={`cmd-stdout-${cmd.id}`}
                              style={{
                                margin: 0,
                                fontSize: '12px',
                                fontFamily: 'monospace',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                                color: '#a7f3d0',
                                maxHeight: '250px',
                                overflowY: 'auto',
                              }}
                            >
                              {cmd.stdout}
                            </pre>
                          </div>
                        )}

                        {cmd.stderr && (
                          <div>
                            <div style={{ fontSize: '11px', color: '#fca5a5', marginBottom: '4px', fontWeight: 600 }}>STDERR:</div>
                            <pre
                              data-testid={`cmd-stderr-${cmd.id}`}
                              style={{
                                margin: 0,
                                fontSize: '12px',
                                fontFamily: 'monospace',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-all',
                                color: '#fca5a5',
                                maxHeight: '250px',
                                overflowY: 'auto',
                              }}
                            >
                              {cmd.stderr}
                            </pre>
                          </div>
                        )}

                        {!cmd.stdout && !cmd.stderr && (
                          <div style={{ fontSize: '12px', color: '#64748b', fontStyle: 'italic' }}>
                            Không có dữ liệu log stdout/stderr cho lệnh này.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* SECTION 3: REVIEW FINDINGS (QLT-004) */}
      {activeSection === 'findings' && (
        <div data-testid="section-review-findings" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* Severity Badges & Filter Bar */}
          <div
            data-testid="finding-filters-bar"
            style={{
              display: 'flex',
              gap: '8px',
              flexWrap: 'wrap',
              alignItems: 'center',
              backgroundColor: '#f8fafc',
              padding: '10px 12px',
              borderRadius: '6px',
            }}
          >
            <input
              type="text"
              data-testid="search-findings-input"
              placeholder="🔍 Tìm file, thông điệp hoặc category..."
              value={findingSearch}
              onChange={(e) => setFindingSearch(e.target.value)}
              style={{
                padding: '6px 10px',
                fontSize: '12px',
                borderRadius: '4px',
                border: '1px solid #cbd5e1',
                flexGrow: 1,
                minWidth: '200px',
              }}
            />

            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {(['all', 'critical', 'high', 'medium', 'low', 'info'] as const).map((sev) => {
                const isSelected = severityFilter === sev;
                const count = sev === 'all' ? effectiveReviewFindings.length : severityCounts[sev as FindingSeverity];

                return (
                  <button
                    key={sev}
                    type="button"
                    data-testid={`filter-severity-${sev}`}
                    onClick={() => setSeverityFilter(sev)}
                    style={{
                      padding: '4px 10px',
                      fontSize: '11px',
                      fontWeight: 600,
                      borderRadius: '4px',
                      border: '1px solid',
                      borderColor: isSelected ? '#2563eb' : '#cbd5e1',
                      backgroundColor: isSelected ? '#2563eb' : '#ffffff',
                      color: isSelected ? '#ffffff' : '#475569',
                      cursor: 'pointer',
                    }}
                  >
                    {sev.toUpperCase()} ({count})
                  </button>
                );
              })}
            </div>
          </div>

          {/* Findings List */}
          {filteredFindings.length === 0 ? (
            <div
              data-testid="findings-empty-clean"
              style={{
                padding: '30px 20px',
                textAlign: 'center',
                backgroundColor: '#f0fdf4',
                border: '1px solid #bbf7d0',
                borderRadius: '6px',
                color: '#166534',
                fontSize: '13px',
                fontWeight: 600,
              }}
            >
              ✅ Không phát hiện vi phạm nào trong mã nguồn hoặc bộ lọc đã chọn!
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {filteredFindings.map((finding) => {
                const sev = finding.severity;
                const isCrit = sev === 'critical';
                const isHigh = sev === 'high';
                const isMed = sev === 'medium';
                const sevBg = isCrit ? '#fee2e2' : isHigh ? '#ffedd5' : isMed ? '#fef3c7' : '#f1f5f9';
                const sevColor = isCrit ? '#dc2626' : isHigh ? '#ea580c' : isMed ? '#d97706' : '#475569';

                return (
                  <div
                    key={finding.id}
                    data-testid={`finding-item-${finding.id}`}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      padding: '12px 14px',
                      backgroundColor: '#ffffff',
                      borderRadius: '6px',
                      border: `1px solid ${isCrit || isHigh ? '#fca5a5' : '#e2e8f0'}`,
                      borderLeft: `4px solid ${sevColor}`,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span
                          data-testid={`badge-severity-${sev}`}
                          style={{
                            fontSize: '11px',
                            fontWeight: 700,
                            padding: '2px 8px',
                            borderRadius: '4px',
                            backgroundColor: sevBg,
                            color: sevColor,
                          }}
                        >
                          {sev.toUpperCase()}
                        </span>

                        <span
                          data-testid={`finding-file-line-${finding.id}`}
                          style={{
                            fontSize: '13px',
                            fontWeight: 600,
                            color: '#1e293b',
                            fontFamily: 'monospace',
                          }}
                        >
                          {finding.file}:{finding.line}
                        </span>
                      </div>

                      <div style={{ display: 'flex', gap: '6px' }}>
                        {finding.category && (
                          <span
                            data-testid={`finding-category-${finding.id}`}
                            style={{
                              fontSize: '11px',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              backgroundColor: '#f1f5f9',
                              color: '#64748b',
                            }}
                          >
                            {finding.category}
                          </span>
                        )}

                        {finding.rule_id && (
                          <span
                            data-testid={`finding-rule-${finding.id}`}
                            style={{
                              fontSize: '11px',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              backgroundColor: '#f8fafc',
                              color: '#94a3b8',
                              fontFamily: 'monospace',
                            }}
                          >
                            {finding.rule_id}
                          </span>
                        )}
                      </div>
                    </div>

                    <p
                      data-testid={`finding-message-${finding.id}`}
                      style={{
                        margin: 0,
                        fontSize: '13px',
                        color: '#334155',
                        lineHeight: 1.4,
                      }}
                    >
                      {finding.message}
                    </p>

                    {finding.suggestion && (
                      <div
                        data-testid={`finding-suggestion-${finding.id}`}
                        style={{
                          padding: '8px 10px',
                          backgroundColor: '#f8fafc',
                          border: '1px dashed #cbd5e1',
                          borderRadius: '4px',
                          fontSize: '12px',
                          color: '#475569',
                          lineHeight: 1.4,
                        }}
                      >
                        <span style={{ fontWeight: 600, color: '#0369a1' }}>💡 Gợi ý khắc phục: </span>
                        {finding.suggestion}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* SECTION 4: SCOPE & SECURITY EVIDENCE */}
      {activeSection === 'scope_security' && (
        <div data-testid="section-scope-security" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Scope Card */}
          <div
            data-testid="card-scope-evidence"
            style={{
              padding: '16px',
              backgroundColor: '#ffffff',
              borderRadius: '6px',
              border: '1px solid #e2e8f0',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#0f172a' }}>
                📁 Bằng Chứng Kiểm Tra Phạm Vi Task (QLT-003)
              </h4>
              <span
                data-testid="scope-status-badge"
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  padding: '2px 8px',
                  borderRadius: '4px',
                  backgroundColor:
                    evaluation?.evidence_summary.outOfScopeFilesCount === 0 ? '#dcfce7' : '#fee2e2',
                  color:
                    evaluation?.evidence_summary.outOfScopeFilesCount === 0 ? '#16a34a' : '#dc2626',
                }}
              >
                {evaluation?.evidence_summary.outOfScopeFilesCount === 0 ? 'SẠCH PHẠM VI' : 'PHÁT HIỆN FILE LẠ'}
              </span>
            </div>

            {evaluation?.evidence_summary.outOfScopeFiles && evaluation.evidence_summary.outOfScopeFiles.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '12px', color: '#dc2626', fontWeight: 600 }}>
                  Các file bị sửa ngoài danh sách cho phép của task:
                </span>
                <div data-testid="evidence-scope-files" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {evaluation.evidence_summary.outOfScopeFiles.map((file) => (
                    <span
                      key={file}
                      style={{
                        fontSize: '11px',
                        padding: '3px 8px',
                        borderRadius: '4px',
                        backgroundColor: '#fee2e2',
                        color: '#991b1b',
                        fontFamily: 'monospace',
                      }}
                    >
                      {file}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <p style={{ margin: 0, fontSize: '13px', color: '#16a34a' }}>
                ✅ Tất cả các tập tin sửa đổi đều nằm trong phạm vi chỉ định.
              </p>
            )}
          </div>

          {/* Security & Audit Card */}
          <div
            data-testid="card-security-evidence"
            style={{
              padding: '16px',
              backgroundColor: '#ffffff',
              borderRadius: '6px',
              border: '1px solid #e2e8f0',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#0f172a' }}>
                🔒 Bằng Chứng Bảo Mật & Lỗ Hổng Phụ Thuộc (QLT-005)
              </h4>
              <span
                data-testid="security-status-badge"
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  padding: '2px 8px',
                  borderRadius: '4px',
                  backgroundColor:
                    (evaluation?.evidence_summary.secretFindingsCount ?? 0) +
                      (evaluation?.evidence_summary.auditHighCriticalCount ?? 0) ===
                    0
                      ? '#dcfce7'
                      : '#fee2e2',
                  color:
                    (evaluation?.evidence_summary.secretFindingsCount ?? 0) +
                      (evaluation?.evidence_summary.auditHighCriticalCount ?? 0) ===
                    0
                      ? '#16a34a'
                      : '#dc2626',
                }}
              >
                {(evaluation?.evidence_summary.secretFindingsCount ?? 0) +
                  (evaluation?.evidence_summary.auditHighCriticalCount ?? 0) ===
                0
                  ? 'AN TOÀN BẢO MẬT'
                  : 'CÓ LỖ HỔNG / SECRET'}
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div style={{ padding: '10px', backgroundColor: '#f8fafc', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '2px' }}>Secret Scan (Quét bí mật):</div>
                <div
                  data-testid="evidence-secrets-count"
                  style={{
                    fontSize: '14px',
                    fontWeight: 700,
                    color: (evaluation?.evidence_summary.secretFindingsCount ?? 0) > 0 ? '#dc2626' : '#16a34a',
                  }}
                >
                  {evaluation?.evidence_summary.secretFindingsCount ?? 0} phát hiện
                </div>
              </div>

              <div style={{ padding: '10px', backgroundColor: '#f8fafc', borderRadius: '4px', border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '2px' }}>Lỗ hổng pnpm audit (High/Critical):</div>
                <div
                  data-testid="evidence-audit-count"
                  style={{
                    fontSize: '14px',
                    fontWeight: 700,
                    color: (evaluation?.evidence_summary.auditHighCriticalCount ?? 0) > 0 ? '#dc2626' : '#16a34a',
                  }}
                >
                  {evaluation?.evidence_summary.auditHighCriticalCount ?? 0} lỗ hổng
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
