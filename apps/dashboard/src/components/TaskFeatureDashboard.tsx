'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  TASK_STATUSES,
  FEATURE_STATUSES,
  type TaskWithDependencies,
  type Feature,
  type TaskStatus,
  type FeatureStatus,
} from '@ai-orchestrator/shared';
import { api as defaultApi, ApiClient } from '../lib/api.js';
import { StatusBadge } from './StatusBadge.js';

export interface TaskFeatureDashboardProps {
  apiClient?: ApiClient;
  initialTasks?: TaskWithDependencies[];
  initialFeatures?: Feature[];
  defaultTab?: 'tasks' | 'features';
  onSelectTask?: (taskId: string) => void;
  onSelectFeature?: (featureId: string) => void;
}

export const TaskFeatureDashboard: React.FC<TaskFeatureDashboardProps> = ({
  apiClient = defaultApi,
  initialTasks,
  initialFeatures,
  defaultTab = 'tasks',
  onSelectTask,
  onSelectFeature,
}) => {
  const [activeTab, setActiveTab] = useState<'tasks' | 'features'>(defaultTab);

  // Data states
  const [tasks, setTasks] = useState<TaskWithDependencies[]>(initialTasks ?? []);
  const [features, setFeatures] = useState<Feature[]>(initialFeatures ?? []);
  const [isLoading, setIsLoading] = useState<boolean>(!initialTasks || !initialFeatures);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Task Filter states
  const [taskStatusFilter, setTaskStatusFilter] = useState<string>('');
  const [taskFeatureFilter, setTaskFeatureFilter] = useState<string>('');
  const [taskPhaseFilter, setTaskPhaseFilter] = useState<string>('');
  const [taskSearchQuery, setTaskSearchQuery] = useState<string>('');

  // Feature Filter states
  const [featureStatusFilter, setFeatureStatusFilter] = useState<string>('');
  const [featureSearchQuery, setFeatureSearchQuery] = useState<string>('');

  // Fetch tasks from API
  const fetchTasks = useCallback(
    async (
      status?: string,
      featureId?: string,
      phase?: string,
      search?: string,
    ): Promise<TaskWithDependencies[]> => {
      const filter: Parameters<typeof apiClient.getTasks>[0] = {};
      if (status) filter.status = status as TaskStatus;
      if (featureId) filter.feature_id = featureId;
      if (phase) filter.phase = phase;
      if (search && search.trim().length > 0) filter.search = search.trim();
      return apiClient.getTasks(filter);
    },
    [apiClient],
  );

  // Fetch features from API
  const fetchFeatures = useCallback(
    async (status?: string): Promise<Feature[]> => {
      const filter: Parameters<typeof apiClient.getFeatures>[0] = {};
      if (status) filter.status = status as FeatureStatus;
      return apiClient.getFeatures(filter);
    },
    [apiClient],
  );

  // Primary loader
  const loadData = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [loadedTasks, loadedFeatures] = await Promise.all([
        fetchTasks(taskStatusFilter, taskFeatureFilter, taskPhaseFilter, taskSearchQuery),
        fetchFeatures(featureStatusFilter),
      ]);
      setTasks(loadedTasks);
      setFeatures(loadedFeatures);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
    } finally {
      setIsLoading(false);
    }
  }, [
    fetchTasks,
    fetchFeatures,
    taskStatusFilter,
    taskFeatureFilter,
    taskPhaseFilter,
    taskSearchQuery,
    featureStatusFilter,
  ]);

  // Initial and reactive load on filter changes
  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Collect unique phases from tasks for the dropdown filter
  const availablePhases = useMemo(() => {
    const phases = new Set<string>();
    for (const t of tasks) {
      if (t.phase) phases.add(t.phase);
    }
    return Array.from(phases).sort();
  }, [tasks]);

  // Filter features locally for search query
  const filteredFeatures = useMemo(() => {
    if (!featureSearchQuery.trim()) return features;
    const q = featureSearchQuery.trim().toLowerCase();
    return features.filter(
      (f) =>
        f.id.toLowerCase().includes(q) ||
        f.name.toLowerCase().includes(q) ||
        (f.description && f.description.toLowerCase().includes(q)),
    );
  }, [features, featureSearchQuery]);

  // Task summary metrics
  const taskMetrics = useMemo(() => {
    const total = tasks.length;
    let done = 0;
    let running = 0;
    let ready = 0;
    let todo = 0;
    let failed = 0;
    let blocked = 0;

    for (const t of tasks) {
      switch (t.status) {
        case 'DONE':
          done++;
          break;
        case 'RUNNING':
        case 'VERIFYING':
          running++;
          break;
        case 'READY':
          ready++;
          break;
        case 'TODO':
          todo++;
          break;
        case 'FAILED':
          failed++;
          break;
        case 'BLOCKED':
          blocked++;
          break;
      }
    }
    return { total, done, running, ready, todo, failed, blocked };
  }, [tasks]);

  // Feature summary metrics
  const featureMetrics = useMemo(() => {
    const total = features.length;
    let done = 0;
    let inProgress = 0;
    let todo = 0;
    let failed = 0;

    for (const f of features) {
      switch (f.status) {
        case 'DONE':
          done++;
          break;
        case 'IN_PROGRESS':
          inProgress++;
          break;
        case 'TODO':
          todo++;
          break;
        case 'FAILED':
        case 'BLOCKED':
          failed++;
          break;
      }
    }
    return { total, done, inProgress, todo, failed };
  }, [features]);

  // Reset filters handler
  const handleResetFilters = () => {
    if (activeTab === 'tasks') {
      setTaskStatusFilter('');
      setTaskFeatureFilter('');
      setTaskPhaseFilter('');
      setTaskSearchQuery('');
    } else {
      setFeatureStatusFilter('');
      setFeatureSearchQuery('');
    }
  };

  const hasActiveTaskFilters = Boolean(
    taskStatusFilter || taskFeatureFilter || taskPhaseFilter || taskSearchQuery,
  );
  const hasActiveFeatureFilters = Boolean(featureStatusFilter || featureSearchQuery);

  return (
    <div
      data-testid="task-feature-dashboard"
      style={{
        maxWidth: '1200px',
        margin: '0 auto',
        padding: '24px 16px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      {/* Header section */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: '16px',
          marginBottom: '20px',
        }}
      >
        <div>
          <h2
            style={{ margin: '0 0 6px 0', fontSize: '24px', fontWeight: 700, color: '#0f172a' }}
            data-testid="dashboard-title"
          >
            Quản Lý Tác Vụ & Tính Năng
          </h2>
          <p style={{ margin: 0, fontSize: '14px', color: '#64748b' }}>
            Xem danh sách nhiệm vụ worker, kiểm tra tiến độ tính năng và lọc trạng thái thời gian
            thực từ API Orchestrator.
          </p>
        </div>

        {/* Global actions: Refresh */}
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            data-testid="btn-refresh"
            onClick={() => void loadData()}
            disabled={isLoading}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '8px 14px',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              backgroundColor: '#ffffff',
              color: '#334155',
              fontSize: '13px',
              fontWeight: 600,
              cursor: isLoading ? 'not-allowed' : 'pointer',
              opacity: isLoading ? 0.6 : 1,
            }}
          >
            🔄 {isLoading ? 'Đang tải...' : 'Làm mới'}
          </button>
        </div>
      </div>

      {/* Error Banner */}
      {errorMessage && (
        <div
          data-testid="error-banner"
          style={{
            marginBottom: '20px',
            padding: '12px 16px',
            backgroundColor: '#fef2f2',
            border: '1px solid #f87171',
            borderRadius: '8px',
            color: '#991b1b',
            fontSize: '14px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <strong>Lỗi kết nối API: </strong>
            <span>{errorMessage}</span>
          </div>
          <button
            type="button"
            data-testid="btn-retry"
            onClick={() => void loadData()}
            style={{
              padding: '4px 10px',
              borderRadius: '4px',
              backgroundColor: '#991b1b',
              color: '#ffffff',
              border: 'none',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Thử lại
          </button>
        </div>
      )}

      {/* Tabs Switcher */}
      <div
        style={{
          display: 'flex',
          borderBottom: '2px solid #e2e8f0',
          marginBottom: '20px',
          gap: '8px',
        }}
      >
        <button
          type="button"
          data-testid="tab-tasks"
          onClick={() => setActiveTab('tasks')}
          style={{
            padding: '10px 18px',
            border: 'none',
            borderBottom: activeTab === 'tasks' ? '2px solid #2563eb' : '2px solid transparent',
            marginBottom: '-2px',
            backgroundColor: 'transparent',
            color: activeTab === 'tasks' ? '#2563eb' : '#64748b',
            fontSize: '15px',
            fontWeight: activeTab === 'tasks' ? 700 : 500,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span>📋 Tác Vụ (Tasks)</span>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: '9999px',
              fontSize: '12px',
              backgroundColor: activeTab === 'tasks' ? '#dbeafe' : '#f1f5f9',
              color: activeTab === 'tasks' ? '#1e40af' : '#64748b',
              fontWeight: 600,
            }}
          >
            {tasks.length}
          </span>
        </button>

        <button
          type="button"
          data-testid="tab-features"
          onClick={() => setActiveTab('features')}
          style={{
            padding: '10px 18px',
            border: 'none',
            borderBottom: activeTab === 'features' ? '2px solid #2563eb' : '2px solid transparent',
            marginBottom: '-2px',
            backgroundColor: 'transparent',
            color: activeTab === 'features' ? '#2563eb' : '#64748b',
            fontSize: '15px',
            fontWeight: activeTab === 'features' ? 700 : 500,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span>🎯 Tính Năng (Features)</span>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: '9999px',
              fontSize: '12px',
              backgroundColor: activeTab === 'features' ? '#dbeafe' : '#f1f5f9',
              color: activeTab === 'features' ? '#1e40af' : '#64748b',
              fontWeight: 600,
            }}
          >
            {features.length}
          </span>
        </button>
      </div>

      {/* Summary Metrics Bar */}
      {activeTab === 'tasks' ? (
        <div
          data-testid="task-metrics-bar"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
            gap: '12px',
            marginBottom: '20px',
          }}
        >
          <div
            data-testid="metric-total-tasks"
            style={{
              padding: '12px',
              backgroundColor: '#ffffff',
              borderRadius: '8px',
              border: '1px solid #e2e8f0',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#64748b' }}>TỔNG SỐ</div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: '#0f172a' }}>
              {taskMetrics.total}
            </div>
          </div>
          <div
            data-testid="metric-done-tasks"
            style={{
              padding: '12px',
              backgroundColor: '#f0fdf4',
              borderRadius: '8px',
              border: '1px solid #86efac',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#166534' }}>DONE</div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: '#166534' }}>
              {taskMetrics.done}
            </div>
          </div>
          <div
            data-testid="metric-running-tasks"
            style={{
              padding: '12px',
              backgroundColor: '#eff6ff',
              borderRadius: '8px',
              border: '1px solid #93c5fd',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#1e40af' }}>RUNNING</div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: '#1e40af' }}>
              {taskMetrics.running}
            </div>
          </div>
          <div
            data-testid="metric-ready-tasks"
            style={{
              padding: '12px',
              backgroundColor: '#fefce8',
              borderRadius: '8px',
              border: '1px solid #fde047',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#854d0e' }}>READY</div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: '#854d0e' }}>
              {taskMetrics.ready}
            </div>
          </div>
          <div
            data-testid="metric-todo-tasks"
            style={{
              padding: '12px',
              backgroundColor: '#f8fafc',
              borderRadius: '8px',
              border: '1px solid #cbd5e1',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#475569' }}>TODO</div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: '#475569' }}>
              {taskMetrics.todo}
            </div>
          </div>
          <div
            data-testid="metric-failed-tasks"
            style={{
              padding: '12px',
              backgroundColor: '#fef2f2',
              borderRadius: '8px',
              border: '1px solid #fca5a5',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#991b1b' }}>
              FAILED / BLOCKED
            </div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: '#991b1b' }}>
              {taskMetrics.failed + taskMetrics.blocked}
            </div>
          </div>
        </div>
      ) : (
        <div
          data-testid="feature-metrics-bar"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: '12px',
            marginBottom: '20px',
          }}
        >
          <div
            data-testid="metric-total-features"
            style={{
              padding: '12px',
              backgroundColor: '#ffffff',
              borderRadius: '8px',
              border: '1px solid #e2e8f0',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#64748b' }}>
              TỔNG SỐ FEATURE
            </div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: '#0f172a' }}>
              {featureMetrics.total}
            </div>
          </div>
          <div
            data-testid="metric-done-features"
            style={{
              padding: '12px',
              backgroundColor: '#f0fdf4',
              borderRadius: '8px',
              border: '1px solid #86efac',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#166534' }}>DONE</div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: '#166534' }}>
              {featureMetrics.done}
            </div>
          </div>
          <div
            data-testid="metric-inprogress-features"
            style={{
              padding: '12px',
              backgroundColor: '#eff6ff',
              borderRadius: '8px',
              border: '1px solid #93c5fd',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#1e40af' }}>IN PROGRESS</div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: '#1e40af' }}>
              {featureMetrics.inProgress}
            </div>
          </div>
          <div
            data-testid="metric-todo-features"
            style={{
              padding: '12px',
              backgroundColor: '#f8fafc',
              borderRadius: '8px',
              border: '1px solid #cbd5e1',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: '11px', fontWeight: 600, color: '#475569' }}>TODO</div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: '#475569' }}>
              {featureMetrics.todo}
            </div>
          </div>
        </div>
      )}

      {/* Filter Bar */}
      <div
        data-testid="filter-bar"
        style={{
          padding: '16px',
          backgroundColor: '#ffffff',
          borderRadius: '8px',
          border: '1px solid #e2e8f0',
          marginBottom: '20px',
        }}
      >
        {activeTab === 'tasks' ? (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '12px',
              alignItems: 'center',
            }}
          >
            {/* Search Input */}
            <div style={{ flex: '1 1 200px', minWidth: '180px' }}>
              <label
                htmlFor="filter-task-search"
                style={{
                  display: 'block',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#475569',
                  marginBottom: '4px',
                }}
              >
                Tìm kiếm
              </label>
              <input
                id="filter-task-search"
                type="text"
                data-testid="filter-task-search"
                placeholder="Tìm ID, tiêu đề, mô tả..."
                value={taskSearchQuery}
                onChange={(e) => setTaskSearchQuery(e.target.value)}
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  fontSize: '13px',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Status Filter */}
            <div style={{ flex: '0 1 160px', minWidth: '140px' }}>
              <label
                htmlFor="filter-task-status"
                style={{
                  display: 'block',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#475569',
                  marginBottom: '4px',
                }}
              >
                Trạng thái
              </label>
              <select
                id="filter-task-status"
                data-testid="filter-task-status"
                value={taskStatusFilter}
                onChange={(e) => setTaskStatusFilter(e.target.value)}
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  fontSize: '13px',
                  backgroundColor: '#ffffff',
                  boxSizing: 'border-box',
                }}
              >
                <option value="">Tất cả trạng thái</option>
                {TASK_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>

            {/* Feature Filter */}
            <div style={{ flex: '0 1 180px', minWidth: '150px' }}>
              <label
                htmlFor="filter-task-feature"
                style={{
                  display: 'block',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#475569',
                  marginBottom: '4px',
                }}
              >
                Tính năng (Feature)
              </label>
              <select
                id="filter-task-feature"
                data-testid="filter-task-feature"
                value={taskFeatureFilter}
                onChange={(e) => setTaskFeatureFilter(e.target.value)}
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  fontSize: '13px',
                  backgroundColor: '#ffffff',
                  boxSizing: 'border-box',
                }}
              >
                <option value="">Tất cả tính năng</option>
                {features.map((feat) => (
                  <option key={feat.id} value={feat.id}>
                    {feat.id}: {feat.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Phase Filter */}
            <div style={{ flex: '0 1 140px', minWidth: '120px' }}>
              <label
                htmlFor="filter-task-phase"
                style={{
                  display: 'block',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#475569',
                  marginBottom: '4px',
                }}
              >
                Phase
              </label>
              <select
                id="filter-task-phase"
                data-testid="filter-task-phase"
                value={taskPhaseFilter}
                onChange={(e) => setTaskPhaseFilter(e.target.value)}
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  fontSize: '13px',
                  backgroundColor: '#ffffff',
                  boxSizing: 'border-box',
                }}
              >
                <option value="">Tất cả phase</option>
                {availablePhases.map((phase) => (
                  <option key={phase} value={phase}>
                    Phase {phase}
                  </option>
                ))}
              </select>
            </div>

            {/* Reset button */}
            <div style={{ alignSelf: 'flex-end' }}>
              <button
                type="button"
                data-testid="btn-reset-filters"
                onClick={handleResetFilters}
                disabled={!hasActiveTaskFilters}
                style={{
                  padding: '7px 12px',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  backgroundColor: '#ffffff',
                  color: '#64748b',
                  fontSize: '13px',
                  fontWeight: 500,
                  cursor: hasActiveTaskFilters ? 'pointer' : 'not-allowed',
                  opacity: hasActiveTaskFilters ? 1 : 0.5,
                }}
              >
                Xóa bộ lọc
              </button>
            </div>
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '12px',
              alignItems: 'center',
            }}
          >
            {/* Search Input for Features */}
            <div style={{ flex: '1 1 240px', minWidth: '200px' }}>
              <label
                htmlFor="filter-feature-search"
                style={{
                  display: 'block',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#475569',
                  marginBottom: '4px',
                }}
              >
                Tìm kiếm Feature
              </label>
              <input
                id="filter-feature-search"
                type="text"
                data-testid="filter-feature-search"
                placeholder="Tìm ID hoặc tên tính năng..."
                value={featureSearchQuery}
                onChange={(e) => setFeatureSearchQuery(e.target.value)}
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  fontSize: '13px',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Status Filter for Features */}
            <div style={{ flex: '0 1 180px', minWidth: '150px' }}>
              <label
                htmlFor="filter-feature-status"
                style={{
                  display: 'block',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: '#475569',
                  marginBottom: '4px',
                }}
              >
                Trạng thái Feature
              </label>
              <select
                id="filter-feature-status"
                data-testid="filter-feature-status"
                value={featureStatusFilter}
                onChange={(e) => setFeatureStatusFilter(e.target.value)}
                style={{
                  width: '100%',
                  padding: '7px 10px',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  fontSize: '13px',
                  backgroundColor: '#ffffff',
                  boxSizing: 'border-box',
                }}
              >
                <option value="">Tất cả trạng thái</option>
                {FEATURE_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>

            {/* Reset button for features */}
            <div style={{ alignSelf: 'flex-end' }}>
              <button
                type="button"
                data-testid="btn-reset-filters"
                onClick={handleResetFilters}
                disabled={!hasActiveFeatureFilters}
                style={{
                  padding: '7px 12px',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  backgroundColor: '#ffffff',
                  color: '#64748b',
                  fontSize: '13px',
                  fontWeight: 500,
                  cursor: hasActiveFeatureFilters ? 'pointer' : 'not-allowed',
                  opacity: hasActiveFeatureFilters ? 1 : 0.5,
                }}
              >
                Xóa bộ lọc
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Loading state indicator */}
      {isLoading && (
        <div
          data-testid="loading-indicator"
          style={{
            padding: '24px',
            textAlign: 'center',
            color: '#64748b',
            fontSize: '14px',
            backgroundColor: '#ffffff',
            borderRadius: '8px',
            border: '1px solid #e2e8f0',
            marginBottom: '20px',
          }}
        >
          <span>⏳ Đang tải dữ liệu từ API Orchestrator...</span>
        </div>
      )}

      {/* Main Content Area: Tasks or Features Table */}
      {activeTab === 'tasks' ? (
        tasks.length === 0 && !isLoading ? (
          <div
            data-testid="empty-tasks-state"
            style={{
              padding: '48px 20px',
              textAlign: 'center',
              backgroundColor: '#ffffff',
              borderRadius: '8px',
              border: '1px dashed #cbd5e1',
              color: '#64748b',
            }}
          >
            <div style={{ fontSize: '32px', marginBottom: '8px' }}>📂</div>
            <h3 style={{ margin: '0 0 6px 0', fontSize: '16px', color: '#1e293b' }}>
              Không tìm thấy tác vụ nào
            </h3>
            <p style={{ margin: '0 0 16px 0', fontSize: '13px' }}>
              {hasActiveTaskFilters
                ? 'Không có tác vụ nào khớp với bộ lọc hiện tại. Hãy thử điều chỉnh hoặc xóa bộ lọc.'
                : 'Chưa có tác vụ nào trong hệ thống. Hãy nạp tác vụ tại trang Nhập Yêu Cầu (Import).'}
            </p>
            {hasActiveTaskFilters && (
              <button
                type="button"
                onClick={handleResetFilters}
                style={{
                  padding: '6px 14px',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  backgroundColor: '#ffffff',
                  color: '#2563eb',
                  fontSize: '13px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Xóa bộ lọc
              </button>
            )}
          </div>
        ) : (
          <div
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '8px',
              border: '1px solid #e2e8f0',
              overflowX: 'auto',
            }}
          >
            <table
              data-testid="tasks-table"
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
                    fontSize: '12px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Task ID</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Tiêu đề & Mô tả</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Phase</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Feature</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Trạng thái</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Lần chạy</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Phụ thuộc</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Ưu tiên</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task, idx) => (
                  <tr
                    key={task.id}
                    data-testid={`task-row-${task.id}`}
                    style={{
                      borderBottom: idx < tasks.length - 1 ? '1px solid #f1f5f9' : 'none',
                      backgroundColor: idx % 2 === 0 ? '#ffffff' : '#fafafa',
                      transition: 'background-color 0.15s',
                    }}
                  >
                    {/* Task ID */}
                    <td
                      style={{ padding: '12px 16px', verticalAlign: 'top', whiteSpace: 'nowrap' }}
                    >
                      <a
                        href={`/tasks/${encodeURIComponent(task.id)}`}
                        data-testid={`task-id-${task.id}`}
                        onClick={(e) => {
                          if (onSelectTask) {
                            e.preventDefault();
                            onSelectTask(task.id);
                          }
                        }}
                        style={{
                          fontWeight: 700,
                          color: '#2563eb',
                          textDecoration: 'none',
                          fontFamily: 'monospace',
                          fontSize: '13px',
                        }}
                      >
                        {task.id}
                      </a>
                    </td>

                    {/* Title & Description */}
                    <td style={{ padding: '12px 16px', verticalAlign: 'top', maxWidth: '340px' }}>
                      <div
                        data-testid={`task-title-${task.id}`}
                        style={{ fontWeight: 600, color: '#0f172a', marginBottom: '2px' }}
                      >
                        {task.title}
                      </div>
                      {task.description && (
                        <div
                          data-testid={`task-desc-${task.id}`}
                          style={{
                            fontSize: '12px',
                            color: '#64748b',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={task.description}
                        >
                          {task.description}
                        </div>
                      )}
                    </td>

                    {/* Phase */}
                    <td
                      style={{ padding: '12px 16px', verticalAlign: 'top', whiteSpace: 'nowrap' }}
                    >
                      {task.phase ? (
                        <span
                          data-testid={`task-phase-${task.id}`}
                          style={{
                            padding: '2px 8px',
                            borderRadius: '4px',
                            backgroundColor: '#f1f5f9',
                            color: '#334155',
                            fontSize: '11px',
                            fontWeight: 600,
                          }}
                        >
                          Phase {task.phase}
                        </span>
                      ) : (
                        <span style={{ color: '#94a3b8' }}>—</span>
                      )}
                    </td>

                    {/* Feature */}
                    <td
                      style={{ padding: '12px 16px', verticalAlign: 'top', whiteSpace: 'nowrap' }}
                    >
                      {task.feature_id ? (
                        <span
                          data-testid={`task-feature-${task.id}`}
                          style={{
                            padding: '2px 8px',
                            borderRadius: '4px',
                            backgroundColor: '#eff6ff',
                            color: '#1d4ed8',
                            fontSize: '11px',
                            fontWeight: 600,
                          }}
                        >
                          {task.feature_id}
                        </span>
                      ) : (
                        <span style={{ color: '#94a3b8' }}>—</span>
                      )}
                    </td>

                    {/* Status */}
                    <td
                      style={{ padding: '12px 16px', verticalAlign: 'top', whiteSpace: 'nowrap' }}
                    >
                      <StatusBadge status={task.status} />
                    </td>

                    {/* Attempts */}
                    <td
                      data-testid={`task-attempts-${task.id}`}
                      style={{ padding: '12px 16px', verticalAlign: 'top', whiteSpace: 'nowrap' }}
                    >
                      <span style={{ fontWeight: 600, color: '#334155' }}>{task.attempts}</span>
                      <span style={{ color: '#94a3b8' }}> / {task.max_attempts}</span>
                    </td>

                    {/* Dependencies */}
                    <td style={{ padding: '12px 16px', verticalAlign: 'top' }}>
                      {task.dependencies && task.dependencies.length > 0 ? (
                        <div
                          data-testid={`task-dependencies-${task.id}`}
                          style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}
                        >
                          {task.dependencies.map((depId) => (
                            <span
                              key={depId}
                              style={{
                                padding: '1px 6px',
                                borderRadius: '4px',
                                backgroundColor: '#f8fafc',
                                border: '1px solid #e2e8f0',
                                color: '#475569',
                                fontSize: '11px',
                                fontFamily: 'monospace',
                              }}
                            >
                              {depId}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span style={{ color: '#94a3b8' }}>—</span>
                      )}
                    </td>

                    {/* Priority */}
                    <td
                      data-testid={`task-priority-${task.id}`}
                      style={{
                        padding: '12px 16px',
                        verticalAlign: 'top',
                        fontWeight: 600,
                        color: task.priority > 0 ? '#b45309' : '#64748b',
                      }}
                    >
                      {task.priority}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : /* Features Tab Content */
      filteredFeatures.length === 0 && !isLoading ? (
        <div
          data-testid="empty-features-state"
          style={{
            padding: '48px 20px',
            textAlign: 'center',
            backgroundColor: '#ffffff',
            borderRadius: '8px',
            border: '1px dashed #cbd5e1',
            color: '#64748b',
          }}
        >
          <div style={{ fontSize: '32px', marginBottom: '8px' }}>🎯</div>
          <h3 style={{ margin: '0 0 6px 0', fontSize: '16px', color: '#1e293b' }}>
            Không tìm thấy tính năng nào
          </h3>
          <p style={{ margin: '0 0 16px 0', fontSize: '13px' }}>
            {hasActiveFeatureFilters
              ? 'Không có tính năng nào khớp với bộ lọc hiện tại.'
              : 'Chưa có tính năng nào được đăng ký trong hệ thống.'}
          </p>
          {hasActiveFeatureFilters && (
            <button
              type="button"
              onClick={handleResetFilters}
              style={{
                padding: '6px 14px',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
                backgroundColor: '#ffffff',
                color: '#2563eb',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Xóa bộ lọc
            </button>
          )}
        </div>
      ) : (
        <div
          style={{
            backgroundColor: '#ffffff',
            borderRadius: '8px',
            border: '1px solid #e2e8f0',
            overflowX: 'auto',
          }}
        >
          <table
            data-testid="features-table"
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
                  fontSize: '12px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>Feature ID</th>
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>Tên Tính Năng</th>
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>Mô tả</th>
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>Trạng thái</th>
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>Tasks Bắt Buộc</th>
                <th style={{ padding: '12px 16px', fontWeight: 600 }}>Integration Tests</th>
              </tr>
            </thead>
            <tbody>
              {filteredFeatures.map((feat, idx) => (
                <tr
                  key={feat.id}
                  data-testid={`feature-row-${feat.id}`}
                  style={{
                    borderBottom: idx < filteredFeatures.length - 1 ? '1px solid #f1f5f9' : 'none',
                    backgroundColor: idx % 2 === 0 ? '#ffffff' : '#fafafa',
                  }}
                >
                  {/* Feature ID */}
                  <td style={{ padding: '12px 16px', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                    <span
                      data-testid={`feature-id-${feat.id}`}
                      onClick={() => {
                        if (onSelectFeature) onSelectFeature(feat.id);
                      }}
                      style={{
                        fontWeight: 700,
                        color: '#2563eb',
                        fontFamily: 'monospace',
                        fontSize: '13px',
                        cursor: onSelectFeature ? 'pointer' : 'default',
                      }}
                    >
                      {feat.id}
                    </span>
                  </td>

                  {/* Feature Name */}
                  <td
                    data-testid={`feature-name-${feat.id}`}
                    style={{
                      padding: '12px 16px',
                      verticalAlign: 'top',
                      fontWeight: 600,
                      color: '#0f172a',
                    }}
                  >
                    {feat.name}
                  </td>

                  {/* Description */}
                  <td
                    data-testid={`feature-desc-${feat.id}`}
                    style={{
                      padding: '12px 16px',
                      verticalAlign: 'top',
                      color: '#64748b',
                      maxWidth: '300px',
                    }}
                  >
                    {feat.description ?? '—'}
                  </td>

                  {/* Status */}
                  <td style={{ padding: '12px 16px', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                    <StatusBadge status={feat.status} />
                  </td>

                  {/* Required Tasks */}
                  <td
                    data-testid={`feature-required-tasks-${feat.id}`}
                    style={{ padding: '12px 16px', verticalAlign: 'top' }}
                  >
                    {feat.required_tasks && feat.required_tasks.length > 0 ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {feat.required_tasks.map((taskId) => (
                          <span
                            key={taskId}
                            style={{
                              padding: '1px 6px',
                              borderRadius: '4px',
                              backgroundColor: '#f1f5f9',
                              color: '#334155',
                              fontSize: '11px',
                              fontFamily: 'monospace',
                            }}
                          >
                            {taskId}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span style={{ color: '#94a3b8' }}>0 tác vụ</span>
                    )}
                  </td>

                  {/* Integration Tests */}
                  <td
                    data-testid={`feature-tests-${feat.id}`}
                    style={{ padding: '12px 16px', verticalAlign: 'top' }}
                  >
                    {feat.integration_tests && feat.integration_tests.length > 0 ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        {feat.integration_tests.map((cmd, cIdx) => (
                          <code
                            key={cIdx}
                            style={{
                              fontSize: '11px',
                              backgroundColor: '#f8fafc',
                              padding: '2px 4px',
                              borderRadius: '4px',
                              color: '#0369a1',
                            }}
                          >
                            {cmd}
                          </code>
                        ))}
                      </div>
                    ) : (
                      <span style={{ color: '#94a3b8' }}>—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
