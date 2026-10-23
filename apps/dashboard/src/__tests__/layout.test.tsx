/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ConnectionStatus } from '../components/ConnectionStatus.js';
import { Header } from '../components/Header.js';
import { Navigation, NAV_ITEMS } from '../components/Navigation.js';
import { Footer } from '../components/Footer.js';
import { DashboardLayout } from '../components/DashboardLayout.js';
import HomePage from '../app/page.js';
import TasksPage from '../app/tasks/page.js';
import ControlsPage from '../app/controls/page.js';
import ReleasesPage from '../app/releases/page.js';
import ImportPage from '../app/import/page.js';
import { ApiClient } from '../lib/api.js';

describe('Layout & Navigation Components (UI-001)', () => {
  afterEach(() => {
    cleanup();
  });

  describe('ConnectionStatus', () => {
    it('displays checking status initially then switches to connected on health check success', async () => {
      const mockHealth = vi
        .fn()
        .mockResolvedValue({ status: 'ok', timestamp: new Date().toISOString() });
      const mockApi = {
        checkHealth: mockHealth,
        getBaseUrl: () => 'http://127.0.0.1:3000',
      } as unknown as ApiClient;

      render(<ConnectionStatus apiClient={mockApi} />);

      const badge = screen.getByTestId('connection-status-badge');
      const url = screen.getByTestId('connection-backend-url');
      expect(url.textContent).toBe('http://127.0.0.1:3000');

      await waitFor(() => {
        expect(badge.textContent).toContain('API Trực tuyến');
      });
      expect(mockHealth).toHaveBeenCalledTimes(1);
    });

    it('displays disconnected status when health check fails', async () => {
      const mockHealth = vi.fn().mockRejectedValue(new Error('Connection refused'));
      const mockApi = {
        checkHealth: mockHealth,
        getBaseUrl: () => 'http://127.0.0.1:3000',
      } as unknown as ApiClient;

      render(<ConnectionStatus apiClient={mockApi} />);

      await waitFor(() => {
        const badge = screen.getByTestId('connection-status-badge');
        expect(badge.textContent).toContain('Mất kết nối API');
      });
    });

    it('refreshes health check when refresh button is clicked', async () => {
      const mockHealth = vi.fn().mockResolvedValue({ status: 'ok' });
      const mockApi = {
        checkHealth: mockHealth,
        getBaseUrl: () => 'http://127.0.0.1:3000',
      } as unknown as ApiClient;

      render(<ConnectionStatus apiClient={mockApi} />);

      await waitFor(() => {
        expect(mockHealth).toHaveBeenCalledTimes(1);
      });

      const refreshBtn = screen.getByTestId('connection-refresh-btn');
      fireEvent.click(refreshBtn);

      await waitFor(() => {
        expect(mockHealth).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('Header', () => {
    it('renders title, version badge, subtitle, and connection status', async () => {
      const mockApi = {
        checkHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
        getBaseUrl: () => 'http://127.0.0.1:3000',
      } as unknown as ApiClient;

      render(
        <Header apiClient={mockApi} title="AI Orchestrator" subtitle="Worker Control Panel" />,
      );

      expect(screen.getByTestId('header-title').textContent).toBe('AI Orchestrator');
      expect(screen.getByTestId('header-subtitle').textContent).toBe('Worker Control Panel');
      expect(screen.getByTestId('header-version-badge').textContent).toBe('v0.1.0');
      expect(screen.getByTestId('dashboard-header')).toBeDefined();

      await waitFor(() => {
        expect(screen.getByTestId('connection-status-badge').textContent).toContain(
          'API Trực tuyến',
        );
      });
    });
  });

  describe('Navigation', () => {
    it('renders all 4 main navigation links with correct hrefs', () => {
      render(<Navigation currentPath="/tasks" />);

      const tasksLink = screen.getByTestId('nav-link-tasks');
      const importLink = screen.getByTestId('nav-link-import');
      const controlsLink = screen.getByTestId('nav-link-controls');
      const releasesLink = screen.getByTestId('nav-link-releases');

      expect(tasksLink.getAttribute('href')).toBe('/tasks');
      expect(importLink.getAttribute('href')).toBe('/import');
      expect(controlsLink.getAttribute('href')).toBe('/controls');
      expect(releasesLink.getAttribute('href')).toBe('/releases');
      expect(NAV_ITEMS.length).toBe(4);
    });

    it('highlights active route correctly', () => {
      const { rerender } = render(<Navigation currentPath="/tasks" />);
      expect(screen.getByTestId('nav-link-tasks').getAttribute('aria-current')).toBe('page');
      expect(screen.getByTestId('nav-link-import').getAttribute('aria-current')).toBeNull();

      rerender(<Navigation currentPath="/import" />);
      expect(screen.getByTestId('nav-link-import').getAttribute('aria-current')).toBe('page');
      expect(screen.getByTestId('nav-link-tasks').getAttribute('aria-current')).toBeNull();

      rerender(<Navigation currentPath="/controls" />);
      expect(screen.getByTestId('nav-link-controls').getAttribute('aria-current')).toBe('page');

      rerender(<Navigation currentPath="/releases" />);
      expect(screen.getByTestId('nav-link-releases').getAttribute('aria-current')).toBe('page');

      // '/' should also highlight tasks
      rerender(<Navigation currentPath="/" />);
      expect(screen.getByTestId('nav-link-tasks').getAttribute('aria-current')).toBe('page');
    });

    it('invokes onNavigate callback when link is clicked', () => {
      const onNavigate = vi.fn();
      render(<Navigation currentPath="/tasks" onNavigate={onNavigate} />);

      const importLink = screen.getByTestId('nav-link-import');
      fireEvent.click(importLink);

      expect(onNavigate).toHaveBeenCalledWith('/import');
    });
  });

  describe('Footer', () => {
    it('renders monorepo package information and operating mode', () => {
      render(<Footer />);

      const footer = screen.getByTestId('dashboard-footer');
      expect(footer.textContent).toContain('AI Orchestrator');
      expect(footer.textContent).toContain('apps/orchestrator');
      expect(footer.textContent).toContain('apps/dashboard');
      expect(footer.textContent).toContain('packages/shared');
      expect(footer.textContent).toContain('packages/db');
      expect(screen.getByTestId('footer-mode-badge').textContent).toContain(
        'Chế độ: Headless Autonomous',
      );
    });
  });

  describe('DashboardLayout', () => {
    it('renders Header, Navigation, children in main content area, and Footer', async () => {
      const mockApi = {
        checkHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
        getBaseUrl: () => 'http://127.0.0.1:3000',
      } as unknown as ApiClient;

      render(
        <DashboardLayout apiClient={mockApi} currentPath="/tasks">
          <div data-testid="test-child">Child Content</div>
        </DashboardLayout>,
      );

      expect(screen.getByTestId('dashboard-layout-root')).toBeDefined();
      expect(screen.getByTestId('dashboard-header')).toBeDefined();
      expect(screen.getByTestId('dashboard-navigation')).toBeDefined();
      expect(screen.getByTestId('dashboard-main')).toBeDefined();
      expect(screen.getByTestId('test-child').textContent).toBe('Child Content');
      expect(screen.getByTestId('dashboard-footer')).toBeDefined();

      await waitFor(() => {
        expect(screen.getByTestId('connection-status-badge').textContent).toContain(
          'API Trực tuyến',
        );
      });
    });
  });

  describe('Pages', () => {
    it('HomePage renders 4 overview cards linking to sections', () => {
      render(<HomePage />);
      expect(screen.getByTestId('dashboard-home-page')).toBeDefined();
      expect(screen.getByTestId('card-tasks')).toBeDefined();
      expect(screen.getByTestId('card-import')).toBeDefined();
      expect(screen.getByTestId('card-controls')).toBeDefined();
      expect(screen.getByTestId('card-releases')).toBeDefined();
    });

    it('TasksPage renders tasks section placeholder', () => {
      render(<TasksPage />);
      expect(screen.getByTestId('dashboard-tasks-page')).toBeDefined();
      expect(screen.getByTestId('tasks-placeholder-box')).toBeDefined();
    });

    it('ControlsPage renders controls section placeholder', () => {
      render(<ControlsPage />);
      expect(screen.getByTestId('dashboard-controls-page')).toBeDefined();
      expect(screen.getByTestId('controls-placeholder-box')).toBeDefined();
    });

    it('ReleasesPage renders releases section placeholder', () => {
      render(<ReleasesPage />);
      expect(screen.getByTestId('dashboard-releases-page')).toBeDefined();
      expect(screen.getByTestId('releases-placeholder-box')).toBeDefined();
    });

    it('ImportPage renders ImportWorkflow component', () => {
      render(<ImportPage />);
      expect(screen.getByTestId('dashboard-import-page')).toBeDefined();
      expect(screen.getByTestId('import-workflow-root')).toBeDefined();
    });
  });
});
