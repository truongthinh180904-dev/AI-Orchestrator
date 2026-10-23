'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  type SchedulerStatus,
  type Plan,
  type PlanReviewSummary,
  type PlanStatus,
  PLAN_STATUSES,
} from '@ai-orchestrator/shared';
import { ApiClient, api as defaultApi } from '../lib/api.js';

export interface SystemControlsProps {
  apiClient?: ApiClient;
  autoRefreshIntervalMs?: number;
  initialSchedulerStatus?: SchedulerStatus | null;
  initialPlans?: Plan[];
  onActionComplete?: (action: string, result: unknown) => void;
}

export const SystemControls: React.FC<SystemControlsProps> = ({
  apiClient,
  autoRefreshIntervalMs = 0,
  initialSchedulerStatus = null,
  initialPlans = [],
  onActionComplete,
}) => {
  const client = apiClient ?? defaultApi;

  // Scheduler state
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | null>(
    initialSchedulerStatus,
  );
  const [plans, setPlans] = useState<Plan[]>(initialPlans);
  const [selectedPlanId, setSelectedPlanId] = useState<string>(
    initialPlans.length > 0 && initialPlans[0] ? initialPlans[0].id : '',
  );
  const [planReview, setPlanReview] = useState<PlanReviewSummary | null>(null);

  // Loading & Action states
  const [loading, setLoading] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [submittingAction, setSubmittingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Filters & Form inputs
  const [planStatusFilter, setPlanStatusFilter] = useState<string>('ALL');
  const [reviewerName, setReviewerName] = useState<string>('reviewer');
  const [approveComments, setApproveComments] = useState<string>('');
  const [rejectReason, setRejectReason] = useState<string>('');
  const [customRunId, setCustomRunId] = useState<string>('');

  // Stop Confirmation Modal state
  const [showStopModal, setShowStopModal] = useState<boolean>(false);
  const [stopTarget, setStopTarget] = useState<'scheduler' | 'run'>('scheduler');
  const [stopReason, setStopReason] = useState<string>('Yêu cầu dừng từ Bảng Điều Khiển Dashboard');
  const [stopForce, setStopForce] = useState<boolean>(false);

  // Fetch scheduler status and plans
  const fetchAllData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusRes, plansRes] = await Promise.allSettled([
        client.getSchedulerStatus(),
        client.listPlans(),
      ]);

      if (statusRes.status === 'fulfilled') {
        setSchedulerStatus(statusRes.value);
        if (statusRes.value.activeRunId && !customRunId) {
          setCustomRunId(statusRes.value.activeRunId);
        }
      } else {
        const msg =
          statusRes.reason instanceof Error
            ? statusRes.reason.message
            : String(statusRes.reason);
        setError(`Không thể tải trạng thái Scheduler: ${msg}`);
      }

      if (plansRes.status === 'fulfilled') {
        setPlans(plansRes.value);
        if (!selectedPlanId && plansRes.value.length > 0 && plansRes.value[0]) {
          setSelectedPlanId(plansRes.value[0].id);
        }
      }
    } finally {
      setLoading(false);
    }
  }, [client, customRunId, selectedPlanId]);

  // Fetch plan review details when selectedPlanId changes
  const fetchPlanReview = useCallback(
    async (planId: string) => {
      if (!planId) {
        setPlanReview(null);
        return;
      }
      try {
        const review = await client.getPlanReview(planId);
        setPlanReview(review);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(`Không thể tải tóm tắt review cho kế hoạch ${planId}: ${msg}`);
        setPlanReview(null);
      }
    },
    [client],
  );

  useEffect(() => {
    void fetchAllData();
  }, [fetchAllData]);

  useEffect(() => {
    if (selectedPlanId) {
      void fetchPlanReview(selectedPlanId);
    }
  }, [selectedPlanId, fetchPlanReview]);

  // Optional auto-refresh timer
  useEffect(() => {
    if (autoRefreshIntervalMs <= 0) return;
    const timer = setInterval(() => {
      void fetchAllData();
      if (selectedPlanId) {
        void fetchPlanReview(selectedPlanId);
      }
    }, autoRefreshIntervalMs);
    return () => clearInterval(timer);
  }, [autoRefreshIntervalMs, fetchAllData, fetchPlanReview, selectedPlanId]);

  // Currently selected plan object
  const selectedPlan =
    plans.find((p) => p.id === selectedPlanId) ?? planReview?.plan ?? null;

  // Filtered plans list
  const filteredPlans = plans.filter((p) => {
    if (planStatusFilter === 'ALL') return true;
    return p.status === planStatusFilter;
  });

  // --- Scheduler Actions ---

  const handleStartScheduler = async () => {
    setIsSubmitting(true);
    setSubmittingAction('start-scheduler');
    setError(null);
    setSuccess(null);
    try {
      const res = await client.startScheduler();
      setSuccess('Đã khởi động sequential scheduler thành công.');
      onActionComplete?.('startScheduler', res);
      await fetchAllData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Lỗi khi khởi động Scheduler: ${msg}`);
    } finally {
      setIsSubmitting(false);
      setSubmittingAction(null);
    }
  };

  const handlePauseScheduler = async () => {
    setIsSubmitting(true);
    setSubmittingAction('pause-scheduler');
    setError(null);
    setSuccess(null);
    try {
      const res = await client.pauseScheduler();
      setSuccess('Đã tạm dừng (PAUSE) Scheduler thành công.');
      onActionComplete?.('pauseScheduler', res);
      await fetchAllData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Lỗi khi tạm dừng Scheduler: ${msg}`);
    } finally {
      setIsSubmitting(false);
      setSubmittingAction(null);
    }
  };

  const handleResumeScheduler = async () => {
    setIsSubmitting(true);
    setSubmittingAction('resume-scheduler');
    setError(null);
    setSuccess(null);
    try {
      const res = await client.resumeScheduler();
      setSuccess('Đã tiếp tục (RESUME) Scheduler thành công.');
      onActionComplete?.('resumeScheduler', res);
      await fetchAllData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Lỗi khi tiếp tục Scheduler: ${msg}`);
    } finally {
      setIsSubmitting(false);
      setSubmittingAction(null);
    }
  };

  const handleStepScheduler = async () => {
    setIsSubmitting(true);
    setSubmittingAction('step-scheduler');
    setError(null);
    setSuccess(null);
    try {
      const res = await client.stepScheduler();
      setSuccess(
        res.executed
          ? `Đã thực thi bước tiếp theo cho task: ${res.taskId ?? 'N/A'}`
          : `Không có task nào được thực thi (${res.reason ?? 'NONE'})`,
      );
      onActionComplete?.('stepScheduler', res);
      await fetchAllData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Lỗi khi thực thi bước Scheduler: ${msg}`);
    } finally {
      setIsSubmitting(false);
      setSubmittingAction(null);
    }
  };

  const handleReleaseLock = async () => {
    setIsSubmitting(true);
    setSubmittingAction('release-lock');
    setError(null);
    setSuccess(null);
    try {
      const res = await client.releaseSchedulerLock();
      setSuccess('Đã giải phóng agent lock thành công.');
      onActionComplete?.('releaseSchedulerLock', res);
      await fetchAllData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Lỗi khi giải phóng agent lock: ${msg}`);
    } finally {
      setIsSubmitting(false);
      setSubmittingAction(null);
    }
  };

  // --- Stop Confirmation Workflow ---

  const openStopConfirmation = (target: 'scheduler' | 'run') => {
    setStopTarget(target);
    setStopReason(
      target === 'scheduler'
        ? 'Dừng khẩn cấp toàn bộ Scheduler và tác vụ đang chạy'
        : `Dừng khẩn cấp tiến trình run ${customRunId || schedulerStatus?.activeRunId || ''}`,
    );
    setShowStopModal(true);
  };

  const handleConfirmStop = async () => {
    setShowStopModal(false);
    setIsSubmitting(true);
    setSubmittingAction(stopTarget === 'scheduler' ? 'stop-scheduler' : 'stop-run');
    setError(null);
    setSuccess(null);

    try {
      if (stopTarget === 'scheduler') {
        const res = await client.stopScheduler();
        setSuccess('Đã dừng Scheduler và hủy các tiến trình active thành công.');
        onActionComplete?.('stopScheduler', res);
      } else {
        const runIdToStop = customRunId || schedulerStatus?.activeRunId;
        if (!runIdToStop) {
          throw new Error('Chưa cung cấp Run ID để dừng!');
        }
        const res = await client.stopRun(runIdToStop, {
          reason: stopReason,
          force: stopForce,
        });
        setSuccess(`Đã dừng tiến trình Run ${runIdToStop} thành công.`);
        onActionComplete?.('stopRun', res);
      }
      await fetchAllData();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Lỗi khi thực hiện dừng khẩn cấp: ${msg}`);
    } finally {
      setIsSubmitting(false);
      setSubmittingAction(null);
    }
  };

  // --- Plan Review & Approval Actions (ORC-007) ---

  const handleApprovePlan = async () => {
    if (!selectedPlan) return;
    setIsSubmitting(true);
    setSubmittingAction('approve-plan');
    setError(null);
    setSuccess(null);

    try {
      const updatedPlan = await client.approvePlan(selectedPlan.id, {
        approved_by: reviewerName.trim() || 'reviewer',
        comments: approveComments.trim() || undefined,
      });
      setSuccess(`Kế hoạch ${selectedPlan.id} đã được phê duyệt thành công! Trạng thái: APPROVED.`);
      onActionComplete?.('approvePlan', updatedPlan);
      await fetchAllData();
      await fetchPlanReview(selectedPlan.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Lỗi khi phê duyệt kế hoạch: ${msg}`);
    } finally {
      setIsSubmitting(false);
      setSubmittingAction(null);
    }
  };

  const handleRejectPlan = async () => {
    if (!selectedPlan) return;
    if (!rejectReason.trim()) {
      setError('Vui lòng nhập lý do từ chối kế hoạch!');
      return;
    }

    setIsSubmitting(true);
    setSubmittingAction('reject-plan');
    setError(null);
    setSuccess(null);

    try {
      const updatedPlan = await client.rejectPlan(selectedPlan.id, {
        reason: rejectReason.trim(),
        rejected_by: reviewerName.trim() || 'reviewer',
      });
      setSuccess(`Kế hoạch ${selectedPlan.id} đã bị từ chối. Trạng thái: REJECTED.`);
      onActionComplete?.('rejectPlan', updatedPlan);
      await fetchAllData();
      await fetchPlanReview(selectedPlan.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Lỗi khi từ chối kế hoạch: ${msg}`);
    } finally {
      setIsSubmitting(false);
      setSubmittingAction(null);
    }
  };

  const handleSubmitPlanForReview = async () => {
    if (!selectedPlan) return;
    setIsSubmitting(true);
    setSubmittingAction('submit-plan');
    setError(null);
    setSuccess(null);

    try {
      const updatedPlan = await client.submitPlanForReview(selectedPlan.id);
      setSuccess(`Đã gửi lại kế hoạch ${selectedPlan.id} chờ phê duyệt.`);
      onActionComplete?.('submitPlanForReview', updatedPlan);
      await fetchAllData();
      await fetchPlanReview(selectedPlan.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Lỗi khi gửi lại kế hoạch: ${msg}`);
    } finally {
      setIsSubmitting(false);
      setSubmittingAction(null);
    }
  };

  const handleExecutePlan = async () => {
    if (!selectedPlan) return;

    // Strict Enforcement of ORC-007: "Chưa duyệt → không thực thi"
    if (selectedPlan.status !== 'APPROVED') {
      setError(
        `CHẶN THỰC THI: Quy tắc an toàn bắt buộc: Chưa duyệt → không thực thi! Kế hoạch '${selectedPlan.id}' đang ở trạng thái '${selectedPlan.status}'. Hãy phê duyệt (APPROVE) trước khi chạy.`,
      );
      return;
    }

    setIsSubmitting(true);
    setSubmittingAction('execute-plan');
    setError(null);
    setSuccess(null);

    try {
      const res = await client.executePlan(selectedPlan.id, {
        autoStart: true,
        executor: reviewerName || 'orchestrator',
      });
      setSuccess(`Kế hoạch ${selectedPlan.id} đã được khởi chạy thực thi thành công!`);
      onActionComplete?.('executePlan', res);
      await fetchAllData();
      await fetchPlanReview(selectedPlan.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Lỗi khi thực thi kế hoạch: ${msg}`);
    } finally {
      setIsSubmitting(false);
      setSubmittingAction(null);
    }
  };

  // Status badge styling helper
  const getPlanStatusBadge = (status: PlanStatus) => {
    switch (status) {
      case 'APPROVED':
        return {
          bg: '#ecfdf5',
          border: '#6ee7b7',
          color: '#065f46',
          label: 'ĐÃ DUYỆT (APPROVED)',
        };
      case 'PENDING_APPROVAL':
        return {
          bg: '#fffbeb',
          border: '#fcd34d',
          color: '#92400e',
          label: 'CHỜ DUYỆT (PENDING_APPROVAL)',
        };
      case 'REJECTED':
        return {
          bg: '#fef2f2',
          border: '#fca5a5',
          color: '#991b1b',
          label: 'TỪ CHỐI (REJECTED)',
        };
      case 'EXECUTING':
        return {
          bg: '#eff6ff',
          border: '#93c5fd',
          color: '#1e40af',
          label: 'ĐANG CHẠY (EXECUTING)',
        };
      case 'COMPLETED':
        return {
          bg: '#f0fdf4',
          border: '#86efac',
          color: '#166534',
          label: 'HOÀN THÀNH (COMPLETED)',
        };
      case 'FAILED':
        return {
          bg: '#fef2f2',
          border: '#f87171',
          color: '#b91c1c',
          label: 'THẤT BẠI (FAILED)',
        };
      case 'DRAFT':
      default:
        return {
          bg: '#f8fafc',
          border: '#cbd5e1',
          color: '#475569',
          label: 'BẢN THẢO (DRAFT)',
        };
    }
  };

  return (
    <div
      data-testid="system-controls-dashboard"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '24px',
        maxWidth: '1200px',
        margin: '0 auto',
      }}
    >
      {/* Header Bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          borderBottom: '1px solid #e2e8f0',
          paddingBottom: '16px',
        }}
      >
        <div>
          <h2
            style={{
              margin: '0 0 6px 0',
              fontSize: '24px',
              fontWeight: 700,
              color: '#0f172a',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
            }}
          >
            <span>🎛️</span> Bảng Điều Khiển Vận Hành (Controls)
          </h2>
          <p style={{ margin: 0, fontSize: '14px', color: '#64748b', lineHeight: 1.5 }}>
            Điều khiển hệ thống thời gian thực với backend thật: Tạm dừng (Pause), Tiếp tục (Resume),
            Dừng khẩn cấp (Stop), và Phê duyệt Kế hoạch (Approve).
          </p>
        </div>

        <button
          type="button"
          data-testid="btn-refresh-all"
          disabled={loading || isSubmitting}
          onClick={() => void fetchAllData()}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 16px',
            backgroundColor: '#ffffff',
            border: '1px solid #cbd5e1',
            borderRadius: '6px',
            color: '#334155',
            fontSize: '13px',
            fontWeight: 500,
            cursor: loading || isSubmitting ? 'not-allowed' : 'pointer',
            opacity: loading || isSubmitting ? 0.7 : 1,
            boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
          }}
        >
          <span>🔄</span>
          <span>{loading ? 'Đang làm mới...' : 'Làm mới'}</span>
        </button>
      </div>

      {/* Notifications / Error Banner */}
      {error && (
        <div
          data-testid="controls-error-banner"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '12px 16px',
            backgroundColor: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: '8px',
            color: '#991b1b',
            fontSize: '14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '18px' }}>⚠️</span>
            <span>{error}</span>
          </div>
          <button
            type="button"
            data-testid="btn-dismiss-error"
            onClick={() => setError(null)}
            style={{
              background: 'none',
              border: 'none',
              color: '#991b1b',
              fontWeight: 700,
              cursor: 'pointer',
              fontSize: '16px',
              padding: '0 4px',
            }}
          >
            ✕
          </button>
        </div>
      )}

      {success && (
        <div
          data-testid="controls-success-banner"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '12px 16px',
            backgroundColor: '#ecfdf5',
            border: '1px solid #a7f3d0',
            borderRadius: '8px',
            color: '#065f46',
            fontSize: '14px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '18px' }}>✅</span>
            <span>{success}</span>
          </div>
          <button
            type="button"
            data-testid="btn-dismiss-success"
            onClick={() => setSuccess(null)}
            style={{
              background: 'none',
              border: 'none',
              color: '#065f46',
              fontWeight: 700,
              cursor: 'pointer',
              fontSize: '16px',
              padding: '0 4px',
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Section 1: Scheduler Controls (ORC-003) */}
      <section
        data-testid="section-scheduler-controls"
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #e2e8f0',
          borderRadius: '10px',
          padding: '24px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '20px',
            flexWrap: 'wrap',
            gap: '12px',
          }}
        >
          <div>
            <h3
              style={{
                margin: '0 0 4px 0',
                fontSize: '18px',
                fontWeight: 600,
                color: '#0f172a',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <span>⚙️</span> Điều Phối Tuần Tự (Task Scheduler)
            </h3>
            <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>
              Quy tắc độc quyền 1 agent coding tại một thời điểm (Agent Lock SQLite).
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '13px', color: '#64748b' }}>Trạng thái:</span>
            {schedulerStatus?.isPaused ? (
              <span
                data-testid="scheduler-status-badge"
                style={{
                  padding: '4px 12px',
                  borderRadius: '20px',
                  fontSize: '12px',
                  fontWeight: 600,
                  backgroundColor: '#fef3c7',
                  border: '1px solid #fde68a',
                  color: '#92400e',
                }}
              >
                ⏸️ TẠM DỪNG (PAUSED)
              </span>
            ) : schedulerStatus?.isRunning ? (
              <span
                data-testid="scheduler-status-badge"
                style={{
                  padding: '4px 12px',
                  borderRadius: '20px',
                  fontSize: '12px',
                  fontWeight: 600,
                  backgroundColor: '#ecfdf5',
                  border: '1px solid #a7f3d0',
                  color: '#065f46',
                }}
              >
                ▶️ ĐANG CHẠY (RUNNING)
              </span>
            ) : (
              <span
                data-testid="scheduler-status-badge"
                style={{
                  padding: '4px 12px',
                  borderRadius: '20px',
                  fontSize: '12px',
                  fontWeight: 600,
                  backgroundColor: '#f1f5f9',
                  border: '1px solid #cbd5e1',
                  color: '#475569',
                }}
              >
                ⏹️ SẴN SÀNG (IDLE)
              </span>
            )}
          </div>
        </div>

        {/* Status Metrics Cards */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '16px',
            marginBottom: '24px',
          }}
        >
          <div
            style={{
              padding: '14px',
              backgroundColor: '#f8fafc',
              borderRadius: '8px',
              border: '1px solid #e2e8f0',
            }}
          >
            <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>
              Tác vụ sẵn sàng (READY)
            </div>
            <div
              data-testid="scheduler-ready-count"
              style={{ fontSize: '20px', fontWeight: 700, color: '#0f172a' }}
            >
              {schedulerStatus?.readyTasksCount ?? 0}
            </div>
          </div>

          <div
            style={{
              padding: '14px',
              backgroundColor: '#f8fafc',
              borderRadius: '8px',
              border: '1px solid #e2e8f0',
            }}
          >
            <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>
              Tác vụ đang chạy (Task ID)
            </div>
            <div
              data-testid="scheduler-active-task"
              style={{
                fontSize: '15px',
                fontWeight: 600,
                color: schedulerStatus?.activeTaskId ? '#2563eb' : '#64748b',
                fontFamily: 'monospace',
              }}
            >
              {schedulerStatus?.activeTaskId ?? 'Không có'}
            </div>
          </div>

          <div
            style={{
              padding: '14px',
              backgroundColor: '#f8fafc',
              borderRadius: '8px',
              border: '1px solid #e2e8f0',
            }}
          >
            <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>
              Tiến trình thực thi (Run ID)
            </div>
            <div
              data-testid="scheduler-active-run"
              style={{
                fontSize: '14px',
                fontWeight: 600,
                color: schedulerStatus?.activeRunId ? '#059669' : '#64748b',
                fontFamily: 'monospace',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {schedulerStatus?.activeRunId ?? 'Không có'}
            </div>
          </div>

          <div
            style={{
              padding: '14px',
              backgroundColor: '#f8fafc',
              borderRadius: '8px',
              border: '1px solid #e2e8f0',
            }}
          >
            <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>
              Khóa Agent (Agent Lock)
            </div>
            <div
              data-testid="scheduler-lock-status"
              style={{
                fontSize: '13px',
                fontWeight: 600,
                color: schedulerStatus?.activeLock ? '#dc2626' : '#16a34a',
              }}
            >
              {schedulerStatus?.activeLock
                ? `🔒 Đang khóa (PID: ${schedulerStatus.activeLock.owner_pid ?? 'N/A'})`
                : '🔓 Khóa tự do (Sẵn sàng)'}
            </div>
          </div>
        </div>

        {/* Primary Controls Buttons */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '12px',
            alignItems: 'center',
          }}
        >
          {/* Pause Button */}
          <button
            type="button"
            data-testid="btn-pause-scheduler"
            disabled={isSubmitting || schedulerStatus?.isPaused}
            onClick={() => void handlePauseScheduler()}
            style={{
              padding: '10px 18px',
              backgroundColor: '#d97706',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: 600,
              cursor: isSubmitting || schedulerStatus?.isPaused ? 'not-allowed' : 'pointer',
              opacity: isSubmitting || schedulerStatus?.isPaused ? 0.6 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
            }}
          >
            <span>⏸️</span>
            <span>
              {submittingAction === 'pause-scheduler' ? 'Đang tạm dừng...' : 'Tạm Dừng (Pause)'}
            </span>
          </button>

          {/* Resume Button */}
          <button
            type="button"
            data-testid="btn-resume-scheduler"
            disabled={isSubmitting || !schedulerStatus?.isPaused}
            onClick={() => void handleResumeScheduler()}
            style={{
              padding: '10px 18px',
              backgroundColor: '#059669',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: 600,
              cursor: isSubmitting || !schedulerStatus?.isPaused ? 'not-allowed' : 'pointer',
              opacity: isSubmitting || !schedulerStatus?.isPaused ? 0.6 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
            }}
          >
            <span>▶️</span>
            <span>
              {submittingAction === 'resume-scheduler' ? 'Đang tiếp tục...' : 'Tiếp Tục (Resume)'}
            </span>
          </button>

          {/* Stop Button (Requires Confirmation) */}
          <button
            type="button"
            data-testid="btn-stop-scheduler"
            disabled={isSubmitting}
            onClick={() => openStopConfirmation('scheduler')}
            style={{
              padding: '10px 18px',
              backgroundColor: '#dc2626',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: 600,
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
              opacity: isSubmitting ? 0.6 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
            }}
          >
            <span>🛑</span>
            <span>Dừng Khẩn Cấp (Stop)</span>
          </button>

          {/* Start Loop Button */}
          <button
            type="button"
            data-testid="btn-start-scheduler"
            disabled={isSubmitting || schedulerStatus?.isRunning}
            onClick={() => void handleStartScheduler()}
            style={{
              padding: '10px 18px',
              backgroundColor: '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: 600,
              cursor: isSubmitting || schedulerStatus?.isRunning ? 'not-allowed' : 'pointer',
              opacity: isSubmitting || schedulerStatus?.isRunning ? 0.6 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span>⚡</span>
            <span>
              {submittingAction === 'start-scheduler'
                ? 'Đang khởi động...'
                : 'Bắt Đầu Vòng Lặp (Start)'}
            </span>
          </button>

          {/* Step Next Button */}
          <button
            type="button"
            data-testid="btn-step-scheduler"
            disabled={isSubmitting || schedulerStatus?.isPaused}
            onClick={() => void handleStepScheduler()}
            style={{
              padding: '10px 16px',
              backgroundColor: '#ffffff',
              color: '#334155',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: isSubmitting || schedulerStatus?.isPaused ? 'not-allowed' : 'pointer',
              opacity: isSubmitting || schedulerStatus?.isPaused ? 0.6 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span>⏭️</span>
            <span>
              {submittingAction === 'step-scheduler'
                ? 'Đang thực thi...'
                : 'Chạy 1 Bước (Step Next)'}
            </span>
          </button>

          {/* Release Lock Button */}
          <button
            type="button"
            data-testid="btn-release-lock"
            disabled={isSubmitting || !schedulerStatus?.activeLock}
            onClick={() => void handleReleaseLock()}
            style={{
              padding: '10px 16px',
              backgroundColor: '#ffffff',
              color: schedulerStatus?.activeLock ? '#dc2626' : '#94a3b8',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: isSubmitting || !schedulerStatus?.activeLock ? 'not-allowed' : 'pointer',
              opacity: isSubmitting || !schedulerStatus?.activeLock ? 0.6 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <span>🔓</span>
            <span>
              {submittingAction === 'release-lock' ? 'Đang giải phóng...' : 'Giải Phóng Khóa'}
            </span>
          </button>
        </div>

        {/* Quick Stop Run Panel */}
        <div
          style={{
            marginTop: '20px',
            paddingTop: '16px',
            borderTop: '1px dashed #e2e8f0',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>
            Dừng tiến trình Run riêng biệt:
          </span>
          <input
            type="text"
            data-testid="input-target-run-id"
            value={customRunId}
            placeholder="Nhập Run ID cần dừng..."
            onChange={(e) => setCustomRunId(e.target.value)}
            style={{
              padding: '8px 12px',
              fontSize: '13px',
              border: '1px solid #cbd5e1',
              borderRadius: '6px',
              width: '260px',
              fontFamily: 'monospace',
            }}
          />
          <button
            type="button"
            data-testid="btn-stop-run"
            disabled={isSubmitting || !customRunId.trim()}
            onClick={() => openStopConfirmation('run')}
            style={{
              padding: '8px 14px',
              backgroundColor: '#ef4444',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: isSubmitting || !customRunId.trim() ? 'not-allowed' : 'pointer',
              opacity: isSubmitting || !customRunId.trim() ? 0.6 : 1,
            }}
          >
            🛑 Dừng Run
          </button>
        </div>
      </section>

      {/* Section 2: Plan Review & Approval (ORC-007) */}
      <section
        data-testid="section-plan-approval"
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #e2e8f0',
          borderRadius: '10px',
          padding: '24px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '16px',
            flexWrap: 'wrap',
            gap: '12px',
          }}
        >
          <div>
            <h3
              style={{
                margin: '0 0 4px 0',
                fontSize: '18px',
                fontWeight: 600,
                color: '#0f172a',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}
            >
              <span>📋</span> Thẩm Định & Phê Duyệt Kế Hoạch (Plan Review & Approve)
            </h3>
            <p style={{ margin: 0, fontSize: '13px', color: '#64748b' }}>
              Quản trị chế độ review theo ORC-007: Thẩm định kế hoạch và phê duyệt trước khi cho
              phép thực thi.
            </p>
          </div>

          {/* Status Filter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '13px', color: '#64748b' }}>Lọc trạng thái:</span>
            <select
              data-testid="filter-plan-status"
              value={planStatusFilter}
              onChange={(e) => setPlanStatusFilter(e.target.value)}
              style={{
                padding: '6px 12px',
                fontSize: '13px',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
                backgroundColor: '#ffffff',
                color: '#334155',
              }}
            >
              <option value="ALL">Tất cả ({plans.length})</option>
              {PLAN_STATUSES.map((st) => (
                <option key={st} value={st}>
                  {st} ({plans.filter((p) => p.status === st).length})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Strict Quality Enforcement Banner */}
        <div
          data-testid="banner-approval-rule"
          style={{
            backgroundColor: '#eff6ff',
            border: '1px solid #bfdbfe',
            borderRadius: '8px',
            padding: '12px 16px',
            marginBottom: '20px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
          }}
        >
          <span style={{ fontSize: '18px', lineHeight: 1 }}>🛡️</span>
          <div style={{ fontSize: '13px', color: '#1e40af', lineHeight: 1.5 }}>
            <strong style={{ fontWeight: 600 }}>
              Tiêu chuẩn cốt lõi ORC-007: Chưa duyệt → không thực thi!
            </strong>
            <div>
              Mọi kế hoạch tự động sinh (Planner) đều phải trải qua thẩm định DAG, phạm vi file và
              được phê duyệt (`APPROVED`) trước khi Orchestrator chuyển sang thực thi.
            </div>
          </div>
        </div>

        {/* Plans Selector & Cards */}
        {filteredPlans.length === 0 ? (
          <div
            data-testid="plans-empty-state"
            style={{
              padding: '36px 16px',
              textAlign: 'center',
              backgroundColor: '#f8fafc',
              borderRadius: '8px',
              border: '1px dashed #cbd5e1',
              color: '#64748b',
              fontSize: '14px',
            }}
          >
            Không có kế hoạch nào khớp với bộ lọc `{planStatusFilter}`.
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: '12px',
              marginBottom: '24px',
            }}
          >
            {filteredPlans.map((p) => {
              const isSelected = p.id === selectedPlanId;
              const badge = getPlanStatusBadge(p.status);
              return (
                <div
                  key={p.id}
                  data-testid={`plan-item-${p.id}`}
                  onClick={() => setSelectedPlanId(p.id)}
                  style={{
                    padding: '14px',
                    borderRadius: '8px',
                    border: isSelected ? '2px solid #2563eb' : '1px solid #e2e8f0',
                    backgroundColor: isSelected ? '#eff6ff' : '#ffffff',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease-in-out',
                    boxShadow: isSelected ? '0 2px 4px rgba(37,99,235,0.1)' : 'none',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'flex-start',
                      marginBottom: '8px',
                    }}
                  >
                    <div
                      style={{
                        fontFamily: 'monospace',
                        fontWeight: 700,
                        fontSize: '13px',
                        color: isSelected ? '#1d4ed8' : '#334155',
                      }}
                    >
                      {p.id}
                    </div>
                    <span
                      data-testid={`plan-status-${p.id}`}
                      style={{
                        fontSize: '11px',
                        padding: '2px 8px',
                        borderRadius: '12px',
                        backgroundColor: badge.bg,
                        border: `1px solid ${badge.border}`,
                        color: badge.color,
                        fontWeight: 600,
                      }}
                    >
                      {p.status}
                    </span>
                  </div>

                  <div
                    style={{
                      fontSize: '14px',
                      fontWeight: 600,
                      color: '#0f172a',
                      marginBottom: '6px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {p.title}
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: '12px',
                      color: '#64748b',
                    }}
                  >
                    <span>{p.tasks.length} tác vụ</span>
                    <span>{p.feature_id ? `Tính năng: ${p.feature_id}` : p.repository}</span>
                  </div>

                  <button
                    type="button"
                    data-testid={`btn-select-plan-${p.id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedPlanId(p.id);
                    }}
                    style={{
                      marginTop: '10px',
                      width: '100%',
                      padding: '6px 12px',
                      backgroundColor: isSelected ? '#2563eb' : '#f1f5f9',
                      color: isSelected ? '#ffffff' : '#334155',
                      border: 'none',
                      borderRadius: '4px',
                      fontSize: '12px',
                      fontWeight: 500,
                      cursor: 'pointer',
                    }}
                  >
                    {isSelected ? '✓ Đang chọn' : 'Xem & Thẩm định'}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Selected Plan Details & Inspector */}
        {selectedPlan && (
          <div
            data-testid="selected-plan-details"
            style={{
              padding: '20px',
              backgroundColor: '#f8fafc',
              borderRadius: '8px',
              border: '1px solid #cbd5e1',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                marginBottom: '16px',
                flexWrap: 'wrap',
                gap: '12px',
              }}
            >
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <h4
                    style={{
                      margin: 0,
                      fontSize: '18px',
                      fontWeight: 700,
                      color: '#0f172a',
                    }}
                  >
                    {selectedPlan.title}
                  </h4>
                  <span
                    data-testid="selected-plan-status"
                    style={{
                      fontSize: '12px',
                      padding: '3px 10px',
                      borderRadius: '12px',
                      backgroundColor: getPlanStatusBadge(selectedPlan.status).bg,
                      border: `1px solid ${getPlanStatusBadge(selectedPlan.status).border}`,
                      color: getPlanStatusBadge(selectedPlan.status).color,
                      fontWeight: 600,
                    }}
                  >
                    {getPlanStatusBadge(selectedPlan.status).label}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: '13px',
                    color: '#64748b',
                    marginTop: '4px',
                    fontFamily: 'monospace',
                  }}
                >
                  ID: {selectedPlan.id} | Repo: {selectedPlan.repository} | Feature:{' '}
                  {selectedPlan.feature_id ?? 'N/A'}
                </div>
                {selectedPlan.description && (
                  <p style={{ margin: '8px 0 0 0', fontSize: '13px', color: '#475569' }}>
                    {selectedPlan.description}
                  </p>
                )}
              </div>

              {/* Review summary status indicators */}
              {planReview && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-end' }}>
                  <div
                    data-testid="plan-approval-status"
                    style={{
                      fontSize: '12px',
                      fontWeight: 600,
                      color: planReview.is_approved ? '#059669' : '#d97706',
                    }}
                  >
                    {planReview.is_approved
                      ? '✅ ĐÃ PHÊ DUYỆT BỞI REVIEWER'
                      : planReview.status === 'REJECTED'
                        ? '❌ ĐÃ BỊ TỪ CHỐI'
                        : '⏳ ĐANG CHỜ PHÊ DUYỆT'}
                  </div>
                  <div
                    data-testid="plan-can-execute"
                    style={{
                      fontSize: '12px',
                      fontWeight: 600,
                      color: planReview.can_execute ? '#059669' : '#dc2626',
                    }}
                  >
                    {planReview.can_execute
                      ? '🚀 ĐỦ ĐIỀU KIỆN THỰC THI'
                      : '⛔ CHƯA ĐỦ ĐIỀU KIỆN THỰC THI (CHƯA DUYỆT)'}
                  </div>
                </div>
              )}
            </div>

            {/* Review Summary Metrics */}
            {planReview && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: '12px',
                  marginBottom: '20px',
                }}
              >
                <div
                  style={{
                    padding: '10px 14px',
                    backgroundColor: '#ffffff',
                    borderRadius: '6px',
                    border: '1px solid #e2e8f0',
                  }}
                >
                  <div style={{ fontSize: '11px', color: '#64748b' }}>Tổng số tác vụ</div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>
                    {planReview.total_tasks}
                  </div>
                </div>

                <div
                  style={{
                    padding: '10px 14px',
                    backgroundColor: '#ffffff',
                    borderRadius: '6px',
                    border: '1px solid #e2e8f0',
                  }}
                >
                  <div style={{ fontSize: '11px', color: '#64748b' }}>Thời gian ước tính</div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a' }}>
                    ~{planReview.total_estimated_minutes} phút
                  </div>
                </div>

                <div
                  style={{
                    padding: '10px 14px',
                    backgroundColor: '#ffffff',
                    borderRadius: '6px',
                    border: '1px solid #e2e8f0',
                  }}
                >
                  <div style={{ fontSize: '11px', color: '#64748b' }}>File phạm vi duy nhất</div>
                  <div
                    data-testid="plan-scope-files"
                    style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a' }}
                  >
                    {planReview.unique_scope_files.length} files
                  </div>
                </div>

                <div
                  style={{
                    padding: '10px 14px',
                    backgroundColor: '#ffffff',
                    borderRadius: '6px',
                    border: '1px solid #e2e8f0',
                  }}
                >
                  <div style={{ fontSize: '11px', color: '#64748b' }}>Tầng thực thi (DAG Stages)</div>
                  <div
                    data-testid="plan-dag-stages"
                    style={{ fontSize: '16px', fontWeight: 700, color: '#0f172a' }}
                  >
                    {planReview.stages.length} tầng
                  </div>
                </div>
              </div>
            )}

            {/* Warnings list if any */}
            {planReview?.warnings && planReview.warnings.length > 0 && (
              <div
                data-testid="plan-warnings"
                style={{
                  marginBottom: '16px',
                  padding: '10px 14px',
                  backgroundColor: '#fffbeb',
                  border: '1px solid #fef3c7',
                  borderRadius: '6px',
                  color: '#92400e',
                  fontSize: '12px',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                  ⚠️ Cảnh báo cấu trúc kế hoạch:
                </div>
                <ul style={{ margin: 0, paddingLeft: '18px' }}>
                  {planReview.warnings.map((w, idx) => (
                    <li key={idx}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Tasks list preview */}
            <div style={{ marginBottom: '20px' }}>
              <div
                style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  color: '#334155',
                  marginBottom: '8px',
                }}
              >
                Danh sách tác vụ trong kế hoạch:
              </div>
              <div
                style={{
                  maxHeight: '180px',
                  overflowY: 'auto',
                  border: '1px solid #e2e8f0',
                  borderRadius: '6px',
                  backgroundColor: '#ffffff',
                }}
              >
                <table
                  data-testid="plan-tasks-table"
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: '12px',
                  }}
                >
                  <thead>
                    <tr style={{ backgroundColor: '#f1f5f9', borderBottom: '1px solid #e2e8f0' }}>
                      <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600 }}>ID</th>
                      <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600 }}>Tiêu đề</th>
                      <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600 }}>Scope Files</th>
                      <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600 }}>Phụ thuộc</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedPlan.tasks.map((task) => (
                      <tr key={task.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '6px 10px', fontFamily: 'monospace', fontWeight: 600 }}>
                          {task.id}
                        </td>
                        <td style={{ padding: '6px 10px' }}>{task.title}</td>
                        <td style={{ padding: '6px 10px', color: '#64748b' }}>
                          {task.scope_files?.join(', ') || 'N/A'}
                        </td>
                        <td style={{ padding: '6px 10px', color: '#64748b' }}>
                          {task.dependencies?.join(', ') || 'Không'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Review Action Form */}
            <div
              style={{
                backgroundColor: '#ffffff',
                padding: '16px',
                borderRadius: '6px',
                border: '1px solid #e2e8f0',
              }}
            >
              <div
                style={{
                  fontSize: '14px',
                  fontWeight: 600,
                  color: '#0f172a',
                  marginBottom: '12px',
                }}
              >
                Thao Tác Thẩm Định (Review Actions):
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                  gap: '12px',
                  marginBottom: '14px',
                }}
              >
                <div>
                  <label
                    htmlFor="input-reviewer-name"
                    style={{ display: 'block', fontSize: '12px', color: '#64748b', marginBottom: '4px' }}
                  >
                    Người thẩm định (Reviewer):
                  </label>
                  <input
                    id="input-reviewer-name"
                    type="text"
                    data-testid="input-reviewer-name"
                    value={reviewerName}
                    onChange={(e) => setReviewerName(e.target.value)}
                    placeholder="Tên reviewer..."
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      fontSize: '13px',
                      border: '1px solid #cbd5e1',
                      borderRadius: '6px',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>

                <div>
                  <label
                    htmlFor="input-approve-comments"
                    style={{ display: 'block', fontSize: '12px', color: '#64748b', marginBottom: '4px' }}
                  >
                    Ghi chú phê duyệt (Tùy chọn):
                  </label>
                  <input
                    id="input-approve-comments"
                    type="text"
                    data-testid="input-approve-comments"
                    value={approveComments}
                    onChange={(e) => setApproveComments(e.target.value)}
                    placeholder="Ghi chú nhận xét khi duyệt..."
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      fontSize: '13px',
                      border: '1px solid #cbd5e1',
                      borderRadius: '6px',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              </div>

              <div style={{ marginBottom: '16px' }}>
                <label
                  htmlFor="input-reject-reason"
                  style={{ display: 'block', fontSize: '12px', color: '#64748b', marginBottom: '4px' }}
                >
                  Lý do từ chối (Bắt buộc nếu bấm Từ chối):
                </label>
                <input
                  id="input-reject-reason"
                  type="text"
                  data-testid="input-reject-reason"
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Nhập lý do cụ thể nếu từ chối kế hoạch..."
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: '13px',
                    border: '1px solid #cbd5e1',
                    borderRadius: '6px',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              {/* Action Buttons */}
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '12px',
                  alignItems: 'center',
                }}
              >
                {/* Approve Button */}
                <button
                  type="button"
                  data-testid="btn-approve-plan"
                  disabled={
                    isSubmitting ||
                    selectedPlan.status === 'APPROVED' ||
                    selectedPlan.status === 'EXECUTING' ||
                    selectedPlan.status === 'COMPLETED'
                  }
                  onClick={() => void handleApprovePlan()}
                  style={{
                    padding: '10px 18px',
                    backgroundColor: '#059669',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '14px',
                    fontWeight: 600,
                    cursor:
                      isSubmitting || selectedPlan.status === 'APPROVED'
                        ? 'not-allowed'
                        : 'pointer',
                    opacity:
                      isSubmitting || selectedPlan.status === 'APPROVED' ? 0.6 : 1,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <span>✅</span>
                  <span>
                    {submittingAction === 'approve-plan'
                      ? 'Đang phê duyệt...'
                      : selectedPlan.status === 'APPROVED'
                        ? 'Đã Phê Duyệt'
                        : 'Phê Duyệt (Approve)'}
                  </span>
                </button>

                {/* Reject Button */}
                <button
                  type="button"
                  data-testid="btn-reject-plan"
                  disabled={isSubmitting || selectedPlan.status === 'REJECTED'}
                  onClick={() => void handleRejectPlan()}
                  style={{
                    padding: '10px 18px',
                    backgroundColor: '#dc2626',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '14px',
                    fontWeight: 600,
                    cursor:
                      isSubmitting || selectedPlan.status === 'REJECTED'
                        ? 'not-allowed'
                        : 'pointer',
                    opacity:
                      isSubmitting || selectedPlan.status === 'REJECTED' ? 0.6 : 1,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <span>❌</span>
                  <span>
                    {submittingAction === 'reject-plan'
                      ? 'Đang từ chối...'
                      : 'Từ Chối (Reject)'}
                  </span>
                </button>

                {/* Submit for Review Button */}
                <button
                  type="button"
                  data-testid="btn-submit-plan"
                  disabled={
                    isSubmitting || selectedPlan.status === 'PENDING_APPROVAL'
                  }
                  onClick={() => void handleSubmitPlanForReview()}
                  style={{
                    padding: '10px 16px',
                    backgroundColor: '#ffffff',
                    color: '#334155',
                    border: '1px solid #cbd5e1',
                    borderRadius: '6px',
                    fontSize: '13px',
                    fontWeight: 600,
                    cursor:
                      isSubmitting || selectedPlan.status === 'PENDING_APPROVAL'
                        ? 'not-allowed'
                        : 'pointer',
                    opacity:
                      isSubmitting || selectedPlan.status === 'PENDING_APPROVAL' ? 0.6 : 1,
                  }}
                >
                  <span>📤</span>
                  <span>
                    {submittingAction === 'submit-plan'
                      ? 'Đang gửi...'
                      : 'Gửi Lại Thẩm Định (Submit)'}
                  </span>
                </button>

                {/* Execute Plan Button (Strict enforcement: only when APPROVED) */}
                <button
                  type="button"
                  data-testid="btn-execute-plan"
                  disabled={
                    isSubmitting ||
                    selectedPlan.status !== 'APPROVED'
                  }
                  onClick={() => void handleExecutePlan()}
                  title={
                    selectedPlan.status !== 'APPROVED'
                      ? 'Chưa duyệt → không thực thi! Vui lòng phê duyệt trước.'
                      : 'Khởi chạy thực thi kế hoạch'
                  }
                  style={{
                    marginLeft: 'auto',
                    padding: '10px 20px',
                    backgroundColor:
                      selectedPlan.status === 'APPROVED' ? '#2563eb' : '#94a3b8',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '6px',
                    fontSize: '14px',
                    fontWeight: 700,
                    cursor:
                      isSubmitting || selectedPlan.status !== 'APPROVED'
                        ? 'not-allowed'
                        : 'pointer',
                    opacity:
                      isSubmitting || selectedPlan.status !== 'APPROVED' ? 0.6 : 1,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <span>🚀</span>
                  <span>
                    {submittingAction === 'execute-plan'
                      ? 'Đang khởi chạy...'
                      : 'Thực Thi Kế Hoạch (Execute)'}
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Stop Confirmation Modal Dialog */}
      {showStopModal && (
        <div
          data-testid="modal-confirm-stop"
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.65)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '16px',
          }}
        >
          <div
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '12px',
              maxWidth: '500px',
              width: '100%',
              padding: '24px',
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                marginBottom: '16px',
              }}
            >
              <div
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '50%',
                  backgroundColor: '#fee2e2',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '20px',
                }}
              >
                🛑
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: '#991b1b' }}>
                  Xác Nhận Dừng Khẩn Cấp ({stopTarget === 'scheduler' ? 'Scheduler' : 'Run'})
                </h3>
                <p style={{ margin: '2px 0 0 0', fontSize: '13px', color: '#64748b' }}>
                  Hành động này sẽ dừng tiến trình và giải phóng khóa hệ thống.
                </p>
              </div>
            </div>

            <div
              style={{
                backgroundColor: '#fff1f2',
                border: '1px solid #fecdd3',
                borderRadius: '8px',
                padding: '12px 14px',
                marginBottom: '16px',
                fontSize: '13px',
                color: '#9f1239',
                lineHeight: 1.5,
              }}
            >
              <strong>Cảnh báo an toàn:</strong> Khi dừng khẩn cấp, tiến trình công việc đang chạy sẽ
              bị gửi tín hiệu hủy (SIGTERM/SIGKILL). Trạng thái tiến trình sẽ được cập nhật thành
              `CANCELLED` hoặc `STOPPED` trong SQLite.
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label
                htmlFor="input-stop-reason"
                style={{ display: 'block', fontSize: '13px', fontWeight: 500, color: '#334155', marginBottom: '6px' }}
              >
                Lý do dừng:
              </label>
              <input
                id="input-stop-reason"
                type="text"
                data-testid="input-stop-reason"
                value={stopReason}
                onChange={(e) => setStopReason(e.target.value)}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  fontSize: '13px',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  boxSizing: 'border-box',
                }}
              />
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginBottom: '24px',
              }}
            >
              <input
                type="checkbox"
                id="checkbox-stop-force"
                data-testid="checkbox-stop-force"
                checked={stopForce}
                onChange={(e) => setStopForce(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <label
                htmlFor="checkbox-stop-force"
                style={{ fontSize: '13px', color: '#475569', cursor: 'pointer' }}
              >
                Cưỡng bức dừng ngay lập tức (Force kill với SIGKILL)
              </label>
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '12px',
              }}
            >
              <button
                type="button"
                data-testid="btn-cancel-stop"
                onClick={() => setShowStopModal(false)}
                style={{
                  padding: '9px 16px',
                  backgroundColor: '#ffffff',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  fontSize: '13px',
                  fontWeight: 600,
                  color: '#475569',
                  cursor: 'pointer',
                }}
              >
                Hủy bỏ (Bỏ qua)
              </button>

              <button
                type="button"
                data-testid="btn-confirm-stop"
                onClick={() => void handleConfirmStop()}
                style={{
                  padding: '9px 18px',
                  backgroundColor: '#dc2626',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '13px',
                  fontWeight: 600,
                  color: '#ffffff',
                  cursor: 'pointer',
                  boxShadow: '0 1px 2px rgba(220,38,38,0.2)',
                }}
              >
                Xác Nhận Dừng (Stop)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
