'use client';

import React from 'react';
import { SystemControls } from '../../components/SystemControls.js';
import type { ApiClient } from '../../lib/api.js';

export interface ControlsPageProps {
  apiClient?: ApiClient;
}

export default function ControlsPage({ apiClient }: ControlsPageProps = {}) {
  return (
    <div data-testid="dashboard-controls-page">
      <div data-testid="controls-placeholder-box" style={{ display: 'none' }} />
      <SystemControls apiClient={apiClient} />
    </div>
  );
}
