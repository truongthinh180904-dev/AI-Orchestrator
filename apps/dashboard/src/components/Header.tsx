'use client';

import React from 'react';
import { ApiClient } from '../lib/api.js';
import { ConnectionStatus } from './ConnectionStatus.js';

export interface HeaderProps {
  apiClient?: ApiClient;
  title?: string;
  subtitle?: string;
}

export const Header: React.FC<HeaderProps> = ({
  apiClient,
  title = 'AI Orchestrator',
  subtitle = 'Autonomous Coding Worker Dashboard',
}) => {
  return (
    <header
      data-testid="dashboard-header"
      style={{
        backgroundColor: '#0f172a',
        color: '#ffffff',
        borderBottom: '1px solid #1e293b',
        padding: '14px 24px',
      }}
    >
      <div
        style={{
          maxWidth: '1200px',
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '8px',
              background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: '18px',
              color: '#ffffff',
              boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)',
            }}
          >
            AI
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h1
                data-testid="header-title"
                style={{
                  margin: 0,
                  fontSize: '18px',
                  fontWeight: 700,
                  letterSpacing: '-0.02em',
                }}
              >
                {title}
              </h1>
              <span
                data-testid="header-version-badge"
                style={{
                  fontSize: '11px',
                  padding: '1px 6px',
                  backgroundColor: '#334155',
                  color: '#94a3b8',
                  borderRadius: '4px',
                  fontWeight: 500,
                }}
              >
                v0.1.0
              </span>
            </div>
            <p
              data-testid="header-subtitle"
              style={{
                margin: '2px 0 0 0',
                fontSize: '12px',
                color: '#94a3b8',
              }}
            >
              {subtitle}
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <ConnectionStatus apiClient={apiClient} />
        </div>
      </div>
    </header>
  );
};
