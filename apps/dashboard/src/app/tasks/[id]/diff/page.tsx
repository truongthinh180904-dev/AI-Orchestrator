'use client';

import React, { use } from 'react';
import { DiffViewer } from '../../../../components/DiffViewer.js';
import type { ApiClient } from '../../../../lib/api.js';

export interface TaskDiffPageProps {
  params: Promise<{ id: string }> | { id: string };
  apiClient?: ApiClient;
}

export default function TaskDiffPage({ params, apiClient }: TaskDiffPageProps) {
  const resolvedParams =
    params && typeof (params as Promise<{ id: string }>).then === 'function'
      ? use(params as Promise<{ id: string }>)
      : (params as { id: string });

  const taskId = decodeURIComponent(resolvedParams.id);

  return (
    <div data-testid="dashboard-task-diff-page" style={{ padding: '8px 0' }}>
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

      <DiffViewer taskId={taskId} apiClient={apiClient} />
    </div>
  );
}
