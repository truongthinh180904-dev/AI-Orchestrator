'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  type TaskWithDependencies,
  type TaskRunHistory,
  type RunDetail,
  type TaskAttemptHistoryItem,
  type Checkpoint,
  type Report,
  type EventRecord,
} from '@ai-orchestrator/shared';
import { ApiClient, api as defaultApi } from '../lib/api.js';
import { StatusBadge } from './StatusBadge.js';
import { LiveLogViewer } from './LiveLogViewer.js';
import { DiffViewer } from './DiffViewer.js';
import { TestReportReviewFindings } from './TestReportReviewFindings.js';

export interface TaskDetailProps {
  taskId: string;
  apiClient?: ApiClient;
}

export type InspectorTab = 'checkpoints' | 'reports' | 'events' | 'live' | 'diff' | 'quality';

export const TaskDetail: React.FC<TaskDetailProps> = ({ taskId, apiClient }) => {
  const client = apiClient ?? defaultApi;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [task, setTask] = useState<TaskWithDependencies | null>(null);
  const [history, setHistory] = useState<TaskRunHistory | null>(null);

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] = useState<RunDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<InspectorTab>('checkpoints');

  // Load deep detail for a specific run
  const loadRunDetail = useCallback(
    async (runId: string) => {
      setSelectedRunId(runId);
      setLoadingDetail(true);
      setDetailError(null);
      try {
        const detail = await client.getRunDetail(runId);
        setSelectedRunDetail(detail);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setDetailError(message);
        setSelectedRunDetail(null);
      } finally {
        setLoadingDetail(false);
      }
    },
    [client],
  );

  // Main data fetcher
  const loadTaskData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [taskData, historyData] = await Promise.all([
        client.getTask(taskId),
        client.getTaskHistory(taskId),
      ]);
      setTask(taskData);
      setHistory(historyData);

      // Auto-select latest run or first attempt if history has runs
      const runs = historyData?.history ?? [];
      if (runs.length > 0) {
        const latestAttempt = runs[runs.length - 1];
        if (latestAttempt?.run?.id) {
          await loadRunDetail(latestAttempt.run.id);
        }
      } else {
        setSelectedRunId(null);
        setSelectedRunDetail(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [client, taskId, loadRunDetail]);

  useEffect(() => {
    void loadTaskData();
  }, [loadTaskData]);

  // Handle format duration
  const formatDuration = (ms: number | null | undefined): string => {
    if (ms == null) return 'N/A';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  // Handle format timestamp
  const formatTimestamp = (iso: string | null | undefined): string => {
    if (!iso) return 'N/A';
    try {
      const d = new Date(iso);
      return d.toLocaleString('vi-VN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  // --- LOADING STATE ---
  if (loading) {
    return (
      <div
        data-testid="loading-task-detail"
        style={{
          padding: '48px 24px',
          textAlign: 'center',
          backgroundColor: '#ffffff',
          borderRadius: '12px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
          border: '1px solid #e2e8f0',
          margin: '24px 0',
        }}
      >
        <div
          style={{
            display: 'inline-block',
            width: '36px',
            height: '36px',
            border: '4px solid #cbd5e1',
            borderTopColor: '#2563eb',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
            marginBottom: '16px',
          }}
        />
        <p style={{ margin: 0, color: '#475569', fontSize: '15px', fontWeight: 500 }}>
          Đang tải thông tin chi tiết tác vụ {taskId}...
        </p>
      </div>
    );
  }

  // --- ERROR STATE ---
  if (error || !task) {
    return (
      <div
        data-testid="task-error-banner"
        style={{
          padding: '24px',
          backgroundColor: '#fef2f2',
          border: '1px solid #f87171',
          borderRadius: '12px',
          margin: '24px 0',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
          <span style={{ fontSize: '24px' }}>⚠️</span>
          <div>
            <h3 style={{ margin: 0, color: '#991b1b', fontSize: '18px', fontWeight: 600 }}>
              Không thể tải thông tin tác vụ
            </h3>
            <p style={{ margin: '4px 0 0 0', color: '#b91c1c', fontSize: '14px' }}>
              {error ?? 'Không tìm thấy dữ liệu tác vụ.'}
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
          <button
            type="button"
            data-testid="btn-retry-task"
            onClick={() => void loadTaskData()}
            style={{
              padding: '8px 16px',
              backgroundColor: '#dc2626',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              fontWeight: 500,
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            Thử lại
          </button>
          <a
            href="/tasks"
            data-testid="link-back-tasks-error"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '8px 16px',
              backgroundColor: '#ffffff',
              color: '#475569',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              fontWeight: 500,
              fontSize: '13px',
              textDecoration: 'none',
            }}
          >
            ← Quay lại danh sách
          </a>
        </div>
      </div>
    );
  }

  const attemptsHistory: TaskAttemptHistoryItem[] = history?.history ?? [];
  const selectedAttempt = attemptsHistory.find((item) => item.run.id === selectedRunId);

  return (
    <div
      data-testid="task-detail-view"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '24px',
        maxWidth: '1280px',
        margin: '0 auto',
        padding: '8px 0 32px 0',
      }}
    >
      {/* 1. Header & Navigation */}
      <div
        data-testid="task-detail-header"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          backgroundColor: '#ffffff',
          padding: '24px',
          borderRadius: '12px',
          border: '1px solid #e2e8f0',
          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <a
            href="/tasks"
            data-testid="link-back-tasks"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              color: '#2563eb',
              textDecoration: 'none',
              fontSize: '14px',
              fontWeight: 500,
            }}
          >
            ← Quay lại Danh sách Tác vụ
          </a>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button
              type="button"
              data-testid="btn-refresh-task"
              onClick={() => void loadTaskData()}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 14px',
                backgroundColor: '#f8fafc',
                color: '#334155',
                border: '1px solid #cbd5e1',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              🔄 Làm mới
            </button>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: '16px',
          }}
        >
          <div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                flexWrap: 'wrap',
                marginBottom: '8px',
              }}
            >
              <span
                data-testid="task-id-badge"
                style={{
                  fontFamily: 'monospace',
                  fontSize: '14px',
                  fontWeight: 700,
                  backgroundColor: '#f1f5f9',
                  color: '#0f172a',
                  padding: '3px 8px',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                }}
              >
                {task.id}
              </span>
              <StatusBadge status={task.status} size="md" />
              <span
                data-testid="task-phase-badge"
                style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  backgroundColor: '#f8fafc',
                  color: '#475569',
                  padding: '3px 8px',
                  borderRadius: '6px',
                  border: '1px solid #e2e8f0',
                }}
              >
                Phase: {task.phase}
              </span>
              {task.feature_id && (
                <span
                  data-testid="task-feature-badge"
                  style={{
                    fontSize: '12px',
                    fontWeight: 600,
                    backgroundColor: '#eff6ff',
                    color: '#1d4ed8',
                    padding: '3px 8px',
                    borderRadius: '6px',
                    border: '1px solid #bfdbfe',
                  }}
                >
                  Feature: {task.feature_id}
                </span>
              )}
            </div>

            <h1
              data-testid="task-title"
              style={{
                margin: 0,
                fontSize: '22px',
                fontWeight: 700,
                color: '#0f172a',
                lineHeight: 1.3,
              }}
            >
              {task.title}
            </h1>
          </div>
        </div>
      </div>

      {/* 2. Task Information Card */}
      <div
        data-testid="task-info-card"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
          backgroundColor: '#ffffff',
          padding: '24px',
          borderRadius: '12px',
          border: '1px solid #e2e8f0',
          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: '16px',
            fontWeight: 700,
            color: '#1e293b',
            borderBottom: '1px solid #f1f5f9',
            paddingBottom: '10px',
          }}
        >
          Thông tin cấu hình Tác vụ
        </h2>

        <div>
          <h4
            style={{
              margin: '0 0 6px 0',
              fontSize: '12px',
              fontWeight: 600,
              textTransform: 'uppercase',
              color: '#64748b',
              letterSpacing: '0.05em',
            }}
          >
            Mô tả
          </h4>
          <p
            data-testid="task-description"
            style={{
              margin: 0,
              fontSize: '14px',
              lineHeight: 1.6,
              color: '#334155',
              whiteSpace: 'pre-wrap',
            }}
          >
            {task.description || '(Không có mô tả)'}
          </p>
        </div>

        {/* Metadata Grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '16px',
            backgroundColor: '#f8fafc',
            padding: '16px',
            borderRadius: '8px',
            border: '1px solid #e2e8f0',
          }}
        >
          <div>
            <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>Lần chạy</div>
            <div
              data-testid="task-attempts-metric"
              style={{ fontSize: '15px', fontWeight: 600, color: '#0f172a' }}
            >
              {task.attempts} / {task.max_attempts}
            </div>
          </div>

          <div>
            <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>
              Mức ưu tiên
            </div>
            <div
              data-testid="task-priority"
              style={{ fontSize: '15px', fontWeight: 600, color: '#0f172a' }}
            >
              {task.priority}
            </div>
          </div>

          <div>
            <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>
              Worker Type
            </div>
            <div
              data-testid="task-worker-type"
              style={{
                fontSize: '15px',
                fontWeight: 600,
                color: '#0f172a',
                fontFamily: 'monospace',
              }}
            >
              {task.worker_type}
            </div>
          </div>

          <div>
            <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>
              Repository
            </div>
            <div
              data-testid="task-repository"
              style={{
                fontSize: '15px',
                fontWeight: 600,
                color: '#0f172a',
                fontFamily: 'monospace',
              }}
            >
              {task.repository}
            </div>
          </div>

          <div>
            <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>Timeout</div>
            <div
              data-testid="task-timeout"
              style={{ fontSize: '15px', fontWeight: 600, color: '#0f172a' }}
            >
              {task.timeout_minutes} phút
            </div>
          </div>
        </div>

        {/* Dependencies */}
        <div data-testid="task-dependencies">
          <h4
            style={{
              margin: '0 0 8px 0',
              fontSize: '12px',
              fontWeight: 600,
              textTransform: 'uppercase',
              color: '#64748b',
              letterSpacing: '0.05em',
            }}
          >
            Dependencies ({task.dependencies?.length ?? 0})
          </h4>
          {task.dependencies && task.dependencies.length > 0 ? (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {task.dependencies.map((depId) => (
                <a
                  key={depId}
                  href={`/tasks/${encodeURIComponent(depId)}`}
                  data-testid={`task-dep-${depId}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '4px 10px',
                    backgroundColor: '#f1f5f9',
                    color: '#1d4ed8',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontWeight: 600,
                    textDecoration: 'none',
                    fontFamily: 'monospace',
                    border: '1px solid #cbd5e1',
                  }}
                >
                  🔗 {depId}
                </a>
              ))}
            </div>
          ) : (
            <span style={{ fontSize: '13px', color: '#94a3b8', fontStyle: 'italic' }}>
              Không có dependencies
            </span>
          )}
        </div>

        {/* Acceptance Criteria */}
        <div data-testid="task-acceptance-criteria">
          <h4
            style={{
              margin: '0 0 8px 0',
              fontSize: '12px',
              fontWeight: 600,
              textTransform: 'uppercase',
              color: '#64748b',
              letterSpacing: '0.05em',
            }}
          >
            Tiêu chí nghiệm thu ({task.acceptance_criteria?.length ?? 0})
          </h4>
          {task.acceptance_criteria && task.acceptance_criteria.length > 0 ? (
            <ul
              style={{
                margin: 0,
                paddingLeft: '20px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
              }}
            >
              {task.acceptance_criteria.map((criterion, idx) => (
                <li
                  key={idx}
                  data-testid={`task-criterion-${idx}`}
                  style={{ fontSize: '14px', color: '#334155' }}
                >
                  {criterion}
                </li>
              ))}
            </ul>
          ) : (
            <span style={{ fontSize: '13px', color: '#94a3b8', fontStyle: 'italic' }}>
              Không có tiêu chí nghiệm thu cụ thể
            </span>
          )}
        </div>

        {/* Test Commands */}
        <div data-testid="task-test-commands">
          <h4
            style={{
              margin: '0 0 8px 0',
              fontSize: '12px',
              fontWeight: 600,
              textTransform: 'uppercase',
              color: '#64748b',
              letterSpacing: '0.05em',
            }}
          >
            Lệnh kiểm thử (Test Commands)
          </h4>
          {task.test_commands && task.test_commands.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {task.test_commands.map((cmd, idx) => (
                <pre
                  key={idx}
                  data-testid={`task-test-cmd-${idx}`}
                  style={{
                    margin: 0,
                    padding: '8px 12px',
                    backgroundColor: '#0f172a',
                    color: '#38bdf8',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontFamily: 'monospace',
                    overflowX: 'auto',
                  }}
                >
                  $ {cmd}
                </pre>
              ))}
            </div>
          ) : (
            <span style={{ fontSize: '13px', color: '#94a3b8', fontStyle: 'italic' }}>
              Chưa thiết lập lệnh kiểm thử
            </span>
          )}
        </div>

        {/* Scope Files */}
        {task.scope_files && task.scope_files.length > 0 && (
          <div data-testid="task-scope-files">
            <h4
              style={{
                margin: '0 0 8px 0',
                fontSize: '12px',
                fontWeight: 600,
                textTransform: 'uppercase',
                color: '#64748b',
                letterSpacing: '0.05em',
              }}
            >
              Phạm vi file (Scope Files)
            </h4>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {task.scope_files.map((file, idx) => (
                <span
                  key={idx}
                  data-testid={`task-scope-file-${idx}`}
                  style={{
                    fontFamily: 'monospace',
                    fontSize: '12px',
                    backgroundColor: '#f1f5f9',
                    color: '#334155',
                    padding: '3px 8px',
                    borderRadius: '4px',
                    border: '1px solid #e2e8f0',
                  }}
                >
                  {file}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 3. Execution History & Timeline ("Lịch sử thật" - ORC-005) */}
      <div
        data-testid="task-run-timeline"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '20px',
          backgroundColor: '#ffffff',
          padding: '24px',
          borderRadius: '12px',
          border: '1px solid #e2e8f0',
          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '12px',
          }}
        >
          <div>
            <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>
              Lịch sử thực thi (Execution Timeline)
            </h2>
            <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#64748b' }}>
              Dấu vết kiểm toán thực tế qua các lần chạy (attempt, checkpoints, kết quả, reports)
            </p>
          </div>

          {/* Timeline Summary Bar */}
          <div
            data-testid="timeline-summary-bar"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              backgroundColor: '#f8fafc',
              padding: '6px 14px',
              borderRadius: '8px',
              border: '1px solid #e2e8f0',
            }}
          >
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#0f172a' }}>
              Tổng: {attemptsHistory.length} lần chạy
            </span>
            {history?.latestRun && (
              <>
                <span style={{ color: '#cbd5e1' }}>•</span>
                <span style={{ fontSize: '12px', color: '#64748b' }}>Mới nhất:</span>
                <StatusBadge status={history.latestRun.status} size="sm" />
              </>
            )}
          </div>
        </div>

        {/* Empty History State */}
        {attemptsHistory.length === 0 ? (
          <div
            data-testid="empty-timeline-state"
            style={{
              padding: '40px 24px',
              textAlign: 'center',
              backgroundColor: '#f8fafc',
              borderRadius: '8px',
              border: '1px dashed #cbd5e1',
            }}
          >
            <span style={{ fontSize: '32px', display: 'block', marginBottom: '8px' }}>⏳</span>
            <h3
              style={{ margin: '0 0 6px 0', fontSize: '16px', fontWeight: 600, color: '#1e293b' }}
            >
              Chưa có lần chạy nào
            </h3>
            <p style={{ margin: 0, fontSize: '14px', color: '#64748b' }}>
              Task đang ở trạng thái <strong>{task.status}</strong> và chưa được worker điều phối
              thực thi.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* Attempts Cards List */}
            <div
              data-testid="task-attempts-list"
              style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
            >
              <h4
                style={{
                  margin: 0,
                  fontSize: '13px',
                  fontWeight: 600,
                  color: '#475569',
                  textTransform: 'uppercase',
                }}
              >
                Danh sách các lần chạy ({attemptsHistory.length})
              </h4>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
                  gap: '12px',
                }}
              >
                {attemptsHistory.map((item) => {
                  const isSelected = item.run.id === selectedRunId;
                  const isFailed =
                    item.result?.outcome === 'ERROR' ||
                    item.result?.outcome === 'TIMEOUT' ||
                    item.run.status === 'ERROR';

                  return (
                    <div
                      key={item.run.id}
                      data-testid={`run-attempt-card-${item.attempt}`}
                      onClick={() => void loadRunDetail(item.run.id)}
                      style={{
                        padding: '16px',
                        borderRadius: '8px',
                        border: isSelected ? '2px solid #2563eb' : '1px solid #e2e8f0',
                        backgroundColor: isSelected ? '#eff6ff' : '#ffffff',
                        boxShadow: isSelected
                          ? '0 2px 6px rgba(37,99,235,0.1)'
                          : '0 1px 2px rgba(0,0,0,0.02)',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease-in-out',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '10px',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span
                            style={{
                              fontSize: '13px',
                              fontWeight: 700,
                              color: '#0f172a',
                              backgroundColor: '#e2e8f0',
                              padding: '2px 8px',
                              borderRadius: '4px',
                            }}
                          >
                            Attempt #{item.attempt}
                          </span>
                          <span
                            style={{ fontSize: '12px', fontFamily: 'monospace', color: '#64748b' }}
                          >
                            {item.run.id}
                          </span>
                        </div>
                        <StatusBadge status={item.run.status} size="sm" />
                      </div>

                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '1fr 1fr',
                          gap: '8px',
                          fontSize: '12px',
                          color: '#475569',
                        }}
                      >
                        <div>
                          <strong>Outcome:</strong>{' '}
                          <span
                            style={{ fontWeight: 600, color: isFailed ? '#dc2626' : '#16a34a' }}
                          >
                            {item.result?.outcome ?? item.run.status}
                          </span>
                        </div>
                        <div>
                          <strong>Thời lượng:</strong> {formatDuration(item.result?.duration_ms)}
                        </div>
                        <div>
                          <strong>Exit Code:</strong>{' '}
                          {item.run.exit_code != null ? item.run.exit_code : '--'}
                        </div>
                        <div>
                          <strong>Checkpoints:</strong>{' '}
                          {item.result?.checkpoint_count ?? item.checkpoints?.length ?? 0}
                        </div>
                      </div>

                      <div
                        style={{
                          fontSize: '11px',
                          color: '#64748b',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '2px',
                        }}
                      >
                        <div>Bắt đầu: {formatTimestamp(item.run.started_at)}</div>
                        <div>Kết thúc: {formatTimestamp(item.run.finished_at)}</div>
                        {(item.run.branch || item.run.commit_sha) && (
                          <div style={{ fontFamily: 'monospace', marginTop: '2px' }}>
                            {item.run.branch && <span>🌱 {item.run.branch} </span>}
                            {item.run.commit_sha && (
                              <span>(SHA: {item.run.commit_sha.slice(0, 7)})</span>
                            )}
                          </div>
                        )}
                      </div>

                      {item.result?.error_message && (
                        <div
                          data-testid={`run-error-msg-${item.run.id}`}
                          style={{
                            padding: '6px 10px',
                            backgroundColor: '#fee2e2',
                            color: '#991b1b',
                            borderRadius: '4px',
                            fontSize: '12px',
                            fontWeight: 500,
                          }}
                        >
                          ⚠️ {item.result.error_message}
                        </div>
                      )}

                      <div
                        style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '4px' }}
                      >
                        <button
                          type="button"
                          data-testid={`btn-inspect-run-${item.run.id}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            void loadRunDetail(item.run.id);
                          }}
                          style={{
                            padding: '4px 10px',
                            backgroundColor: isSelected ? '#2563eb' : '#f8fafc',
                            color: isSelected ? '#ffffff' : '#334155',
                            border: `1px solid ${isSelected ? '#2563eb' : '#cbd5e1'}`,
                            borderRadius: '4px',
                            fontSize: '12px',
                            fontWeight: 600,
                            cursor: 'pointer',
                          }}
                        >
                          {isSelected ? 'Đang xem chi tiết' : 'Chi tiết Run →'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Deep Run Inspector */}
            {selectedRunId && (
              <div
                data-testid="run-deep-inspector"
                style={{
                  backgroundColor: '#f8fafc',
                  borderRadius: '10px',
                  border: '1px solid #cbd5e1',
                  padding: '20px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '16px',
                }}
              >
                {/* Inspector Header */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: '12px',
                    borderBottom: '1px solid #e2e8f0',
                    paddingBottom: '12px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>
                      Truy lại chi tiết Run:
                    </h3>
                    <code
                      data-testid="inspected-run-id"
                      style={{
                        fontSize: '14px',
                        backgroundColor: '#ffffff',
                        padding: '2px 8px',
                        borderRadius: '4px',
                        border: '1px solid #cbd5e1',
                        color: '#2563eb',
                      }}
                    >
                      {selectedRunId}
                    </code>
                    {selectedAttempt && (
                      <span style={{ fontSize: '13px', color: '#64748b' }}>
                        (Attempt #{selectedAttempt.attempt})
                      </span>
                    )}
                  </div>

                  {selectedAttempt && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <StatusBadge status={selectedAttempt.run.status} size="sm" />
                      {selectedAttempt.result?.outcome && (
                        <StatusBadge status={selectedAttempt.result.outcome} size="sm" />
                      )}
                    </div>
                  )}
                </div>

                {/* Sub-tabs Navigation */}
                <div
                  style={{
                    display: 'flex',
                    gap: '8px',
                    borderBottom: '1px solid #e2e8f0',
                    paddingBottom: '8px',
                  }}
                >
                  <button
                    type="button"
                    data-testid="tab-checkpoints"
                    onClick={() => setActiveTab('checkpoints')}
                    style={{
                      padding: '6px 14px',
                      borderRadius: '6px',
                      fontSize: '13px',
                      fontWeight: 600,
                      border: 'none',
                      backgroundColor: activeTab === 'checkpoints' ? '#2563eb' : 'transparent',
                      color: activeTab === 'checkpoints' ? '#ffffff' : '#64748b',
                      cursor: 'pointer',
                    }}
                  >
                    Checkpoints (
                    {selectedRunDetail?.checkpoints?.length ??
                      selectedAttempt?.checkpoints?.length ??
                      0}
                    )
                  </button>

                  <button
                    type="button"
                    data-testid="tab-reports"
                    onClick={() => setActiveTab('reports')}
                    style={{
                      padding: '6px 14px',
                      borderRadius: '6px',
                      fontSize: '13px',
                      fontWeight: 600,
                      border: 'none',
                      backgroundColor: activeTab === 'reports' ? '#2563eb' : 'transparent',
                      color: activeTab === 'reports' ? '#ffffff' : '#64748b',
                      cursor: 'pointer',
                    }}
                  >
                    Báo cáo (
                    {selectedRunDetail?.reports?.length ?? selectedAttempt?.reports?.length ?? 0})
                  </button>

                  <button
                    type="button"
                    data-testid="tab-events"
                    onClick={() => setActiveTab('events')}
                    style={{
                      padding: '6px 14px',
                      borderRadius: '6px',
                      fontSize: '13px',
                      fontWeight: 600,
                      border: 'none',
                      backgroundColor: activeTab === 'events' ? '#2563eb' : 'transparent',
                      color: activeTab === 'events' ? '#ffffff' : '#64748b',
                      cursor: 'pointer',
                    }}
                  >
                    Sự kiện & Logs (
                    {selectedRunDetail?.events?.length ?? selectedAttempt?.result?.event_count ?? 0}
                    )
                  </button>

                  <button
                    type="button"
                    data-testid="tab-live"
                    onClick={() => setActiveTab('live')}
                    style={{
                      padding: '6px 14px',
                      borderRadius: '6px',
                      fontSize: '13px',
                      fontWeight: 600,
                      border: 'none',
                      backgroundColor: activeTab === 'live' ? '#dc2626' : 'transparent',
                      color: activeTab === 'live' ? '#ffffff' : '#64748b',
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                  >
                    <span
                      style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        backgroundColor: activeTab === 'live' ? '#ffffff' : '#ef4444',
                        display: 'inline-block',
                      }}
                    />
                    Live Logs (SSE)
                  </button>

                  <button
                    type="button"
                    data-testid="tab-diff"
                    onClick={() => setActiveTab('diff')}
                    style={{
                      padding: '6px 14px',
                      borderRadius: '6px',
                      fontSize: '13px',
                      fontWeight: 600,
                      border: 'none',
                      backgroundColor: activeTab === 'diff' ? '#2563eb' : 'transparent',
                      color: activeTab === 'diff' ? '#ffffff' : '#64748b',
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                  >
                    <span>Diff & Thay Đổi</span>
                  </button>

                  <button
                    type="button"
                    data-testid="tab-quality"
                    onClick={() => setActiveTab('quality')}
                    style={{
                      padding: '6px 14px',
                      borderRadius: '6px',
                      fontSize: '13px',
                      fontWeight: 600,
                      border: 'none',
                      backgroundColor: activeTab === 'quality' ? '#2563eb' : 'transparent',
                      color: activeTab === 'quality' ? '#ffffff' : '#64748b',
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                  >
                    <span>🧪 Kiểm Định & Bằng Chứng</span>
                  </button>
                </div>

                {/* Loading Run Detail Spinner */}
                {loadingDetail && (
                  <div
                    style={{
                      padding: '24px',
                      textAlign: 'center',
                      color: '#64748b',
                      fontSize: '13px',
                    }}
                  >
                    Đang tải chi tiết run {selectedRunId}...
                  </div>
                )}

                {/* Error Banner */}
                {detailError && (
                  <div
                    style={{
                      padding: '12px',
                      backgroundColor: '#fee2e2',
                      color: '#991b1b',
                      borderRadius: '6px',
                      fontSize: '13px',
                    }}
                  >
                    ⚠️ {detailError}
                  </div>
                )}

                {/* Tab 1: Checkpoints Timeline */}
                {activeTab === 'checkpoints' && !loadingDetail && (
                  <div
                    data-testid="run-checkpoints-timeline"
                    style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
                  >
                    {(() => {
                      const checkpoints: Checkpoint[] =
                        selectedRunDetail?.checkpoints ?? selectedAttempt?.checkpoints ?? [];

                      if (checkpoints.length === 0) {
                        return (
                          <div
                            style={{
                              padding: '20px',
                              textAlign: 'center',
                              color: '#94a3b8',
                              fontStyle: 'italic',
                              fontSize: '13px',
                            }}
                          >
                            Không có checkpoints nào được ghi nhận cho run này.
                          </div>
                        );
                      }

                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                          {checkpoints.map((cp, idx) => (
                            <div
                              key={cp.id}
                              data-testid={`checkpoint-item-${cp.id}`}
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '8px',
                                padding: '12px',
                                backgroundColor: '#ffffff',
                                borderRadius: '8px',
                                border: '1px solid #e2e8f0',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  <span
                                    style={{
                                      width: '24px',
                                      height: '24px',
                                      borderRadius: '50%',
                                      backgroundColor: '#eff6ff',
                                      color: '#1d4ed8',
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                      fontSize: '12px',
                                      fontWeight: 700,
                                    }}
                                  >
                                    {idx + 1}
                                  </span>
                                  <span
                                    data-testid={`checkpoint-step-${cp.id}`}
                                    style={{
                                      fontFamily: 'monospace',
                                      fontWeight: 700,
                                      fontSize: '14px',
                                      color: '#0f172a',
                                    }}
                                  >
                                    {cp.step}
                                  </span>
                                </div>

                                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                  <span style={{ fontSize: '12px', color: '#64748b' }}>
                                    {formatTimestamp(cp.created_at)}
                                  </span>
                                  <StatusBadge status={cp.status} size="sm" />
                                </div>
                              </div>

                              {cp.data && Object.keys(cp.data).length > 0 && (
                                <pre
                                  data-testid={`checkpoint-data-${cp.id}`}
                                  style={{
                                    margin: 0,
                                    padding: '8px 12px',
                                    backgroundColor: '#f1f5f9',
                                    color: '#334155',
                                    borderRadius: '6px',
                                    fontSize: '12px',
                                    fontFamily: 'monospace',
                                    overflowX: 'auto',
                                    maxHeight: '160px',
                                  }}
                                >
                                  {JSON.stringify(cp.data, null, 2)}
                                </pre>
                              )}
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Tab 2: Reports */}
                {activeTab === 'reports' && !loadingDetail && (
                  <div
                    data-testid="run-reports-list"
                    style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
                  >
                    {(() => {
                      const reports: Report[] =
                        selectedRunDetail?.reports ?? selectedAttempt?.reports ?? [];

                      if (reports.length === 0) {
                        return (
                          <div
                            style={{
                              padding: '20px',
                              textAlign: 'center',
                              color: '#94a3b8',
                              fontStyle: 'italic',
                              fontSize: '13px',
                            }}
                          >
                            Không có báo cáo nào được ghi nhận cho run này.
                          </div>
                        );
                      }

                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                          {reports.map((report) => (
                            <div
                              key={report.id}
                              data-testid={`report-item-${report.id}`}
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: '8px',
                                padding: '16px',
                                backgroundColor: '#ffffff',
                                borderRadius: '8px',
                                border: '1px solid #e2e8f0',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                }}
                              >
                                <span
                                  data-testid={`report-kind-${report.id}`}
                                  style={{
                                    fontWeight: 700,
                                    fontSize: '13px',
                                    color: '#0369a1',
                                    backgroundColor: '#e0f2fe',
                                    padding: '3px 8px',
                                    borderRadius: '4px',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.04em',
                                  }}
                                >
                                  {report.kind}
                                </span>
                                <span style={{ fontSize: '12px', color: '#64748b' }}>
                                  {formatTimestamp(report.created_at)}
                                </span>
                              </div>

                              <pre
                                data-testid={`report-content-${report.id}`}
                                style={{
                                  margin: 0,
                                  padding: '12px',
                                  backgroundColor: '#0f172a',
                                  color: '#e2e8f0',
                                  borderRadius: '6px',
                                  fontSize: '12px',
                                  fontFamily: 'monospace',
                                  whiteSpace: 'pre-wrap',
                                  lineHeight: 1.5,
                                  maxHeight: '300px',
                                  overflowY: 'auto',
                                }}
                              >
                                {report.content || '(Báo cáo rỗng)'}
                              </pre>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Tab 3: Events & Logs */}
                {activeTab === 'events' && !loadingDetail && (
                  <div
                    data-testid="run-events-breakdown"
                    style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
                  >
                    {/* Event Stats Breakdown */}
                    {selectedRunDetail?.eventStats && (
                      <div
                        data-testid="run-events-stats"
                        style={{
                          display: 'flex',
                          gap: '12px',
                          flexWrap: 'wrap',
                          padding: '12px',
                          backgroundColor: '#ffffff',
                          borderRadius: '8px',
                          border: '1px solid #e2e8f0',
                        }}
                      >
                        <div style={{ fontSize: '13px', fontWeight: 600, color: '#0f172a' }}>
                          Tổng sự kiện: {selectedRunDetail.eventStats.total}
                        </div>
                        {Object.entries(selectedRunDetail.eventStats.byType).map(
                          ([type, count]) => (
                            <span
                              key={type}
                              data-testid={`event-stat-${type}`}
                              style={{
                                fontSize: '12px',
                                fontWeight: 500,
                                backgroundColor: '#f1f5f9',
                                color: '#334155',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontFamily: 'monospace',
                              }}
                            >
                              {type}: {count}
                            </span>
                          ),
                        )}
                      </div>
                    )}

                    {/* Events List */}
                    {(() => {
                      const events: EventRecord[] = selectedRunDetail?.events ?? [];

                      if (events.length === 0) {
                        return (
                          <div
                            style={{
                              padding: '20px',
                              textAlign: 'center',
                              color: '#94a3b8',
                              fontStyle: 'italic',
                              fontSize: '13px',
                            }}
                          >
                            Không có sự kiện hoặc log nào được ghi nhận cho run này.
                          </div>
                        );
                      }

                      return (
                        <div
                          data-testid="events-list"
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '6px',
                            maxHeight: '360px',
                            overflowY: 'auto',
                            padding: '8px',
                            backgroundColor: '#0f172a',
                            borderRadius: '8px',
                          }}
                        >
                          {events.map((evt) => {
                            const isStderr = evt.type === 'stderr';
                            const isOutput = evt.type === 'agent_output' || evt.type === 'stdout';

                            let payloadText = '';
                            if (typeof evt.payload === 'string') {
                              payloadText = evt.payload;
                            } else if (evt.payload && typeof evt.payload === 'object') {
                              payloadText = JSON.stringify(evt.payload);
                            }

                            return (
                              <div
                                key={evt.id}
                                data-testid={`event-item-${evt.id}`}
                                style={{
                                  display: 'flex',
                                  gap: '10px',
                                  fontSize: '12px',
                                  fontFamily: 'monospace',
                                  lineHeight: 1.4,
                                  color: isStderr ? '#f87171' : isOutput ? '#4ade80' : '#94a3b8',
                                }}
                              >
                                <span style={{ color: '#64748b', flexShrink: 0 }}>#{evt.seq}</span>
                                <span
                                  style={{
                                    color: '#38bdf8',
                                    fontWeight: 600,
                                    flexShrink: 0,
                                    minWidth: '90px',
                                  }}
                                >
                                  [{evt.type}]
                                </span>
                                <span style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                                  {payloadText}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Tab 4: Live Logs (SSE) */}
                {activeTab === 'live' && selectedRunId && (
                  <div
                    data-testid="run-live-logs-container"
                    style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
                  >
                    <LiveLogViewer
                      runId={selectedRunId}
                      taskId={taskId}
                      apiClient={client}
                      initialEvents={selectedRunDetail?.events}
                    />
                  </div>
                )}

                {/* Tab 5: Diff Viewer */}
                {activeTab === 'diff' && (
                  <div
                    data-testid="run-diff-container"
                    style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
                  >
                    <DiffViewer taskId={taskId} apiClient={client} />
                  </div>
                )}

                {/* Tab 6: Quality Gate & Test Evidence */}
                {activeTab === 'quality' && (
                  <div
                    data-testid="run-quality-container"
                    style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}
                  >
                    <TestReportReviewFindings
                      taskId={taskId}
                      runId={selectedRunId ?? undefined}
                      apiClient={client}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
