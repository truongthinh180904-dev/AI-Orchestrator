import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  generateLaunchdPlist,
  validatePlistXml,
  LaunchdServiceConfigSchema,
  FLAG_CLI_MAP,
} from '../packages/shared/src/index.js';
import { CaffeinateManager } from '../apps/orchestrator/src/services/caffeinate-manager.js';
import { buildServer } from '../apps/orchestrator/src/server.js';
import { createDatabase, runMigrations } from '../packages/db/src/index.js';
import type Database from 'better-sqlite3';

interface MockChildProcess extends EventEmitter {
  pid: number;
  killed: boolean;
  exitCode: number | null;
  kill: (signal?: string) => boolean;
}

function createMockChildProcess(pid = 12345): ChildProcess {
  const emitter = new EventEmitter();
  const mockChild: MockChildProcess = Object.assign(emitter, {
    pid,
    killed: false,
    exitCode: null,
    kill: vi.fn((signal?: string) => {
      mockChild.killed = true;
      mockChild.exitCode = signal === 'SIGTERM' ? 0 : 1;
      emitter.emit('exit', 0, signal);
      return true;
    }),
  });
  return mockChild as unknown as ChildProcess;
}

describe('OPS-006: Service khởi động (launchd) + caffeinate giữ máy thức; hướng dẫn', () => {
  const rootDir = path.resolve(__dirname, '..');
  let db: Database.Database;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // Ignore
    }
    vi.restoreAllMocks();
  });

  describe('1. Cấu hình & Trình tạo File Property List (launchd plist)', () => {
    it('1.1: Định nghĩa schema LaunchdServiceConfigSchema đầy đủ và xác thực hợp lệ', () => {
      const validConfig = {
        label: 'com.test.service',
        programArguments: ['/usr/bin/caffeinate', '-dimsu', 'pnpm', 'start'],
        workingDirectory: '/test/dir',
        environmentVariables: {
          NODE_ENV: 'production',
          PATH: '/usr/local/bin:/usr/bin',
        },
        standardOutPath: '/test/dir/logs/stdout.log',
        standardErrorPath: '/test/dir/logs/stderr.log',
        runAtLoad: true,
        keepAlive: { Crashed: true, SuccessfulExit: false },
        throttleInterval: 30,
      };

      const parsed = LaunchdServiceConfigSchema.parse(validConfig);
      expect(parsed.label).toBe('com.test.service');
      expect(parsed.programArguments).toHaveLength(4);
      expect(parsed.keepAlive).toEqual({ Crashed: true, SuccessfulExit: false });
    });

    it('1.2: Sinh XML plist chuẩn Apple DTD 1.0 và escape ký tự đặc biệt an toàn', () => {
      const config = {
        label: 'com.ai-orchestrator.test',
        programArguments: ['/usr/bin/caffeinate', '-dimsu', 'pnpm', 'test & run > log'],
        workingDirectory: '/path/with/"quotes"&<tags>',
        runAtLoad: true,
        keepAlive: true,
        nice: 5,
        startInterval: 300,
      };

      const xml = generateLaunchdPlist(config);

      expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(xml).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">');
      expect(xml).toContain('<key>Label</key>');
      expect(xml).toContain('<string>com.ai-orchestrator.test</string>');
      expect(xml).toContain('<key>RunAtLoad</key>');
      expect(xml).toContain('<true/>');
      expect(xml).toContain('<key>Nice</key>');
      expect(xml).toContain('<integer>5</integer>');
      expect(xml).toContain('<key>StartInterval</key>');
      expect(xml).toContain('<integer>300</integer>');

      // Verify XML escaping
      expect(xml).toContain('test &amp; run &gt; log');
      expect(xml).toContain('/path/with/&quot;quotes&quot;&amp;&lt;tags&gt;');

      const validation = validatePlistXml(xml);
      expect(validation.valid).toBe(true);
    });

    it('1.3: Kiểm tra các file plist mẫu trong repo bằng plutil native của macOS', () => {
      const servicePlistPath = path.join(rootDir, 'services/launchd/com.ai-orchestrator.service.plist');
      const runnerPlistPath = path.join(rootDir, 'services/launchd/com.ai-orchestrator.runner.plist');

      expect(fs.existsSync(servicePlistPath)).toBe(true);
      expect(fs.existsSync(runnerPlistPath)).toBe(true);

      const serviceContent = fs.readFileSync(servicePlistPath, 'utf-8');
      const runnerContent = fs.readFileSync(runnerPlistPath, 'utf-8');

      expect(serviceContent).toContain('<string>com.ai-orchestrator.service</string>');
      expect(serviceContent).toContain('/usr/bin/caffeinate');
      expect(serviceContent).toContain('-dimsu');

      expect(runnerContent).toContain('<string>com.ai-orchestrator.runner</string>');
      expect(runnerContent).toContain('run-agy.sh');

      // Native plutil lint on macOS
      if (process.platform === 'darwin') {
        const serviceCheck = execSync(`plutil -lint "${servicePlistPath}"`, { encoding: 'utf-8' });
        expect(serviceCheck).toContain('OK');

        const runnerCheck = execSync(`plutil -lint "${runnerPlistPath}"`, { encoding: 'utf-8' });
        expect(runnerCheck).toContain('OK');
      }
    });

    it('1.4: Kiểm tra các template plist có sẵn trong thư mục templates/launchd', () => {
      const serviceTmpl = path.join(rootDir, 'templates/launchd/com.ai-orchestrator.service.plist.template');
      const runnerTmpl = path.join(rootDir, 'templates/launchd/com.ai-orchestrator.runner.plist.template');

      expect(fs.existsSync(serviceTmpl)).toBe(true);
      expect(fs.existsSync(runnerTmpl)).toBe(true);

      const serviceTmplContent = fs.readFileSync(serviceTmpl, 'utf-8');
      expect(serviceTmplContent).toContain('{{SERVICE_LABEL}}');
      expect(serviceTmplContent).toContain('{{CAFFEINATE_BIN}}');
      expect(serviceTmplContent).toContain('{{WORKING_DIR}}');
    });
  });

  describe('2. Quản Lý Tiến Trình Chống Ngủ Caffeinate (CaffeinateManager)', () => {
    it('2.1: Chuyển đổi chính xác các flags sang tùy chọn dòng lệnh của caffeinate', () => {
      expect(FLAG_CLI_MAP.display).toBe('-d');
      expect(FLAG_CLI_MAP.idle).toBe('-i');
      expect(FLAG_CLI_MAP.disk).toBe('-m');
      expect(FLAG_CLI_MAP.system).toBe('-s');
      expect(FLAG_CLI_MAP.user).toBe('-u');
    });

    it('2.2: Kích hoạt power assertion (acquire) gọi caffeinate với các cờ mong muốn', () => {
      let spawnedCmd = '';
      let spawnedArgs: string[] = [];
      const mockChild = createMockChildProcess(8877);

      const manager = new CaffeinateManager({
        platform: 'darwin',
        spawner: (cmd, args) => {
          spawnedCmd = cmd;
          spawnedArgs = args;
          return mockChild;
        },
      });

      expect(manager.isAvailable()).toBe(true);
      const stateBefore = manager.getStatus();
      expect(stateBefore.active).toBe(false);

      const state = manager.acquire({
        flags: ['display', 'idle', 'disk', 'system'],
        timeoutSeconds: 3600,
        waitPid: 1234,
        reason: 'Overnight Test Run',
      });

      expect(spawnedCmd).toBe('/usr/bin/caffeinate');
      expect(spawnedArgs).toEqual(['-d', '-i', '-m', '-s', '-t', '3600', '-w', '1234']);
      expect(state.active).toBe(true);
      expect(state.pid).toBe(8877);
      expect(state.reason).toBe('Overnight Test Run');
      expect(state.command).toContain('/usr/bin/caffeinate -d -i -m -s -t 3600 -w 1234');
    });

    it('2.3: Gọi acquire liên tiếp khi đã active sẽ bảo toàn trạng thái hiện tại không spawn trùng', () => {
      let spawnCount = 0;
      const mockChild = createMockChildProcess(5555);

      const manager = new CaffeinateManager({
        platform: 'darwin',
        spawner: () => {
          spawnCount++;
          return mockChild;
        },
      });

      manager.acquire({ reason: 'Run 1' });
      expect(spawnCount).toBe(1);

      const state2 = manager.acquire({ reason: 'Run 2' });
      expect(spawnCount).toBe(1);
      expect(state2.pid).toBe(5555);
    });

    it('2.4: Giải phóng power assertion (release) gửi SIGTERM và đặt lại trạng thái sạch', () => {
      const mockChild = createMockChildProcess(4321);

      const manager = new CaffeinateManager({
        platform: 'darwin',
        spawner: () => mockChild,
      });

      manager.acquire({ reason: 'Temporary Lock' });
      expect(manager.getStatus().active).toBe(true);

      const releasedState = manager.release();
      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(releasedState.active).toBe(false);
      expect(releasedState.pid).toBeNull();
      expect(manager.getStatus().active).toBe(false);
    });

    it('2.5: Tự động cập nhật trạng thái khi tiến trình caffeinate kết thúc đột ngột', () => {
      const mockChild = createMockChildProcess(7777);

      const manager = new CaffeinateManager({
        platform: 'darwin',
        spawner: () => mockChild,
      });

      manager.acquire();
      expect(manager.getStatus().active).toBe(true);

      // Simulate child process exit
      mockChild.emit('exit', 0, null);

      expect(manager.getStatus().active).toBe(false);
      expect(manager.getStatus().pid).toBeNull();
    });

    it('2.6: Xử lý mô phỏng khi chạy trên môi trường không phải macOS (non-darwin)', () => {
      const manager = new CaffeinateManager({
        platform: 'linux',
      });

      expect(manager.isAvailable()).toBe(false);
      const state = manager.acquire({ reason: 'CI Simulation' });
      expect(state.active).toBe(true);
      expect(state.available).toBe(false);
      expect(state.reason).toBe('CI Simulation');
    });
  });

  describe('3. REST API Quản Trị Power & Launchd (/system/power, /system/launchd)', () => {
    it('3.1: GET /system/power trả về trạng thái power assertion và platform hiện tại', async () => {
      const manager = new CaffeinateManager({
        platform: 'darwin',
        spawner: () => createMockChildProcess(9900),
      });

      const server = await buildServer({
        db,
        caffeinateManager: manager,
      });

      const response = await server.inject({
        method: 'GET',
        url: '/system/power',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.active).toBe(false);
      expect(body.data.platform).toBe('darwin');
      expect(body.data.available).toBe(true);

      await server.close();
    });

    it('3.2: POST /system/power/assert và POST /system/power/release điều khiển power assertion qua API', async () => {
      const mockChild = createMockChildProcess(1212);
      const manager = new CaffeinateManager({
        platform: 'darwin',
        spawner: () => mockChild,
      });

      const server = await buildServer({
        db,
        caffeinateManager: manager,
      });

      // Assert power
      const assertRes = await server.inject({
        method: 'POST',
        url: '/system/power/assert',
        payload: {
          flags: ['idle', 'system'],
          reason: 'API Triggered Overnight Execution',
        },
      });

      expect(assertRes.statusCode).toBe(200);
      const assertBody = assertRes.json();
      expect(assertBody.data.success).toBe(true);
      expect(assertBody.data.state.active).toBe(true);
      expect(assertBody.data.state.pid).toBe(1212);
      expect(assertBody.data.state.reason).toBe('API Triggered Overnight Execution');

      // Release power
      const releaseRes = await server.inject({
        method: 'POST',
        url: '/system/power/release',
      });

      expect(releaseRes.statusCode).toBe(200);
      const releaseBody = releaseRes.json();
      expect(releaseBody.data.success).toBe(true);
      expect(releaseBody.data.state.active).toBe(false);

      await server.close();
    });

    it('3.3: POST /system/launchd/generate-plist sinh XML plist trực tiếp qua API', async () => {
      const server = await buildServer({ db });

      const response = await server.inject({
        method: 'POST',
        url: '/system/launchd/generate-plist',
        payload: {
          label: 'com.custom.orchestrator',
          programArguments: ['/usr/bin/caffeinate', '-dimsu', 'node', 'main.js'],
          workingDirectory: '/workspace/project',
          runAtLoad: true,
          keepAlive: true,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.label).toBe('com.custom.orchestrator');
      expect(body.data.plistXml).toContain('<key>Label</key>');
      expect(body.data.plistXml).toContain('<string>com.custom.orchestrator</string>');

      await server.close();
    });
  });

  describe('4. Kịch Bản Điều Khiển Dịch Vụ (Shell Scripts: service-control.sh, run-caffeinated.sh)', () => {
    it('4.1: Các file script tồn tại, có quyền thực thi và cú pháp bash hợp lệ', () => {
      const runnerScript = path.join(rootDir, 'scripts/run-caffeinated.sh');
      const controlScript = path.join(rootDir, 'scripts/service-control.sh');

      expect(fs.existsSync(runnerScript)).toBe(true);
      expect(fs.existsSync(controlScript)).toBe(true);

      const runnerStats = fs.statSync(runnerScript);
      const controlStats = fs.statSync(controlScript);

      // Check executable permission (at least user executable 0o100)
      expect(runnerStats.mode & 0o111).toBeGreaterThan(0);
      expect(controlStats.mode & 0o111).toBeGreaterThan(0);

      // Bash syntax check via bash -n
      expect(() => execSync(`bash -n "${runnerScript}"`)).not.toThrow();
      expect(() => execSync(`bash -n "${controlScript}"`)).not.toThrow();
    });

    it('4.2: scripts/service-control.sh hiển thị trợ giúp đầy đủ khi gọi help', () => {
      const controlScript = path.join(rootDir, 'scripts/service-control.sh');
      const output = execSync(`"${controlScript}" help`, { encoding: 'utf-8' });

      expect(output).toContain('AI Orchestrator — Launchd & Caffeinate Service Management');
      expect(output).toContain('install');
      expect(output).toContain('uninstall');
      expect(output).toContain('start');
      expect(output).toContain('stop');
      expect(output).toContain('status');
      expect(output).toContain('logs');
    });

    it('4.3: scripts/service-control.sh generate in nội dung plist hợp lệ theo chuẩn Apple Property List', () => {
      const controlScript = path.join(rootDir, 'scripts/service-control.sh');
      const servicePlist = execSync(`"${controlScript}" generate service`, { encoding: 'utf-8' });

      expect(servicePlist).toContain('com.ai-orchestrator.service');
      expect(servicePlist).toContain('/usr/bin/caffeinate');

      const runnerPlist = execSync(`"${controlScript}" generate runner`, { encoding: 'utf-8' });
      expect(runnerPlist).toContain('com.ai-orchestrator.runner');
      expect(runnerPlist).toContain('run-agy.sh');
    });
  });

  describe('5. Tài Liệu Hướng Dẫn Vận Hành (Documentation)', () => {
    it('5.1: Tài liệu docs/launchd-service-guide.md đầy đủ nội dung kiến trúc, cấu hình, caffeinate và xử lý sự cố', () => {
      const docPath = path.join(rootDir, 'docs/launchd-service-guide.md');
      expect(fs.existsSync(docPath)).toBe(true);

      const content = fs.readFileSync(docPath, 'utf-8');
      expect(content).toContain('LaunchAgent');
      expect(content).toContain('LaunchDaemon');
      expect(content).toContain('com.ai-orchestrator.service.plist');
      expect(content).toContain('com.ai-orchestrator.runner.plist');
      expect(content).toContain('caffeinate');
      expect(content).toContain('-dimsu');
      expect(content).toContain('service-control.sh');
      expect(content).toContain('launchctl');
      expect(content).toContain('Troubleshooting');
    });

    it('5.2: RUN.md cập nhật hướng dẫn khởi chạy xuyên đêm qua Launchd Service', () => {
      const runMdPath = path.join(rootDir, 'RUN.md');
      const content = fs.readFileSync(runMdPath, 'utf-8');

      expect(content).toContain('Cách 1: Chạy tự động qua Launchd Service');
      expect(content).toContain('service-control.sh install service');
      expect(content).toContain('docs/launchd-service-guide.md');
      expect(content).toContain('run-caffeinated.sh');
    });
  });
});
