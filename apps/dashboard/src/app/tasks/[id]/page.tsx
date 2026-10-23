'use client';

import React, { use } from 'react';
import { TaskDetail } from '../../../components/TaskDetail.js';
import type { ApiClient } from '../../../lib/api.js';

export interface TaskDetailPageProps {
  params: Promise<{ id: string }> | { id: string };
  apiClient?: ApiClient;
}

export default function TaskDetailPage({ params, apiClient }: TaskDetailPageProps) {
  const resolvedParams =
    params && typeof (params as Promise<{ id: string }>).then === 'function'
      ? use(params as Promise<{ id: string }>)
      : (params as { id: string });

  const taskId = decodeURIComponent(resolvedParams.id);

  return (
    <div data-testid="dashboard-task-detail-page">
      <TaskDetail taskId={taskId} apiClient={apiClient} />
    </div>
  );
}
