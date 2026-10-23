import React from 'react';

export const Footer: React.FC = () => {
  return (
    <footer
      data-testid="dashboard-footer"
      style={{
        backgroundColor: '#f8fafc',
        borderTop: '1px solid #e2e8f0',
        padding: '24px',
        marginTop: 'auto',
        fontSize: '13px',
        color: '#64748b',
      }}
    >
      <div
        style={{
          maxWidth: '1200px',
          margin: '0 auto',
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '16px',
        }}
      >
        <div>
          <div style={{ fontWeight: 600, color: '#334155', marginBottom: '4px' }}>
            AI Orchestrator • Autonomous Coding Pipeline
          </div>
          <div style={{ fontSize: '12px' }}>
            Monorepo: <code>apps/orchestrator</code> (API: 3000) • <code>apps/dashboard</code> (UI:
            3001) • <code>packages/shared</code> • <code>packages/db</code>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', fontSize: '12px' }}>
          <span
            data-testid="footer-mode-badge"
            style={{
              padding: '2px 8px',
              borderRadius: '4px',
              backgroundColor: '#e2e8f0',
              color: '#334155',
              fontWeight: 500,
            }}
          >
            Chế độ: Headless Autonomous
          </span>
          <span>Quality Gate: Bằng chứng thật</span>
        </div>
      </div>
    </footer>
  );
};
