'use client';

import React from 'react';
import { TaskFeatureDashboard } from '../../components/TaskFeatureDashboard.js';
import type { ApiClient } from '../../lib/api.js';

export interface TasksPageProps {
  apiClient?: ApiClient;
}

export default function TasksPage({ apiClient }: TasksPageProps = {}) {
  return (
    <div data-testid="dashboard-tasks-page">
      <TaskFeatureDashboard apiClient={apiClient} />
    </div>
  );
}
