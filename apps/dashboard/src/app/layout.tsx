import type { ReactNode } from 'react';

export const metadata = {
  title: 'AI Orchestrator Dashboard',
  description: 'Control and monitor autonomous AI coding worker pipelines',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi">
      <body style={{ margin: 0, padding: 0, background: '#f8fafc', color: '#0f172a' }}>
        {children}
      </body>
    </html>
  );
}
