'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import type {
  TaskDiffData,
  ScopeDiffResult,
  FileDiffDetail,
  ScopeDiffStats,
  ParsedDiffLine,
} from '@ai-orchestrator/shared';
import { parsePatchLines } from '@ai-orchestrator/shared';
import { ApiClient, api as defaultApi } from '../lib/api.js';

export { parsePatchLines, type ParsedDiffLine };

export interface DiffViewerProps {
  taskId?: string;
  repoPath?: string;
  initialData?: TaskDiffData | ScopeDiffResult | null;
  apiClient?: ApiClient;
  autoLoad?: boolean;
  title?: string;
  showScopeBanner?: boolean;
  onFileSelect?: (filePath: string) => void;
}

export type ScopeFilterType = 'all' | 'in_scope' | 'out_of_scope';
export type DiffViewMode = 'files' | 'raw';

export const DiffViewer: React.FC<DiffViewerProps> = ({
  taskId,
  initialData = null,
  apiClient,
  autoLoad = true,
  title,
  showScopeBanner = true,
  onFileSelect,
}) => {
  const client = apiClient ?? defaultApi;

  const [diffData, setDiffData] = useState<TaskDiffData | ScopeDiffResult | null>(initialData);
  const [loading, setLoading] = useState<boolean>(!initialData && Boolean(taskId && autoLoad));
  const [error, setError] = useState<string | null>(null);

  // Filters & Controls
  const [searchQuery, setSearchQuery] = useState('');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilterType>('all');
  const [viewMode, setViewMode] = useState<DiffViewMode>('files');
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [copiedFile, setCopiedFile] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  // Fetch diff from API
  const fetchDiff = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await client.getTaskDiff(taskId);
      setDiffData(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [client, taskId]);

  useEffect(() => {
    if (initialData) {
      setDiffData(initialData);
      setLoading(false);
      return;
    }
    if (taskId && autoLoad) {
      void fetchDiff();
    }
  }, [taskId, autoLoad, initialData, fetchDiff]);

  // Derived stats
  const stats: ScopeDiffStats = useMemo(() => {
    if (diffData?.stats) {
      return diffData.stats;
    }
    const fileDiffs = diffData?.fileDiffs ?? [];
    let additions = 0;
    let deletions = 0;
    let inScopeCount = 0;
    let outOfScopeCount = 0;

    for (const f of fileDiffs) {
      additions += f.additions;
      deletions += f.deletions;
      if (f.inScope) {
        inScopeCount++;
      } else {
        outOfScopeCount++;
      }
    }

    return {
      totalChanged: fileDiffs.length,
      inScopeCount,
      outOfScopeCount,
      additions,
      deletions,
    };
  }, [diffData]);

  const isScopeClean = diffData?.isScopeClean ?? (diffData?.outOfScopeFiles?.length ?? 0) === 0;
  const outOfScopeFiles = diffData?.outOfScopeFiles ?? [];

  // Filtered files list
  const filteredFiles: FileDiffDetail[] = useMemo(() => {
    const list = diffData?.fileDiffs ?? [];
    return list.filter((f) => {
      // Scope filter
      if (scopeFilter === 'in_scope' && !f.inScope) return false;
      if (scopeFilter === 'out_of_scope' && f.inScope) return false;

      // Search query filter
      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        const matchesPath = f.path.toLowerCase().includes(query);
        const matchesOld = f.oldPath?.toLowerCase().includes(query) ?? false;
        if (!matchesPath && !matchesOld) return false;
      }
      return true;
    });
  }, [diffData, scopeFilter, searchQuery]);

  // Toggle collapse for single file
  const toggleCollapse = (path: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // Toggle collapse all
  const toggleCollapseAll = () => {
    const allPaths = (diffData?.fileDiffs ?? []).map((f) => f.path);
    if (collapsedFiles.size === allPaths.length) {
      setCollapsedFiles(new Set());
    } else {
      setCollapsedFiles(new Set(allPaths));
    }
  };

  // Copy patch helper
  const copyToClipboard = async (text: string, identifier?: string) => {
    try {
      await navigator.clipboard.writeText(text);
      if (identifier) {
        setCopiedFile(identifier);
        setTimeout(() => setCopiedFile(null), 2000);
      } else {
        setCopiedAll(true);
        setTimeout(() => setCopiedAll(false), 2000);
      }
    } catch {
      // fallback
    }
  };

  // Status badge styling
  const renderStatusBadge = (status: string) => {
    let bg = '#e2e8f0';
    let color = '#475569';
    let label = status.toUpperCase();

    switch (status) {
      case 'added':
        bg = '#dcfce7';
        color = '#15803d';
        label = 'ADDED';
        break;
      case 'modified':
        bg = '#e0f2fe';
        color = '#0369a1';
        label = 'MODIFIED';
        break;
      case 'deleted':
        bg = '#fee2e2';
        color = '#b91c1c';
        label = 'DELETED';
        break;
      case 'renamed':
        bg = '#fef3c7';
        color = '#b45309';
        label = 'RENAMED';
        break;
      case 'untracked':
        bg = '#f3e8ff';
        color = '#7e22ce';
        label = 'UNTRACKED';
        break;
    }

    return (
      <span
        data-testid={`diff-status-${status}`}
        style={{
          display: 'inline-block',
          fontSize: '11px',
          fontWeight: 700,
          padding: '2px 8px',
          borderRadius: '4px',
          backgroundColor: bg,
          color,
          letterSpacing: '0.5px',
        }}
      >
        {label}
      </span>
    );
  };

  // Scope badge
  const renderScopeBadge = (inScope: boolean) => {
    if (inScope) {
      return (
        <span
          data-testid="diff-file-scope-in"
          style={{
            display: 'inline-block',
            fontSize: '11px',
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: '4px',
            backgroundColor: '#f0fdf4',
            color: '#166534',
            border: '1px solid #bbf7d0',
          }}
        >
          ✓ Trong scope
        </span>
      );
    }
    return (
      <span
        data-testid="diff-file-scope-out"
        style={{
          display: 'inline-block',
          fontSize: '11px',
          fontWeight: 700,
          padding: '2px 8px',
          borderRadius: '4px',
          backgroundColor: '#fef2f2',
          color: '#991b1b',
          border: '1px solid #fecaca',
        }}
      >
        ⚠️ File lạ
      </span>
    );
  };

  // --- LOADING STATE ---
  if (loading) {
    return (
      <div
        data-testid="diff-loading"
        style={{
          padding: '48px 24px',
          textAlign: 'center',
          backgroundColor: '#ffffff',
          borderRadius: '10px',
          border: '1px solid #e2e8f0',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        }}
      >
        <div
          style={{
            display: 'inline-block',
            width: '32px',
            height: '32px',
            border: '3px solid #cbd5e1',
            borderTopColor: '#2563eb',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
            marginBottom: '12px',
          }}
        />
        <p style={{ margin: 0, color: '#475569', fontSize: '14px', fontWeight: 500 }}>
          Đang tải git diff của {taskId ? `tác vụ ${taskId}` : 'kho lưu trữ'}...
        </p>
      </div>
    );
  }

  // --- ERROR STATE ---
  if (error) {
    return (
      <div
        data-testid="diff-error"
        style={{
          padding: '24px',
          backgroundColor: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: '10px',
          color: '#991b1b',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
          <span style={{ fontSize: '18px' }}>⚠️</span>
          <span style={{ fontWeight: 600, fontSize: '15px' }}>Không thể tải thông tin Git Diff</span>
        </div>
        <p style={{ margin: '0 0 16px 0', fontSize: '13px', color: '#b91c1c' }}>{error}</p>
        <button
          type="button"
          data-testid="diff-retry-btn"
          onClick={() => void fetchDiff()}
          style={{
            padding: '6px 14px',
            backgroundColor: '#dc2626',
            color: '#ffffff',
            border: 'none',
            borderRadius: '6px',
            fontSize: '13px',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Thử lại
        </button>
      </div>
    );
  }

  // --- EMPTY STATE ---
  const hasFiles = (diffData?.fileDiffs?.length ?? 0) > 0;
  const hasRawDiff = Boolean(diffData?.rawDiff && diffData.rawDiff.trim().length > 0);

  if (!hasFiles && !hasRawDiff) {
    return (
      <div
        data-testid="diff-empty"
        style={{
          padding: '48px 24px',
          textAlign: 'center',
          backgroundColor: '#ffffff',
          borderRadius: '10px',
          border: '1px solid #e2e8f0',
        }}
      >
        <div style={{ fontSize: '32px', marginBottom: '12px' }}>✨</div>
        <h4 style={{ margin: '0 0 6px 0', fontSize: '16px', color: '#1e293b' }}>
          Không có thay đổi nào trong Git
        </h4>
        <p style={{ margin: '0 0 16px 0', fontSize: '13px', color: '#64748b' }}>
          {taskId
            ? `Tác vụ ${taskId} hiện tại chưa có thay đổi nào so với branch gốc.`
            : 'Working tree sạch, không có commit hoặc file sửa đổi mới.'}
        </p>
        {taskId && (
          <button
            type="button"
            data-testid="diff-refresh-btn"
            onClick={() => void fetchDiff()}
            style={{
              padding: '6px 14px',
              backgroundColor: '#f1f5f9',
              color: '#334155',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Làm mới (Refresh)
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="diff-viewer"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      {/* Top Header & Summary Stats */}
      <div
        data-testid="diff-summary-stats"
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #e2e8f0',
          borderRadius: '10px',
          padding: '16px 20px',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 700, color: '#0f172a' }}>
              {title ?? (taskId ? `Git Diff: Tác vụ ${taskId}` : 'So sánh thay đổi (Git Diff)')}
            </h3>
            {(taskId || diffData?.taskId) && (
              <span
                data-testid="diff-task-id-badge"
                style={{
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  backgroundColor: '#f1f5f9',
                  color: '#475569',
                }}
              >
                {taskId ?? diffData?.taskId}
              </span>
            )}
          </div>
          {diffData?.repoPath && (
            <span style={{ fontSize: '12px', color: '#64748b', fontFamily: 'monospace' }}>
              Repo: {diffData.repoPath}
            </span>
          )}
        </div>

        {/* Change Stats counters */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <div
            data-testid="diff-stat-files"
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              backgroundColor: '#f8fafc',
              border: '1px solid #e2e8f0',
              fontSize: '13px',
              fontWeight: 600,
              color: '#334155',
            }}
          >
            📁 {stats.totalChanged} tập tin
          </div>

          <div
            data-testid="diff-stat-additions"
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              backgroundColor: '#f0fdf4',
              border: '1px solid #bbf7d0',
              fontSize: '13px',
              fontWeight: 700,
              color: '#15803d',
            }}
          >
            +{stats.additions} dòng
          </div>

          <div
            data-testid="diff-stat-deletions"
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              backgroundColor: '#fef2f2',
              border: '1px solid #fecaca',
              fontSize: '13px',
              fontWeight: 700,
              color: '#b91c1c',
            }}
          >
            -{stats.deletions} dòng
          </div>

          {taskId && (
            <button
              type="button"
              data-testid="diff-refresh-btn"
              onClick={() => void fetchDiff()}
              title="Cập nhật lại diff mới nhất"
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
                backgroundColor: '#ffffff',
                color: '#475569',
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              🔄 Làm mới
            </button>
          )}
        </div>
      </div>

      {/* Scope Compliance Alert Banner (QLT-003) */}
      {showScopeBanner && (
        <div
          data-testid="diff-scope-banner"
          style={{
            padding: '14px 18px',
            borderRadius: '8px',
            backgroundColor: isScopeClean ? '#f0fdf4' : '#fffbeb',
            border: `1px solid ${isScopeClean ? '#bbf7d0' : '#fde68a'}`,
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '16px' }}>{isScopeClean ? '✅' : '⚠️'}</span>
              <span
                style={{
                  fontSize: '14px',
                  fontWeight: 600,
                  color: isScopeClean ? '#166534' : '#92400e',
                }}
              >
                {isScopeClean
                  ? 'Phạm vi hợp lệ: Tất cả các tập tin sửa đổi đều nằm trong phạm vi cho phép của tác vụ'
                  : `Cảnh báo Quality Gate (QLT-003): Phát hiện ${outOfScopeFiles.length} tập tin ngoài phạm vi (file lạ)`}
              </span>
            </div>

            <span
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: isScopeClean ? '#15803d' : '#b45309',
                backgroundColor: isScopeClean ? '#dcfce7' : '#fef3c7',
                padding: '2px 8px',
                borderRadius: '12px',
              }}
            >
              {stats.inScopeCount}/{stats.totalChanged} trong scope
            </span>
          </div>

          {/* List of alien out-of-scope files */}
          {!isScopeClean && outOfScopeFiles.length > 0 && (
            <div
              data-testid="diff-scope-alien-files"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '6px',
                marginTop: '4px',
              }}
            >
              {outOfScopeFiles.map((file) => (
                <span
                  key={file}
                  style={{
                    fontSize: '12px',
                    fontFamily: 'monospace',
                    padding: '3px 8px',
                    borderRadius: '4px',
                    backgroundColor: '#fee2e2',
                    color: '#991b1b',
                    border: '1px solid #fca5a5',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '4px',
                  }}
                >
                  <span>🚫</span>
                  {file}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Control Bar: Search, Filters, View Mode Toggle */}
      <div
        data-testid="diff-controls-bar"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          backgroundColor: '#ffffff',
          border: '1px solid #e2e8f0',
          borderRadius: '8px',
          padding: '10px 16px',
        }}
      >
        {/* Left: Search input */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: '1 1 240px' }}>
          <span style={{ color: '#94a3b8', fontSize: '14px' }}>🔍</span>
          <input
            type="text"
            data-testid="diff-search-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Lọc theo tên tập tin hoặc đường dẫn..."
            style={{
              width: '100%',
              maxWidth: '320px',
              padding: '6px 10px',
              fontSize: '13px',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              outline: 'none',
            }}
          />
          {searchQuery && (
            <button
              type="button"
              data-testid="diff-search-clear"
              onClick={() => setSearchQuery('')}
              style={{
                background: 'none',
                border: 'none',
                color: '#94a3b8',
                cursor: 'pointer',
                fontSize: '12px',
              }}
            >
              ✕
            </button>
          )}
        </div>

        {/* Right: Scope Filter & View Mode */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          {/* Scope filter buttons */}
          <div
            data-testid="diff-scope-filter"
            style={{
              display: 'inline-flex',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              overflow: 'hidden',
            }}
          >
            <button
              type="button"
              data-testid="diff-filter-all"
              onClick={() => setScopeFilter('all')}
              style={{
                padding: '6px 10px',
                fontSize: '12px',
                fontWeight: 600,
                border: 'none',
                backgroundColor: scopeFilter === 'all' ? '#2563eb' : '#ffffff',
                color: scopeFilter === 'all' ? '#ffffff' : '#475569',
                cursor: 'pointer',
              }}
            >
              Tất cả ({diffData?.fileDiffs?.length ?? 0})
            </button>
            <button
              type="button"
              data-testid="diff-filter-in-scope"
              onClick={() => setScopeFilter('in_scope')}
              style={{
                padding: '6px 10px',
                fontSize: '12px',
                fontWeight: 600,
                border: 'none',
                borderLeft: '1px solid #cbd5e1',
                backgroundColor: scopeFilter === 'in_scope' ? '#16a34a' : '#ffffff',
                color: scopeFilter === 'in_scope' ? '#ffffff' : '#475569',
                cursor: 'pointer',
              }}
            >
              Trong scope ({stats.inScopeCount})
            </button>
            <button
              type="button"
              data-testid="diff-filter-out-of-scope"
              onClick={() => setScopeFilter('out_of_scope')}
              style={{
                padding: '6px 10px',
                fontSize: '12px',
                fontWeight: 600,
                border: 'none',
                borderLeft: '1px solid #cbd5e1',
                backgroundColor: scopeFilter === 'out_of_scope' ? '#dc2626' : '#ffffff',
                color: scopeFilter === 'out_of_scope' ? '#ffffff' : '#475569',
                cursor: 'pointer',
              }}
            >
              File lạ ({stats.outOfScopeCount})
            </button>
          </div>

          {/* View mode toggle */}
          <div
            data-testid="diff-view-mode-toggle"
            style={{
              display: 'inline-flex',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              overflow: 'hidden',
            }}
          >
            <button
              type="button"
              data-testid="diff-view-files"
              onClick={() => setViewMode('files')}
              style={{
                padding: '6px 10px',
                fontSize: '12px',
                fontWeight: 600,
                border: 'none',
                backgroundColor: viewMode === 'files' ? '#0f172a' : '#ffffff',
                color: viewMode === 'files' ? '#ffffff' : '#475569',
                cursor: 'pointer',
              }}
            >
              Từng file
            </button>
            <button
              type="button"
              data-testid="diff-view-raw"
              onClick={() => setViewMode('raw')}
              style={{
                padding: '6px 10px',
                fontSize: '12px',
                fontWeight: 600,
                border: 'none',
                borderLeft: '1px solid #cbd5e1',
                backgroundColor: viewMode === 'raw' ? '#0f172a' : '#ffffff',
                color: viewMode === 'raw' ? '#ffffff' : '#475569',
                cursor: 'pointer',
              }}
            >
              Raw Unified
            </button>
          </div>

          {/* Expand/Collapse All */}
          {viewMode === 'files' && (
            <button
              type="button"
              data-testid="diff-toggle-collapse-all"
              onClick={toggleCollapseAll}
              style={{
                padding: '6px 10px',
                fontSize: '12px',
                fontWeight: 500,
                border: '1px solid #cbd5e1',
                borderRadius: '6px',
                backgroundColor: '#f8fafc',
                color: '#475569',
                cursor: 'pointer',
              }}
            >
              {collapsedFiles.size === (diffData?.fileDiffs?.length ?? 0)
                ? 'Mở rộng tất cả'
                : 'Thu gọn tất cả'}
            </button>
          )}

          {/* Copy Raw Diff button */}
          <button
            type="button"
            data-testid="diff-copy-all-btn"
            onClick={() => void copyToClipboard(diffData?.rawDiff ?? '')}
            style={{
              padding: '6px 10px',
              fontSize: '12px',
              fontWeight: 500,
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              backgroundColor: '#f8fafc',
              color: '#475569',
              cursor: 'pointer',
            }}
          >
            {copiedAll ? '✓ Đã sao chép' : 'Sao chép Diff'}
          </button>
        </div>
      </div>

      {/* VIEW MODE 1: FILE-BY-FILE CARDS */}
      {viewMode === 'files' && (
        <div
          data-testid="diff-files-container"
          style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}
        >
          {filteredFiles.length === 0 ? (
            <div
              data-testid="diff-no-filtered-results"
              style={{
                padding: '32px 16px',
                textAlign: 'center',
                backgroundColor: '#ffffff',
                border: '1px dashed #cbd5e1',
                borderRadius: '8px',
                color: '#64748b',
                fontSize: '13px',
              }}
            >
              Không tìm thấy tập tin nào phù hợp với bộ lọc hiện tại.
            </div>
          ) : (
            filteredFiles.map((file) => {
              const isCollapsed = collapsedFiles.has(file.path);
              const parsedLines = parsePatchLines(file.patch);

              return (
                <div
                  key={file.path}
                  data-testid={`diff-file-card-${file.path}`}
                  style={{
                    backgroundColor: '#ffffff',
                    border: `1px solid ${file.inScope ? '#e2e8f0' : '#fca5a5'}`,
                    borderRadius: '8px',
                    overflow: 'hidden',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
                  }}
                >
                  {/* File Header */}
                  <div
                    data-testid="diff-file-header"
                    onClick={() => {
                      toggleCollapse(file.path);
                      if (onFileSelect) onFileSelect(file.path);
                    }}
                    style={{
                      padding: '10px 16px',
                      backgroundColor: file.inScope ? '#f8fafc' : '#fff5f5',
                      borderBottom: isCollapsed ? 'none' : '1px solid #e2e8f0',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      cursor: 'pointer',
                      userSelect: 'none',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        overflow: 'hidden',
                      }}
                    >
                      <span style={{ fontSize: '13px', color: '#64748b', width: '16px' }}>
                        {isCollapsed ? '▶' : '▼'}
                      </span>
                      {renderStatusBadge(file.status)}
                      {renderScopeBadge(file.inScope)}
                      <span
                        data-testid="diff-file-path"
                        style={{
                          fontSize: '13px',
                          fontWeight: 600,
                          fontFamily: 'monospace',
                          color: '#0f172a',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {file.path}
                      </span>
                      {file.oldPath && file.oldPath !== file.path && (
                        <span
                          style={{
                            fontSize: '12px',
                            color: '#64748b',
                            fontFamily: 'monospace',
                          }}
                        >
                          (từ {file.oldPath})
                        </span>
                      )}
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        flexShrink: 0,
                      }}
                    >
                      <span
                        style={{
                          fontSize: '12px',
                          fontWeight: 700,
                          fontFamily: 'monospace',
                          color: '#16a34a',
                        }}
                      >
                        +{file.additions}
                      </span>
                      <span
                        style={{
                          fontSize: '12px',
                          fontWeight: 700,
                          fontFamily: 'monospace',
                          color: '#dc2626',
                        }}
                      >
                        -{file.deletions}
                      </span>
                      <button
                        type="button"
                        data-testid={`diff-copy-file-${file.path}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void copyToClipboard(file.patch, file.path);
                        }}
                        title="Sao chép patch của file này"
                        style={{
                          padding: '3px 8px',
                          fontSize: '11px',
                          border: '1px solid #cbd5e1',
                          borderRadius: '4px',
                          backgroundColor: '#ffffff',
                          color: '#475569',
                          cursor: 'pointer',
                        }}
                      >
                        {copiedFile === file.path ? '✓' : 'Copy'}
                      </button>
                    </div>
                  </div>

                  {/* File Patch Lines Body */}
                  {!isCollapsed && (
                    <div
                      data-testid="diff-file-content"
                      style={{
                        fontFamily:
                          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                        fontSize: '12px',
                        lineHeight: 1.5,
                        overflowX: 'auto',
                        backgroundColor: '#ffffff',
                      }}
                    >
                      {parsedLines.length === 0 ? (
                        <div
                          style={{
                            padding: '16px',
                            color: '#64748b',
                            fontStyle: 'italic',
                          }}
                        >
                          Tập tin này không có patch nội dung (file nhị phân hoặc đổi tên rỗng).
                        </div>
                      ) : (
                        <div style={{ display: 'table', width: '100%', borderCollapse: 'collapse' }}>
                          {parsedLines.map((line, idx) => {
                            let rowBg = '#ffffff';
                            let textColor = '#334155';
                            let prefixSymbol = ' ';
                            let testId = 'diff-line-context';

                            if (line.type === 'add') {
                              rowBg = '#ecfdf5';
                              textColor = '#15803d';
                              prefixSymbol = '+';
                              testId = 'diff-line-added';
                            } else if (line.type === 'delete') {
                              rowBg = '#fef2f2';
                              textColor = '#b91c1c';
                              prefixSymbol = '-';
                              testId = 'diff-line-deleted';
                            } else if (line.type === 'chunk') {
                              rowBg = '#f1f5f9';
                              textColor = '#0284c7';
                              prefixSymbol = '@';
                              testId = 'diff-line-chunk';
                            } else if (line.type === 'header') {
                              rowBg = '#f8fafc';
                              textColor = '#64748b';
                              prefixSymbol = ' ';
                              testId = 'diff-line-header';
                            }

                            return (
                              <div
                                key={idx}
                                data-testid={testId}
                                style={{
                                  display: 'table-row',
                                  backgroundColor: rowBg,
                                  color: textColor,
                                }}
                              >
                                {/* Old line number */}
                                <div
                                  style={{
                                    display: 'table-cell',
                                    width: '40px',
                                    minWidth: '40px',
                                    padding: '1px 8px',
                                    textAlign: 'right',
                                    color: '#94a3b8',
                                    borderRight: '1px solid #e2e8f0',
                                    userSelect: 'none',
                                    fontSize: '11px',
                                  }}
                                >
                                  {line.oldLineNumber ?? ''}
                                </div>

                                {/* New line number */}
                                <div
                                  style={{
                                    display: 'table-cell',
                                    width: '40px',
                                    minWidth: '40px',
                                    padding: '1px 8px',
                                    textAlign: 'right',
                                    color: '#94a3b8',
                                    borderRight: '1px solid #e2e8f0',
                                    userSelect: 'none',
                                    fontSize: '11px',
                                  }}
                                >
                                  {line.newLineNumber ?? ''}
                                </div>

                                {/* Prefix symbol (+ / - / @) */}
                                <div
                                  style={{
                                    display: 'table-cell',
                                    width: '20px',
                                    minWidth: '20px',
                                    textAlign: 'center',
                                    fontWeight: 700,
                                    userSelect: 'none',
                                  }}
                                >
                                  {prefixSymbol}
                                </div>

                                {/* Code Content */}
                                <div
                                  style={{
                                    display: 'table-cell',
                                    padding: '1px 8px',
                                    whiteSpace: 'pre',
                                    wordBreak: 'break-all',
                                  }}
                                >
                                  {line.type === 'add' || line.type === 'delete'
                                    ? line.text.slice(1)
                                    : line.text}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* VIEW MODE 2: RAW UNIFIED DIFF */}
      {viewMode === 'raw' && (
        <div
          data-testid="diff-raw-container"
          style={{
            backgroundColor: '#0f172a',
            color: '#f8fafc',
            borderRadius: '8px',
            padding: '16px',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: '12px',
            lineHeight: 1.6,
            overflowX: 'auto',
            border: '1px solid #1e293b',
          }}
        >
          {diffData?.rawDiff ? (
            <div style={{ display: 'table', width: '100%' }}>
              {diffData.rawDiff.split(/\r?\n/).map((line, idx) => {
                let color = '#94a3b8';
                let testId = 'diff-raw-line-context';

                if (line.startsWith('+') && !line.startsWith('+++')) {
                  color = '#4ade80';
                  testId = 'diff-raw-line-add';
                } else if (line.startsWith('-') && !line.startsWith('---')) {
                  color = '#f87171';
                  testId = 'diff-raw-line-del';
                } else if (line.startsWith('@@')) {
                  color = '#38bdf8';
                  testId = 'diff-raw-line-chunk';
                } else if (
                  line.startsWith('diff --git') ||
                  line.startsWith('index') ||
                  line.startsWith('---') ||
                  line.startsWith('+++')
                ) {
                  color = '#e2e8f0';
                  testId = 'diff-raw-line-header';
                }

                return (
                  <div
                    key={idx}
                    data-testid={testId}
                    style={{ display: 'table-row', color }}
                  >
                    <div
                      style={{
                        display: 'table-cell',
                        width: '40px',
                        minWidth: '40px',
                        paddingRight: '12px',
                        textAlign: 'right',
                        color: '#475569',
                        userSelect: 'none',
                        borderRight: '1px solid #334155',
                      }}
                    >
                      {idx + 1}
                    </div>
                    <div
                      style={{
                        display: 'table-cell',
                        paddingLeft: '12px',
                        whiteSpace: 'pre',
                      }}
                    >
                      {line}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ color: '#64748b' }}>Không có nội dung raw diff.</div>
          )}
        </div>
      )}
    </div>
  );
};
