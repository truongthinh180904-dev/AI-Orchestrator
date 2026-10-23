import type { ReactNode } from 'react';
import { DashboardLayout } from '../components/DashboardLayout.js';

export const metadata = {
  title: 'AI Orchestrator Dashboard',
  description: 'Control and monitor autonomous AI coding worker pipelines',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body style={{ margin: 0, padding: 0, background: '#f8fafc', color: '#0f172a' }}>
        <DashboardLayout>{children}</DashboardLayout>
      </body>
    </html>
  );
}
