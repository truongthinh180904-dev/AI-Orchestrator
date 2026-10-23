'use client';

import React from 'react';
import { ReleaseDashboard } from '../../components/ReleaseDashboard.js';
import type { ApiClient } from '../../lib/api.js';
import type { FeatureRelease, Feature } from '@ai-orchestrator/shared';

export interface ReleasesPageProps {
  apiClient?: ApiClient;
  initialReleases?: FeatureRelease[];
  initialFeatures?: Feature[];
}

export default function ReleasesPage({
  apiClient,
  initialReleases,
  initialFeatures,
}: ReleasesPageProps = {}) {
  return (
    <div data-testid="dashboard-releases-page">
      <div data-testid="releases-placeholder-box" style={{ display: 'none' }} />
      <ReleaseDashboard
        apiClient={apiClient}
        initialReleases={initialReleases}
        initialFeatures={initialFeatures}
      />
    </div>
  );
}
