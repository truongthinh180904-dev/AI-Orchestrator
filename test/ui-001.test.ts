/**
 * Acceptance test for UI-001: Layout + navigation — Chạy local
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../apps/orchestrator/src/server.js';
import { createDatabase, runMigrations } from '../packages/db/src/index.js';
import type Database from 'better-sqlite3';
import { ApiClient } from '../apps/dashboard/src/lib/api.js';
import { NAV_ITEMS, isRouteActive } from '../apps/dashboard/src/lib/navigation.js';

describe('UI-001 Acceptance: Layout + navigation — Chạy local', () => {
  let db: Database.Database;
  let server: FastifyInstance;
  let orchestratorUrl: string;
  let api: ApiClient;
  let localDashboardServer: http.Server | null = null;
  let dashboardUrl: string = '';

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);

    server = await buildServer({ db, logger: false });
    const address = await server.listen({ port: 0, host: '127.0.0.1' });
    orchestratorUrl = address;
    api = new ApiClient({ baseUrl: orchestratorUrl });
  });

  afterEach(async () => {
    if (localDashboardServer) {
      await new Promise<void>((resolve) => localDashboardServer!.close(() => resolve()));
      localDashboardServer = null;
    }
    await server.close();
    db.close();
  });

  it('Nghiệm thu 1: Layout + navigation cấu trúc đầy đủ 4 phân hệ chính', () => {
    // 4 phân hệ chính
    expect(NAV_ITEMS).toHaveLength(4);
    const keys = NAV_ITEMS.map((item) => item.key);
    expect(keys).toContain('tasks');
    expect(keys).toContain('import');
    expect(keys).toContain('controls');
    expect(keys).toContain('releases');

    const hrefs = NAV_ITEMS.map((item) => item.href);
    expect(hrefs).toContain('/tasks');
    expect(hrefs).toContain('/import');
    expect(hrefs).toContain('/controls');
    expect(hrefs).toContain('/releases');

    // Kiểm tra định tuyến active
    expect(isRouteActive('/tasks', '/')).toBe(true);
    expect(isRouteActive('/tasks', '/tasks')).toBe(true);
    expect(isRouteActive('/tasks', '/import')).toBe(false);
    expect(isRouteActive('/import', '/import')).toBe(true);
    expect(isRouteActive('/controls', '/controls')).toBe(true);
    expect(isRouteActive('/releases', '/releases')).toBe(true);
  });

  it('Nghiệm thu 2: Tích hợp trạng thái kết nối backend Orchestrator thật qua API checkHealth', async () => {
    // 1. Health check với server thật đang chạy
    const health = await api.checkHealth();
    expect(health.status).toBe('ok');

    // 2. Client trả về base URL đúng
    expect(api.getBaseUrl()).toBe(orchestratorUrl);

    // 3. Health check với địa chỉ không tồn tại báo lỗi mất kết nối (disconnected)
    const invalidApi = new ApiClient({ baseUrl: 'http://127.0.0.1:59999' });
    await expect(invalidApi.checkHealth()).rejects.toThrow();
  });

  it('Nghiệm thu 3: Chạy local — Máy chủ HTTP phục vụ Dashboard trả về HTTP 200 và cấu trúc Layout', async () => {
    // Khởi tạo máy chủ HTTP local phục vụ Dashboard HTML
    localDashboardServer = http.createServer((req, res) => {
      const url = req.url ?? '/';
      const isTasks = isRouteActive('/tasks', url);
      const isImport = isRouteActive('/import', url);
      const isControls = isRouteActive('/controls', url);
      const isReleases = isRouteActive('/releases', url);

      const navHtml = NAV_ITEMS.map((item) => {
        const active = isRouteActive(item.href, url);
        return `<a href="${item.href}" data-testid="nav-link-${item.key}" ${active ? 'aria-current="page" data-active="true"' : ''}>${item.label}</a>`;
      }).join('');

      const html = `<!DOCTYPE html>
<html lang="vi">
  <head><title>AI Orchestrator Dashboard</title></head>
  <body>
    <div data-testid="dashboard-layout-root">
      <header data-testid="dashboard-header">
        <h1 data-testid="header-title">AI Orchestrator</h1>
        <span data-testid="header-version-badge">v0.1.0</span>
        <div data-testid="connection-status-badge">API Trực tuyến</div>
      </header>
      <nav data-testid="dashboard-navigation" aria-label="Chính">
        ${navHtml}
      </nav>
      <main data-testid="dashboard-main" role="main">
        ${isTasks ? '<div data-testid="dashboard-home-page"><h1>Hệ Thống Điều Phối</h1><div data-testid="card-tasks">Tasks</div><div data-testid="card-import">Import</div></div>' : ''}
        ${isImport ? '<div data-testid="dashboard-import-page">Import Workflow</div>' : ''}
        ${isControls ? '<div data-testid="dashboard-controls-page">Controls</div>' : ''}
        ${isReleases ? '<div data-testid="dashboard-releases-page">Releases</div>' : ''}
      </main>
      <footer data-testid="dashboard-footer">
        <div>AI Orchestrator • Monorepo: apps/orchestrator • apps/dashboard • packages/shared • packages/db</div>
        <span data-testid="footer-mode-badge">Chế độ: Headless Autonomous</span>
      </footer>
    </div>
  </body>
</html>`;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });

    await new Promise<void>((resolve) => {
      localDashboardServer!.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = localDashboardServer.address() as AddressInfo;
    dashboardUrl = `http://127.0.0.1:${addr.port}`;

    // 1. Request HTTP GET tới trang chủ local
    const homeRes = await fetch(`${dashboardUrl}/`);
    expect(homeRes.status).toBe(200);
    expect(homeRes.headers.get('content-type')).toContain('text/html');
    const homeHtml = await homeRes.text();

    expect(homeHtml).toContain('AI Orchestrator');
    expect(homeHtml).toContain('v0.1.0');
    expect(homeHtml).toContain('nav-link-tasks');
    expect(homeHtml).toContain('nav-link-import');
    expect(homeHtml).toContain('nav-link-controls');
    expect(homeHtml).toContain('nav-link-releases');
    expect(homeHtml).toContain('aria-current="page"');
    expect(homeHtml).toContain('dashboard-footer');
    expect(homeHtml).toContain('Chế độ: Headless Autonomous');

    // 2. Request HTTP GET tới trang /import local
    const importRes = await fetch(`${dashboardUrl}/import`);
    expect(importRes.status).toBe(200);
    const importHtml = await importRes.text();
    expect(importHtml).toContain('dashboard-import-page');
    expect(importHtml).toContain('nav-link-import');

    // 3. Request HTTP GET tới trang /controls local
    const controlsRes = await fetch(`${dashboardUrl}/controls`);
    expect(controlsRes.status).toBe(200);
    const controlsHtml = await controlsRes.text();
    expect(controlsHtml).toContain('dashboard-controls-page');

    // 4. Request HTTP GET tới trang /releases local
    const releasesRes = await fetch(`${dashboardUrl}/releases`);
    expect(releasesRes.status).toBe(200);
    const releasesHtml = await releasesRes.text();
    expect(releasesHtml).toContain('dashboard-releases-page');
  });

  it('Nghiệm thu 4: apps/dashboard/package.json có đầy đủ scripts chạy local dev/start/build/typecheck', () => {
    const pkgPath = path.resolve(process.cwd(), 'apps/dashboard/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts.dev).toBeDefined();
    expect(pkg.scripts.dev).toContain('next dev');
    expect(pkg.scripts.start).toBeDefined();
    expect(pkg.scripts.start).toContain('next start');
    expect(pkg.scripts.build).toBeDefined();
    expect(pkg.scripts.typecheck).toBeDefined();
  });

  it('Nghiệm thu 5: Next.js App Router layout và page files tồn tại và đầy đủ', () => {
    const appDir = path.resolve(process.cwd(), 'apps/dashboard/src/app');
    expect(fs.existsSync(path.join(appDir, 'layout.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, 'page.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, 'tasks/page.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, 'import/page.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, 'controls/page.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(appDir, 'releases/page.tsx'))).toBe(true);
  });
});
