'use client';

import React from 'react';
import { ApiClient } from '../lib/api.js';
import { Header } from './Header.js';
import { Navigation } from './Navigation.js';
import { Footer } from './Footer.js';
import { NotificationToastContainer } from './NotificationCenter.js';

export interface DashboardLayoutProps {
  children: React.ReactNode;
  currentPath?: string;
  apiClient?: ApiClient;
  title?: string;
  subtitle?: string;
  onNavigate?: (href: string) => void;
}

export const DashboardLayout: React.FC<DashboardLayoutProps> = ({
  children,
  currentPath,
  apiClient,
  title,
  subtitle,
  onNavigate,
}) => {
  return (
    <div
      data-testid="dashboard-layout-root"
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        backgroundColor: '#f8fafc',
        color: '#0f172a',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <Header apiClient={apiClient} title={title} subtitle={subtitle} />
      <Navigation currentPath={currentPath} onNavigate={onNavigate} />

      <main
        data-testid="dashboard-main"
        role="main"
        style={{
          flex: 1,
          maxWidth: '1200px',
          width: '100%',
          margin: '0 auto',
          padding: '24px 16px',
          boxSizing: 'border-box',
        }}
      >
        {children}
      </main>

      <Footer />
      <NotificationToastContainer />
    </div>
  );
};
