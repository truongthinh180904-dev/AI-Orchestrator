import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  createDatabase,
  runMigrations,
  QualityCheckRepository,
  TaskRepository,
  RunRepository,
} from '../packages/db/src/index.js';
import type { QualityCommandDefinition } from '../packages/shared/src/index.js';
import { QualityRunner } from '../apps/orchestrator/src/services/quality-runner.js';
import { QualityConfigService } from '../apps/orchestrator/src/services/quality-config-service.js';
import { buildServer } from '../apps/orchestrator/src/server.js';

describe('QLT-002 Acceptance Tests: Runner chạy các lệnh, lưu stdout/stderr/exit code — Có bản ghi mỗi lệnh', () => {
  let db: Database.Database;
  let qualityCheckRepo: QualityCheckRepository;
  let taskRepo: TaskRepository;
  let runRepo: RunRepository;
  let configService: QualityConfigService;
  let runner: QualityRunner;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    qualityCheckRepo = new QualityCheckRepository(db);
    taskRepo = new TaskRepository(db);
    runRepo = new RunRepository(db);

    configService = new QualityConfigService({ db });
    runner = new QualityRunner({
      db,
      qualityConfigService: configService,
    });

    taskRepo.create({
      id: 'TASK-QLT-002',
      title: 'QLT-002 Verification Task',
      repository: process.cwd(),
      test_commands: ['node -e "console.log(\'task tests executed\')"'],
    });

    runRepo.create({
      id: 'run-acceptance-4',
      task_id: 'TASK-QLT-002',
      attempt: 1,
      status: 'RUNNING',
      started_at: new Date().toISOString(),
    });

    app = await buildServer({
      db,
      qualityConfigService: configService,
      qualityRunner: runner,
    });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  describe('Nghiệm thu: Runner chạy các lệnh, lưu stdout/stderr/exit code', () => {
    it('1. Chạy lệnh thành công và lưu đầy đủ stdout, stderr, exit code 0 cùng thời gian thực thi', async () => {
      const cmd: QualityCommandDefinition = {
        id: 'cmd-format-pass',
        stage: 'format',
        name: 'Prettier code style check',
        command: 'node -e "console.log(\'formatting OK\')"',
        exe: 'node',
        args: ['-e', 'console.log("formatting OK")'],
        cwd: process.cwd(),
        timeout_ms: 5000,
        enabled: true,
        required: true,
        continueOnError: false,
      };

      const record = await runner.runCommand(cmd, { taskId: 'TASK-QLT-002' });

      // Kiểm tra stdout, stderr, exit code
      expect(record.status).toBe('SUCCESS');
      expect(record.exit_code).toBe(0);
      expect(record.signal).toBeNull();
      expect(record.stdout.trim()).toBe('formatting OK');
      expect(record.stderr).toBe('');
      expect(record.duration_ms).toBeGreaterThanOrEqual(0);
      expect(record.started_at).toBeDefined();
      expect(record.finished_at).toBeDefined();

      // Kiểm tra bản ghi trong DB
      const stored = qualityCheckRepo.getById(record.id);
      expect(stored).not.toBeNull();
      expect(stored?.exit_code).toBe(0);
      expect(stored?.stdout.trim()).toBe('formatting OK');
      expect(stored?.status).toBe('SUCCESS');
    });

    it('2. Chạy lệnh thất bại và lưu chính xác stderr cùng mã lỗi exit code khác 0', async () => {
      const cmd: QualityCommandDefinition = {
        id: 'cmd-lint-fail',
        stage: 'lint',
        name: 'Lint syntax error',
        command: 'node -e "console.error(\'SyntaxError: Unexpected token\'); process.exit(42)"',
        exe: 'node',
        args: ['-e', 'console.error("SyntaxError: Unexpected token"); process.exit(42)'],
        cwd: process.cwd(),
        timeout_ms: 5000,
        enabled: true,
        required: true,
        continueOnError: false,
      };

      const record = await runner.runCommand(cmd, { taskId: 'TASK-QLT-002' });

      expect(record.status).toBe('FAILURE');
      expect(record.exit_code).toBe(42);
      expect(record.stderr).toContain('SyntaxError: Unexpected token');

      const stored = qualityCheckRepo.getById(record.id);
      expect(stored?.exit_code).toBe(42);
      expect(stored?.stderr).toContain('SyntaxError: Unexpected token');
      expect(stored?.status).toBe('FAILURE');
    });

    it('3. Xử lý timeout an toàn, hủy tiến trình con và ghi nhận status TIMEOUT', async () => {
      const cmd: QualityCommandDefinition = {
        id: 'cmd-timeout-test',
        stage: 'test',
        name: 'Long running test suite',
        command: 'node -e "setInterval(() => {}, 1000)"',
        exe: 'node',
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: process.cwd(),
        timeout_ms: 250,
        enabled: true,
        required: true,
        continueOnError: false,
      };

      const record = await runner.runCommand(cmd, { taskId: 'TASK-QLT-002' });

      expect(record.status).toBe('TIMEOUT');
      expect(record.duration_ms).toBeGreaterThanOrEqual(200);

      const stored = qualityCheckRepo.getById(record.id);
      expect(stored?.status).toBe('TIMEOUT');
    });
  });

  describe('Nghiệm thu: Có bản ghi mỗi lệnh (Pipeline Execution & Audit Trail)', () => {
    it('4. Chạy pipeline nhiều stage và tạo bản ghi riêng biệt cho từng lệnh trong cơ sở dữ liệu', async () => {
      const pipeline: QualityCommandDefinition[] = [
        {
          id: 'step-format',
          stage: 'format',
          name: 'Check formatting',
          command: 'node -e "console.log(\'1. Format check passed\')"',
          exe: 'node',
          args: ['-e', 'console.log("1. Format check passed")'],
          cwd: process.cwd(),
          timeout_ms: 5000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
        {
          id: 'step-lint',
          stage: 'lint',
          name: 'Check lint rules',
          command: 'node -e "console.log(\'2. Lint check passed\')"',
          exe: 'node',
          args: ['-e', 'console.log("2. Lint check passed")'],
          cwd: process.cwd(),
          timeout_ms: 5000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
        {
          id: 'step-typecheck',
          stage: 'typecheck',
          name: 'Check types',
          command: 'node -e "console.log(\'3. Type check passed\')"',
          exe: 'node',
          args: ['-e', 'console.log("3. Type check passed")'],
          cwd: process.cwd(),
          timeout_ms: 5000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
        {
          id: 'step-test',
          stage: 'test',
          name: 'Execute unit tests',
          command: 'node -e "console.log(\'4. Tests passed\')"',
          exe: 'node',
          args: ['-e', 'console.log("4. Tests passed")'],
          cwd: process.cwd(),
          timeout_ms: 5000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
      ];

      const result = await runner.runPipeline(pipeline, {
        taskId: 'TASK-QLT-002',
        runId: 'run-acceptance-4',
      });

      expect(result.success).toBe(true);
      expect(result.total_commands).toBe(4);
      expect(result.passed_commands).toBe(4);

      // Nghiệm thu: Có bản ghi mỗi lệnh
      const taskRecords = qualityCheckRepo.findByTaskId('TASK-QLT-002');
      expect(taskRecords).toHaveLength(4);

      const stages = taskRecords.map((r) => r.stage);
      expect(stages).toEqual(['format', 'lint', 'typecheck', 'test']);

      for (const record of taskRecords) {
        expect(record.task_id).toBe('TASK-QLT-002');
        expect(record.run_id).toBe('run-acceptance-4');
        expect(record.status).toBe('SUCCESS');
        expect(record.exit_code).toBe(0);
        expect(record.stdout.length).toBeGreaterThan(0);
      }
    });

    it('5. Khi một lệnh bắt buộc thất bại, dừng pipeline và lưu bản ghi SKIPPED cho các lệnh kế tiếp', async () => {
      const pipeline: QualityCommandDefinition[] = [
        {
          id: 'step-format',
          stage: 'format',
          name: 'Format check',
          command: 'node -e "console.log(\'format ok\')"',
          exe: 'node',
          args: ['-e', 'console.log("format ok")'],
          cwd: process.cwd(),
          timeout_ms: 5000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
        {
          id: 'step-lint',
          stage: 'lint',
          name: 'Lint failing',
          command: 'node -e "console.error(\'eslint failure\'); process.exit(1)"',
          exe: 'node',
          args: ['-e', 'console.error("eslint failure"); process.exit(1)'],
          cwd: process.cwd(),
          timeout_ms: 5000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
        {
          id: 'step-test',
          stage: 'test',
          name: 'Test should be skipped',
          command: 'node -e "console.log(\'should not run\')"',
          exe: 'node',
          args: ['-e', 'console.log("should not run")'],
          cwd: process.cwd(),
          timeout_ms: 5000,
          enabled: true,
          required: true,
          continueOnError: false,
        },
      ];

      const result = await runner.runPipeline(pipeline, {
        taskId: 'TASK-QLT-002',
        stopOnFirstFailure: true,
      });

      expect(result.success).toBe(false);
      expect(result.failed_commands).toBe(1);
      expect(result.skipped_commands).toBe(1);

      // Cả 3 lệnh đều phải có bản ghi trong DB
      const dbRecords = qualityCheckRepo.findByTaskId('TASK-QLT-002');
      expect(dbRecords).toHaveLength(3);

      expect(dbRecords[0]?.status).toBe('SUCCESS');
      expect(dbRecords[1]?.status).toBe('FAILURE');
      expect(dbRecords[2]?.status).toBe('SKIPPED');
      expect(dbRecords[2]?.stderr).toContain('Skipped due to prior stage failure');
    });
  });

  describe('Nghiệm thu: Tích hợp REST API', () => {
    it('6. POST /api/quality/run thực thi pipeline và trả về kết quả kèm danh sách bản ghi', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/quality/run',
        payload: {
          taskId: 'TASK-QLT-002',
          commands: [
            'node -e "console.log(\'api test 1\')"',
            'node -e "console.log(\'api test 2\')"',
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.data.success).toBe(true);
      expect(json.data.total_commands).toBe(2);
      expect(json.data.records).toHaveLength(2);
      expect(json.data.records[0]?.stdout.trim()).toBe('api test 1');
      expect(json.data.records[1]?.stdout.trim()).toBe('api test 2');
    });

    it('7. GET /api/quality/records truy vấn danh sách bản ghi với bộ lọc', async () => {
      // Create some records
      qualityCheckRepo.create({
        task_id: 'TASK-QLT-002',
        stage: 'format',
        command_id: 'c-format',
        name: 'Prettier',
        command: 'prettier',
        exe: 'node',
        cwd: process.cwd(),
        exit_code: 0,
        status: 'SUCCESS',
      });
      qualityCheckRepo.create({
        task_id: 'TASK-QLT-002',
        stage: 'lint',
        command_id: 'c-lint',
        name: 'ESLint',
        command: 'eslint',
        exe: 'node',
        cwd: process.cwd(),
        exit_code: 1,
        status: 'FAILURE',
      });

      const resAll = await app.inject({
        method: 'GET',
        url: '/api/quality/records?taskId=TASK-QLT-002',
      });
      expect(resAll.statusCode).toBe(200);
      const jsonAll = JSON.parse(resAll.payload);
      expect(jsonAll.data).toHaveLength(2);

      const resFiltered = await app.inject({
        method: 'GET',
        url: '/api/quality/records?taskId=TASK-QLT-002&status=FAILURE',
      });
      expect(resFiltered.statusCode).toBe(200);
      const jsonFiltered = JSON.parse(resFiltered.payload);
      expect(jsonFiltered.data).toHaveLength(1);
      expect(jsonFiltered.data[0]?.stage).toBe('lint');
    });

    it('8. GET /api/quality/records/:id trả về chi tiết 1 bản ghi có stdout, stderr, exit_code', async () => {
      const created = qualityCheckRepo.create({
        task_id: 'TASK-QLT-002',
        stage: 'test',
        command_id: 'c-test',
        name: 'Test detailed view',
        command: 'vitest',
        exe: 'node',
        cwd: process.cwd(),
        exit_code: 0,
        status: 'SUCCESS',
        stdout: 'PASSED 100%\n',
        stderr: '',
        duration_ms: 320,
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/quality/records/${created.id}`,
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.data.id).toBe(created.id);
      expect(json.data.stdout).toBe('PASSED 100%\n');
      expect(json.data.exit_code).toBe(0);
      expect(json.data.duration_ms).toBe(320);
    });

    it('9. GET /api/tasks/:id/quality-records trả về tất cả bản ghi thuộc task', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/tasks/TASK-QLT-002/quality-records',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(Array.isArray(json.data)).toBe(true);
    });
  });
});
