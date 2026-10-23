'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  type FeatureRelease,
  type FeatureReleaseReportResult,
  type FeatureReleaseCheckResult,
  type Feature,
} from '@ai-orchestrator/shared';
import { ApiClient, api as defaultApi } from '../lib/api.js';
import { StatusBadge } from './StatusBadge.js';

export interface ReleaseDashboardProps {
  apiClient?: ApiClient;
  autoRefreshIntervalMs?: number;
  initialReleases?: FeatureRelease[];
  initialFeatures?: Feature[];
  onActionComplete?: (action: string, result: unknown) => void;
}

export const ReleaseDashboard: React.FC<ReleaseDashboardProps> = ({
  apiClient,
  autoRefreshIntervalMs = 0,
  initialReleases = [],
  initialFeatures = [],
  onActionComplete,
}) => {
  const client = apiClient ?? defaultApi;

  // Data states
  const [releases, setReleases] = useState<FeatureRelease[]>(initialReleases);
  const [features, setFeatures] = useState<Feature[]>(initialFeatures);
  const [loading, setLoading] = useState<boolean>(initialReleases.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Selected feature / report modal
  const [selectedReport, setSelectedReport] = useState<FeatureReleaseReportResult | null>(null);
  const [loadingReport, setLoadingReport] = useState<boolean>(false);
  const [reportError, setReportError] = useState<string | null>(null);

  // Readiness check modal / drawer
  const [readinessResult, setReadinessResult] = useState<FeatureReleaseCheckResult | null>(null);
  const [loadingReadiness, setLoadingReadiness] = useState<boolean>(false);

  // Create PR modal state
  const [isPrModalOpen, setIsPrModalOpen] = useState<boolean>(false);
  const [targetFeatureId, setTargetFeatureId] = useState<string>('');
  const [prTitle, setPrTitle] = useState<string>('');
  const [prBaseBranch, setPrBaseBranch] = useState<string>('main');
  const [isPrDraft, setIsPrDraft] = useState<boolean>(false);
  const [isSubmittingPr, setIsSubmittingPr] = useState<boolean>(false);

  // Copy SHA feedback state (releaseId -> boolean)
  const [copiedShaMap, setCopiedShaMap] = useState<Record<string, boolean>>({});

  // Auto-refresh state
  const [autoRefresh, setAutoRefresh] = useState<boolean>(autoRefreshIntervalMs > 0);

  // Fetch releases and features
  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [releaseList, featureList] = await Promise.all([
        client.getReleases(),
        client.getFeatures().catch(() => []),
      ]);
      setReleases(releaseList);
      setFeatures(featureList);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Không thể tải danh sách releases: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [client]);

  // Initial fetch if no initial data
  useEffect(() => {
    if (initialReleases.length === 0) {
      void fetchData();
    }
  }, [fetchData, initialReleases.length]);

  // Auto-refresh interval
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      void fetchData();
    }, autoRefreshIntervalMs || 10000);
    return () => clearInterval(interval);
  }, [autoRefresh, autoRefreshIntervalMs, fetchData]);

  // Feature map for quick title/name lookup
  const featureMap = useMemo(() => {
    const map = new Map<string, Feature>();
    for (const f of features) {
      map.set(f.id, f);
    }
    return map;
  }, [features]);

  // Filtered releases
  const filteredReleases = useMemo(() => {
    return releases.filter((r) => {
      if (statusFilter !== 'ALL' && r.status !== statusFilter) {
        return false;
      }
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase().trim();
        const feat = featureMap.get(r.feature_id);
        const featName = feat?.name?.toLowerCase() ?? '';
        const matchFeatId = r.feature_id.toLowerCase().includes(query);
        const matchBranch = r.branch.toLowerCase().includes(query);
        const matchSha = (r.commit_sha ?? '').toLowerCase().includes(query);
        const matchPr = (r.pr_url ?? '').toLowerCase().includes(query);
        return matchFeatId || matchBranch || matchSha || matchPr || featName.includes(query);
      }
      return true;
    });
  }, [releases, statusFilter, searchQuery, featureMap]);

  // Metric stats
  const metrics = useMemo(() => {
    const total = releases.length;
    let readyForReview = 0;
    let prCreated = 0;
    let pushed = 0;
    let committed = 0;
    let merged = 0;

    for (const r of releases) {
      if (r.status === 'READY_FOR_REVIEW') readyForReview++;
      else if (r.status === 'PR_CREATED') prCreated++;
      else if (r.status === 'PUSHED') pushed++;
      else if (r.status === 'COMMITTED') committed++;
      else if (r.status === 'MERGED') merged++;
    }

    return { total, readyForReview, prCreated, pushed, committed, merged };
  }, [releases]);

  // Copy SHA handler
  const handleCopySha = async (releaseId: string, sha: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(sha);
      }
      setCopiedShaMap((prev) => ({ ...prev, [releaseId]: true }));
      setTimeout(() => {
        setCopiedShaMap((prev) => ({ ...prev, [releaseId]: false }));
      }, 2000);
    } catch {
      // Ignore copy error
    }
  };

  // View Release Report handler
  const handleViewReport = async (featureId: string) => {
    try {
      setLoadingReport(true);
      setReportError(null);
      setSelectedReport(null);
      const report = await client.getFeatureReleaseReport(featureId);
      setSelectedReport(report);
      onActionComplete?.('view_report', report);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setReportError(`Không thể lấy báo cáo phát hành: ${msg}`);
    } finally {
      setLoadingReport(false);
    }
  };

  // Check Release Readiness handler
  const handleCheckReadiness = async (featureId: string) => {
    try {
      setLoadingReadiness(true);
      const result = await client.checkFeatureReleaseReadiness(featureId);
      setReadinessResult(result);
      onActionComplete?.('check_readiness', result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Kiểm tra sẵn sàng thất bại: ${msg}`);
    } finally {
      setLoadingReadiness(false);
    }
  };

  // Open Create PR modal handler
  const handleOpenPrModal = (release: FeatureRelease) => {
    const feat = featureMap.get(release.feature_id);
    setTargetFeatureId(release.feature_id);
    setPrTitle(`feat(${release.feature_id}): release feature ${feat?.name ?? release.feature_id}`);
    setPrBaseBranch(release.base_branch || 'main');
    setIsPrDraft(false);
    setIsPrModalOpen(true);
  };

  // Submit Create PR handler
  const handleSubmitCreatePr = async () => {
    if (!targetFeatureId) return;
    try {
      setIsSubmittingPr(true);
      setError(null);
      const result = await client.createFeaturePr(targetFeatureId, {
        title: prTitle.trim() || undefined,
        base_branch: prBaseBranch.trim() || 'main',
        draft: isPrDraft,
      });
      setSuccess(`Tạo Pull Request thành công: ${result.pr_url}`);
      setIsPrModalOpen(false);
      onActionComplete?.('create_pr', result);
      await fetchData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Tạo PR thất bại: ${msg}`);
    } finally {
      setIsSubmittingPr(false);
    }
  };

  return (
    <div data-testid="release-dashboard-container" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* 1. Header Section */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '16px',
        }}
      >
        <div>
          <h2
            style={{
              margin: '0 0 4px 0',
              fontSize: '22px',
              fontWeight: 700,
              color: '#0f172a',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            🚀 Phát Hành & Pull Requests (Releases)
          </h2>
          <p style={{ margin: 0, fontSize: '14px', color: '#64748b' }}>
            Theo dõi release branches, commit SHA, Pull Requests GitHub và báo cáo nghiệm thu release theo từng feature.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              fontSize: '13px',
              color: '#475569',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            <input
              type="checkbox"
              data-testid="checkbox-auto-refresh"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            Tự động làm mới
          </label>

          <button
            type="button"
            data-testid="btn-refresh-releases"
            onClick={() => void fetchData()}
            disabled={loading}
            style={{
              padding: '6px 14px',
              fontSize: '13px',
              fontWeight: 600,
              color: '#1e293b',
              backgroundColor: '#ffffff',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              cursor: loading ? 'not-allowed' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              opacity: loading ? 0.7 : 1,
            }}
          >
            🔄 {loading ? 'Đang tải...' : 'Làm mới'}
          </button>
        </div>
      </div>

      {/* 2. Success & Error Banners */}
      {success && (
        <div
          data-testid="release-success-banner"
          style={{
            padding: '12px 16px',
            backgroundColor: '#f0fdf4',
            border: '1px solid #86efac',
            borderRadius: '8px',
            color: '#166534',
            fontSize: '14px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>✅ {success}</span>
          <button
            type="button"
            data-testid="btn-dismiss-success"
            onClick={() => setSuccess(null)}
            style={{
              background: 'none',
              border: 'none',
              color: '#166534',
              cursor: 'pointer',
              fontWeight: 'bold',
            }}
          >
            ✕
          </button>
        </div>
      )}

      {error && (
        <div
          data-testid="release-error-banner"
          style={{
            padding: '12px 16px',
            backgroundColor: '#fef2f2',
            border: '1px solid #fca5a5',
            borderRadius: '8px',
            color: '#991b1b',
            fontSize: '14px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>⚠️ {error}</span>
          <button
            type="button"
            data-testid="btn-dismiss-error"
            onClick={() => setError(null)}
            style={{
              background: 'none',
              border: 'none',
              color: '#991b1b',
              cursor: 'pointer',
              fontWeight: 'bold',
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* 3. Metric Cards Section */}
      <div
        data-testid="release-metrics-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: '12px',
        }}
      >
        <div
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '8px',
            padding: '14px 16px',
          }}
        >
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#64748b' }}>TỔNG SỐ RELEASES</div>
          <div data-testid="metric-total-releases" style={{ fontSize: '24px', fontWeight: 700, color: '#0f172a', marginTop: '4px' }}>
            {metrics.total}
          </div>
        </div>

        <div
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '8px',
            padding: '14px 16px',
          }}
        >
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#d97706' }}>CHỜ DUYỆT (REVIEW)</div>
          <div data-testid="metric-ready-for-review" style={{ fontSize: '24px', fontWeight: 700, color: '#b45309', marginTop: '4px' }}>
            {metrics.readyForReview}
          </div>
        </div>

        <div
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '8px',
            padding: '14px 16px',
          }}
        >
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#7c3aed' }}>ĐÃ TẠO PR (OPEN)</div>
          <div data-testid="metric-pr-created" style={{ fontSize: '24px', fontWeight: 700, color: '#6d28d9', marginTop: '4px' }}>
            {metrics.prCreated}
          </div>
        </div>

        <div
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '8px',
            padding: '14px 16px',
          }}
        >
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#2563eb' }}>ĐÃ PUSH REMOTE</div>
          <div data-testid="metric-pushed" style={{ fontSize: '24px', fontWeight: 700, color: '#1d4ed8', marginTop: '4px' }}>
            {metrics.pushed}
          </div>
        </div>

        <div
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #e2e8f0',
            borderRadius: '8px',
            padding: '14px 16px',
          }}
        >
          <div style={{ fontSize: '12px', fontWeight: 600, color: '#16a34a' }}>ĐÃ HỢP NHẤT (MERGED)</div>
          <div data-testid="metric-merged" style={{ fontSize: '24px', fontWeight: 700, color: '#15803d', marginTop: '4px' }}>
            {metrics.merged}
          </div>
        </div>
      </div>

      {/* 4. Filter & Search Bar */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '12px',
          alignItems: 'center',
          backgroundColor: '#ffffff',
          padding: '14px 16px',
          border: '1px solid #e2e8f0',
          borderRadius: '8px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: '1 1 240px' }}>
          <label htmlFor="filter-search-input" style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>
            Tìm kiếm:
          </label>
          <input
            id="filter-search-input"
            type="text"
            data-testid="input-search-releases"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Feature ID, tên feature, branch, SHA..."
            style={{
              flex: 1,
              padding: '6px 12px',
              fontSize: '13px',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              outline: 'none',
            }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <label htmlFor="select-status-filter" style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>
            Trạng thái:
          </label>
          <select
            id="select-status-filter"
            data-testid="select-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{
              padding: '6px 12px',
              fontSize: '13px',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              backgroundColor: '#ffffff',
              color: '#0f172a',
              cursor: 'pointer',
            }}
          >
            <option value="ALL">Tất cả trạng thái</option>
            <option value="READY_FOR_REVIEW">READY_FOR_REVIEW (Chờ người duyệt)</option>
            <option value="PR_CREATED">PR_CREATED (Đã tạo PR)</option>
            <option value="PUSHED">PUSHED (Đã push remote)</option>
            <option value="COMMITTED">COMMITTED (Đã commit SHA)</option>
            <option value="BRANCH_CREATED">BRANCH_CREATED (Đã tạo branch)</option>
            <option value="MERGED">MERGED (Đã merge)</option>
            <option value="CLOSED">CLOSED (Đã đóng)</option>
          </select>
        </div>

        {searchQuery && (
          <button
            type="button"
            data-testid="btn-clear-search"
            onClick={() => setSearchQuery('')}
            style={{
              padding: '6px 10px',
              fontSize: '12px',
              color: '#64748b',
              backgroundColor: '#f1f5f9',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            Xóa tìm kiếm
          </button>
        )}
      </div>

      {/* 5. Main Release Table / Card List */}
      <div
        data-testid="releases-list-box"
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #e2e8f0',
          borderRadius: '8px',
          overflow: 'hidden',
        }}
      >
        {loading && (
          <div
            data-testid="releases-loading"
            style={{
              padding: '48px 24px',
              textAlign: 'center',
              color: '#64748b',
              fontSize: '14px',
            }}
          >
            <div style={{ fontSize: '24px', marginBottom: '8px' }}>⏳</div>
            Đang tải dữ liệu releases và Pull Requests...
          </div>
        )}

        {!loading && filteredReleases.length === 0 && (
          <div
            data-testid="releases-empty"
            style={{
              padding: '48px 24px',
              textAlign: 'center',
              color: '#64748b',
            }}
          >
            <div style={{ fontSize: '32px', marginBottom: '12px' }}>📦</div>
            <p style={{ margin: '0 0 6px 0', fontSize: '16px', fontWeight: 600, color: '#334155' }}>
              Chưa có đợt phát hành (Release) nào phù hợp
            </p>
            <p style={{ margin: 0, fontSize: '13px', color: '#94a3b8' }}>
              {searchQuery || statusFilter !== 'ALL'
                ? 'Thử thay đổi bộ lọc trạng thái hoặc từ khóa tìm kiếm.'
                : 'Các feature sau khi hoàn thành task và vượt qua Quality Gate sẽ được tạo release branch và PR tại đây.'}
            </p>
          </div>
        )}

        {!loading && filteredReleases.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table
              data-testid="releases-table"
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                textAlign: 'left',
                fontSize: '13px',
              }}
            >
              <thead>
                <tr
                  style={{
                    backgroundColor: '#f8fafc',
                    borderBottom: '1px solid #e2e8f0',
                    color: '#475569',
                    fontWeight: 600,
                  }}
                >
                  <th style={{ padding: '12px 16px' }}>Feature</th>
                  <th style={{ padding: '12px 16px' }}>Branch (Release / Base)</th>
                  <th style={{ padding: '12px 16px' }}>Commit SHA</th>
                  <th style={{ padding: '12px 16px' }}>Pull Request (PR URL)</th>
                  <th style={{ padding: '12px 16px' }}>Trạng Thái</th>
                  <th style={{ padding: '12px 16px' }}>Ngày Tạo</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right' }}>Thao Tác</th>
                </tr>
              </thead>
              <tbody>
                {filteredReleases.map((release) => {
                  const feat = featureMap.get(release.feature_id);
                  const isCopied = copiedShaMap[release.id] ?? false;
                  const shortSha = release.commit_sha
                    ? release.commit_sha.slice(0, 7)
                    : null;

                  return (
                    <tr
                      key={release.id}
                      data-testid={`release-row-${release.id}`}
                      style={{
                        borderBottom: '1px solid #f1f5f9',
                        transition: 'background-color 0.15s ease',
                      }}
                    >
                      {/* Cột 1: Feature */}
                      <td style={{ padding: '14px 16px', verticalAlign: 'middle' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <span
                            data-testid={`release-feature-id-${release.id}`}
                            style={{ fontWeight: 700, color: '#0f172a' }}
                          >
                            {release.feature_id}
                          </span>
                          <span
                            data-testid={`release-feature-name-${release.id}`}
                            style={{ fontSize: '12px', color: '#64748b' }}
                          >
                            {feat?.name ?? 'Tính năng'}
                          </span>
                        </div>
                      </td>

                      {/* Cột 2: Branch (Tiêu chí: Hiện branch) */}
                      <td style={{ padding: '14px 16px', verticalAlign: 'middle' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <div
                            data-testid={`release-branch-${release.id}`}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '6px',
                              fontFamily: 'ui-monospace, monospace',
                              fontSize: '12px',
                              fontWeight: 600,
                              color: '#0369a1',
                              backgroundColor: '#f0f9ff',
                              padding: '2px 8px',
                              borderRadius: '4px',
                              border: '1px solid #bae6fd',
                              width: 'fit-content',
                            }}
                          >
                            <span>🌿</span>
                            <span>{release.branch}</span>
                          </div>
                          <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                            Base: <code style={{ color: '#475569' }}>{release.base_branch}</code>
                          </div>
                        </div>
                      </td>

                      {/* Cột 3: Commit SHA (Tiêu chí: Hiện SHA) */}
                      <td style={{ padding: '14px 16px', verticalAlign: 'middle' }}>
                        {release.commit_sha ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <code
                              data-testid={`release-sha-${release.id}`}
                              title={release.commit_sha}
                              style={{
                                fontFamily: 'ui-monospace, monospace',
                                fontSize: '12px',
                                backgroundColor: '#f1f5f9',
                                border: '1px solid #cbd5e1',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                color: '#1e293b',
                              }}
                            >
                              {shortSha}
                            </code>
                            <button
                              type="button"
                              data-testid={`btn-copy-sha-${release.id}`}
                              onClick={() => void handleCopySha(release.id, release.commit_sha!)}
                              title="Sao chép toàn bộ commit SHA"
                              style={{
                                padding: '3px 8px',
                                fontSize: '11px',
                                color: isCopied ? '#16a34a' : '#475569',
                                backgroundColor: isCopied ? '#dcfce7' : '#ffffff',
                                border: `1px solid ${isCopied ? '#86efac' : '#cbd5e1'}`,
                                borderRadius: '4px',
                                cursor: 'pointer',
                              }}
                            >
                              {isCopied ? '✓ Đã chép' : '📋 Chép'}
                            </button>
                          </div>
                        ) : (
                          <span
                            data-testid={`release-no-sha-${release.id}`}
                            style={{ color: '#94a3b8', fontStyle: 'italic', fontSize: '12px' }}
                          >
                            Chưa commit SHA
                          </span>
                        )}
                      </td>

                      {/* Cột 4: PR URL (Tiêu chí: Hiện PR URL) */}
                      <td style={{ padding: '14px 16px', verticalAlign: 'middle' }}>
                        {release.pr_url ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <a
                              data-testid={`release-pr-link-${release.id}`}
                              href={release.pr_url}
                              target="_blank"
                              rel="noreferrer"
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                color: '#2563eb',
                                textDecoration: 'none',
                                fontWeight: 600,
                                fontSize: '13px',
                              }}
                            >
                              <span>🔗</span>
                              <span>
                                {typeof release.metadata?.pr_number === 'number'
                                  ? `PR #${release.metadata.pr_number}`
                                  : 'Xem Pull Request'}
                              </span>
                              <span style={{ fontSize: '11px' }}>↗</span>
                            </a>
                            <span
                              style={{
                                fontSize: '11px',
                                color: '#94a3b8',
                                maxWidth: '240px',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                              title={release.pr_url}
                            >
                              {release.pr_url}
                            </span>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span
                              data-testid={`release-no-pr-${release.id}`}
                              style={{ color: '#94a3b8', fontStyle: 'italic', fontSize: '12px' }}
                            >
                              Chưa tạo PR
                            </span>
                            <button
                              type="button"
                              data-testid={`btn-create-pr-row-${release.id}`}
                              onClick={() => handleOpenPrModal(release)}
                              style={{
                                padding: '2px 8px',
                                fontSize: '11px',
                                fontWeight: 600,
                                color: '#2563eb',
                                backgroundColor: '#eff6ff',
                                border: '1px solid #bfdbfe',
                                borderRadius: '4px',
                                cursor: 'pointer',
                              }}
                            >
                              + Tạo PR
                            </button>
                          </div>
                        )}
                      </td>

                      {/* Cột 5: Trạng Thái Release */}
                      <td style={{ padding: '14px 16px', verticalAlign: 'middle' }}>
                        <StatusBadge status={release.status} size="sm" />
                      </td>

                      {/* Cột 6: Ngày tạo */}
                      <td style={{ padding: '14px 16px', verticalAlign: 'middle', color: '#64748b', fontSize: '12px' }}>
                        {new Date(release.created_at).toLocaleString('vi-VN')}
                      </td>

                      {/* Cột 7: Thao tác */}
                      <td style={{ padding: '14px 16px', verticalAlign: 'middle', textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                          <button
                            type="button"
                            data-testid={`btn-view-report-${release.id}`}
                            onClick={() => void handleViewReport(release.feature_id)}
                            title="Xem báo cáo phát hành Markdown"
                            style={{
                              padding: '5px 10px',
                              fontSize: '12px',
                              fontWeight: 600,
                              color: '#0f172a',
                              backgroundColor: '#ffffff',
                              border: '1px solid #cbd5e1',
                              borderRadius: '6px',
                              cursor: 'pointer',
                            }}
                          >
                            📄 Báo Cáo
                          </button>

                          <button
                            type="button"
                            data-testid={`btn-check-readiness-${release.id}`}
                            onClick={() => void handleCheckReadiness(release.feature_id)}
                            disabled={loadingReadiness}
                            title="Kiểm tra điều kiện phát hành (readiness)"
                            style={{
                              padding: '5px 10px',
                              fontSize: '12px',
                              fontWeight: 600,
                              color: '#0369a1',
                              backgroundColor: '#f0f9ff',
                              border: '1px solid #bae6fd',
                              borderRadius: '6px',
                              cursor: loadingReadiness ? 'not-allowed' : 'pointer',
                              opacity: loadingReadiness ? 0.7 : 1,
                            }}
                          >
                            {loadingReadiness ? '⏳...' : '🔍 Kiểm Tra'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 6. Release Report Modal */}
      {(selectedReport || loadingReport || reportError) && (
        <div
          data-testid="modal-release-report"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '20px',
          }}
        >
          <div
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '12px',
              maxWidth: '840px',
              width: '100%',
              maxHeight: '90vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
              overflow: 'hidden',
            }}
          >
            {/* Modal Header */}
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid #e2e8f0',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <h3 style={{ margin: '0 0 2px 0', fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>
                  Báo Cáo Nghiệm Thu Phát Hành ({selectedReport?.feature_id ?? '...'})
                </h3>
                <span style={{ fontSize: '13px', color: '#64748b' }}>
                  {selectedReport?.feature_name ?? ''}
                </span>
              </div>
              <button
                type="button"
                data-testid="btn-close-report-modal"
                onClick={() => {
                  setSelectedReport(null);
                  setReportError(null);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '18px',
                  color: '#64748b',
                  cursor: 'pointer',
                  padding: '4px 8px',
                  borderRadius: '4px',
                }}
              >
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <div style={{ padding: '20px', overflowY: 'auto', flex: 1 }}>
              {loadingReport && (
                <div style={{ textAlign: 'center', padding: '30px', color: '#64748b' }}>
                  Đang tải báo cáo phát hành...
                </div>
              )}

              {reportError && (
                <div
                  style={{
                    padding: '12px',
                    backgroundColor: '#fef2f2',
                    border: '1px solid #fca5a5',
                    borderRadius: '6px',
                    color: '#991b1b',
                    fontSize: '13px',
                  }}
                >
                  {reportError}
                </div>
              )}

              {selectedReport && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {/* Metadata pills */}
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '8px',
                      padding: '12px',
                      backgroundColor: '#f8fafc',
                      borderRadius: '8px',
                      border: '1px solid #e2e8f0',
                      fontSize: '12px',
                    }}
                  >
                    <div>
                      <strong>Branch:</strong> <code>{selectedReport.branch}</code>
                    </div>
                    <div>
                      <strong>Base:</strong> <code>{selectedReport.base_branch}</code>
                    </div>
                    <div>
                      <strong>SHA:</strong> <code>{selectedReport.commit_sha}</code>
                    </div>
                    {selectedReport.pr_url && (
                      <div>
                        <strong>PR URL:</strong>{' '}
                        <a href={selectedReport.pr_url} target="_blank" rel="noreferrer" style={{ color: '#2563eb' }}>
                          {selectedReport.pr_url}
                        </a>
                      </div>
                    )}
                    <div>
                      <strong>Trạng thái:</strong> <StatusBadge status={selectedReport.status} size="sm" />
                    </div>
                  </div>

                  {/* Markdown Content Display */}
                  <div
                    data-testid="release-report-markdown-content"
                    style={{
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                      fontSize: '12px',
                      lineHeight: '1.6',
                      backgroundColor: '#0f172a',
                      color: '#f8fafc',
                      padding: '16px',
                      borderRadius: '8px',
                      whiteSpace: 'pre-wrap',
                      overflowX: 'auto',
                      maxHeight: '400px',
                    }}
                  >
                    {selectedReport.report_content}
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div
              style={{
                padding: '12px 20px',
                borderTop: '1px solid #e2e8f0',
                display: 'flex',
                justifyContent: 'flex-end',
                backgroundColor: '#f8fafc',
              }}
            >
              <button
                type="button"
                data-testid="btn-dismiss-report-modal"
                onClick={() => {
                  setSelectedReport(null);
                  setReportError(null);
                }}
                style={{
                  padding: '6px 16px',
                  fontSize: '13px',
                  fontWeight: 600,
                  color: '#475569',
                  backgroundColor: '#ffffff',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  cursor: 'pointer',
                }}
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 7. Readiness Check Modal / Panel */}
      {readinessResult && (
        <div
          data-testid="modal-readiness-check"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '20px',
          }}
        >
          <div
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '12px',
              maxWidth: '680px',
              width: '100%',
              maxHeight: '85vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid #e2e8f0',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <h3 style={{ margin: '0 0 2px 0', fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>
                  Kiểm Tra Sẵn Sàng Phát Hành: {readinessResult.feature_id}
                </h3>
                <span style={{ fontSize: '13px', color: '#64748b' }}>
                  {readinessResult.feature_name}
                </span>
              </div>
              <button
                type="button"
                data-testid="btn-close-readiness-modal"
                onClick={() => setReadinessResult(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '18px',
                  color: '#64748b',
                  cursor: 'pointer',
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Status Banner */}
              <div
                data-testid="readiness-status-badge"
                style={{
                  padding: '12px 16px',
                  borderRadius: '8px',
                  backgroundColor: readinessResult.can_release ? '#f0fdf4' : '#fef2f2',
                  border: `1px solid ${readinessResult.can_release ? '#86efac' : '#fca5a5'}`,
                  color: readinessResult.can_release ? '#166534' : '#991b1b',
                  fontWeight: 700,
                  fontSize: '15px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <span>{readinessResult.can_release ? '✅' : '❌'}</span>
                <span>
                  {readinessResult.can_release
                    ? 'ĐỦ ĐIỀU KIỆN PHÁT HÀNH (READY FOR RELEASE)'
                    : 'BỊ CHẶN PHÁT HÀNH (RELEASE BLOCKED)'}
                </span>
              </div>

              {/* Blocking Reasons if any */}
              {readinessResult.blocking_reasons.length > 0 && (
                <div
                  data-testid="readiness-blocking-reasons"
                  style={{
                    padding: '12px 16px',
                    backgroundColor: '#fff7ed',
                    border: '1px solid #fed7aa',
                    borderRadius: '8px',
                    color: '#9a3412',
                  }}
                >
                  <strong style={{ fontSize: '13px' }}>Nguyên nhân chặn phát hành:</strong>
                  <ul style={{ margin: '8px 0 0 0', paddingLeft: '20px', fontSize: '13px' }}>
                    {readinessResult.blocking_reasons.map((reason, idx) => (
                      <li key={idx}>{reason}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Task summary */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: '10px',
                  textAlign: 'center',
                }}
              >
                <div style={{ padding: '10px', backgroundColor: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
                  <div style={{ fontSize: '11px', color: '#64748b' }}>TỔNG TASK</div>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>
                    {readinessResult.task_summary.total_tasks}
                  </div>
                </div>
                <div style={{ padding: '10px', backgroundColor: '#f0fdf4', borderRadius: '6px', border: '1px solid #86efac' }}>
                  <div style={{ fontSize: '11px', color: '#166534' }}>HOÀN THÀNH (DONE)</div>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: '#166534' }}>
                    {readinessResult.task_summary.completed_count}
                  </div>
                </div>
                <div style={{ padding: '10px', backgroundColor: '#fef2f2', borderRadius: '6px', border: '1px solid #fca5a5' }}>
                  <div style={{ fontSize: '11px', color: '#991b1b' }}>THIẾU / LỖI</div>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: '#991b1b' }}>
                    {readinessResult.task_summary.missing_count + readinessResult.task_summary.failed_count}
                  </div>
                </div>
              </div>

              {/* Rule evaluations */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span style={{ fontSize: '13px', fontWeight: 700, color: '#334155' }}>
                  Chi tiết kiểm tra quy tắc:
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {readinessResult.rule_evaluations.map((rule) => (
                    <div
                      key={rule.rule_id}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid #e2e8f0',
                        backgroundColor: '#ffffff',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: '12px',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span>{rule.passed ? '✅' : '❌'}</span>
                        <strong style={{ color: '#0f172a' }}>{rule.name}</strong>
                      </div>
                      <span style={{ color: rule.passed ? '#166534' : '#991b1b', fontWeight: 600 }}>
                        {rule.message}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div
              style={{
                padding: '12px 20px',
                borderTop: '1px solid #e2e8f0',
                display: 'flex',
                justifyContent: 'flex-end',
                backgroundColor: '#f8fafc',
              }}
            >
              <button
                type="button"
                data-testid="btn-dismiss-readiness-modal"
                onClick={() => setReadinessResult(null)}
                style={{
                  padding: '6px 16px',
                  fontSize: '13px',
                  fontWeight: 600,
                  color: '#475569',
                  backgroundColor: '#ffffff',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  cursor: 'pointer',
                }}
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 8. Create PR Modal */}
      {isPrModalOpen && (
        <div
          data-testid="modal-create-pr"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '20px',
          }}
        >
          <div
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '12px',
              maxWidth: '520px',
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid #e2e8f0',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>
                Tạo Pull Request GitHub ({targetFeatureId})
              </h3>
              <button
                type="button"
                data-testid="btn-close-create-pr-modal"
                onClick={() => !isSubmittingPr && setIsPrModalOpen(false)}
                disabled={isSubmittingPr}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '18px',
                  color: '#64748b',
                  cursor: isSubmittingPr ? 'not-allowed' : 'pointer',
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label
                  htmlFor="input-pr-title"
                  style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#334155', marginBottom: '6px' }}
                >
                  Tiêu đề Pull Request:
                </label>
                <input
                  id="input-pr-title"
                  type="text"
                  data-testid="input-pr-title"
                  value={prTitle}
                  onChange={(e) => setPrTitle(e.target.value)}
                  disabled={isSubmittingPr}
                  placeholder="feat(FEAT-XXX): release feature..."
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: '13px',
                    border: '1px solid #cbd5e1',
                    borderRadius: '6px',
                    boxSizing: 'border-box',
                    outline: 'none',
                  }}
                />
              </div>

              <div>
                <label
                  htmlFor="input-pr-base-branch"
                  style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#334155', marginBottom: '6px' }}
                >
                  Nhánh đích (Base branch):
                </label>
                <input
                  id="input-pr-base-branch"
                  type="text"
                  data-testid="input-pr-base-branch"
                  value={prBaseBranch}
                  onChange={(e) => setPrBaseBranch(e.target.value)}
                  disabled={isSubmittingPr}
                  placeholder="main hoặc dev"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: '13px',
                    border: '1px solid #cbd5e1',
                    borderRadius: '6px',
                    boxSizing: 'border-box',
                    outline: 'none',
                  }}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  id="checkbox-pr-draft"
                  type="checkbox"
                  data-testid="checkbox-pr-draft"
                  checked={isPrDraft}
                  onChange={(e) => setIsPrDraft(e.target.checked)}
                  disabled={isSubmittingPr}
                  style={{ cursor: isSubmittingPr ? 'not-allowed' : 'pointer' }}
                />
                <label
                  htmlFor="checkbox-pr-draft"
                  style={{ fontSize: '13px', color: '#475569', cursor: isSubmittingPr ? 'not-allowed' : 'pointer' }}
                >
                  Tạo dưới dạng Draft Pull Request
                </label>
              </div>
            </div>

            <div
              style={{
                padding: '12px 20px',
                borderTop: '1px solid #e2e8f0',
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '10px',
                backgroundColor: '#f8fafc',
              }}
            >
              <button
                type="button"
                data-testid="btn-cancel-create-pr"
                onClick={() => setIsPrModalOpen(false)}
                disabled={isSubmittingPr}
                style={{
                  padding: '7px 16px',
                  fontSize: '13px',
                  fontWeight: 600,
                  color: '#475569',
                  backgroundColor: '#ffffff',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  cursor: isSubmittingPr ? 'not-allowed' : 'pointer',
                }}
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                data-testid="btn-submit-create-pr"
                onClick={() => void handleSubmitCreatePr()}
                disabled={isSubmittingPr || !targetFeatureId}
                style={{
                  padding: '7px 18px',
                  fontSize: '13px',
                  fontWeight: 600,
                  color: '#ffffff',
                  backgroundColor: '#2563eb',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: isSubmittingPr ? 'not-allowed' : 'pointer',
                  opacity: isSubmittingPr ? 0.7 : 1,
                }}
              >
                {isSubmittingPr ? 'Đang tạo PR...' : 'Tạo Pull Request'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
