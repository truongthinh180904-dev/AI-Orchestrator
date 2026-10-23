'use client';

import React, { use } from 'react';
import { TestReportReviewFindings } from '../../../../components/TestReportReviewFindings.js';
import type { ApiClient } from '../../../../lib/api.js';

export interface TaskQualityPageProps {
  params: Promise<{ id: string }> | { id: string };
  apiClient?: ApiClient;
}

export default function TaskQualityPage({ params, apiClient }: TaskQualityPageProps) {
  const resolvedParams =
    params && typeof (params as Promise<{ id: string }>).then === 'function'
      ? use(params as Promise<{ id: string }>)
      : (params as { id: string });

  const taskId = decodeURIComponent(resolvedParams.id);

  return (
    <div data-testid="dashboard-task-quality-page" style={{ padding: '8px 0' }}>
      <div style={{ marginBottom: '16px' }}>
        <a
          href={`/tasks/${encodeURIComponent(taskId)}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '13px',
            color: '#2563eb',
            textDecoration: 'none',
            fontWeight: 500,
          }}
        >
          ← Quay lại chi tiết tác vụ {taskId}
        </a>
      </div>

      <TestReportReviewFindings taskId={taskId} apiClient={apiClient} />
    </div>
  );
}
