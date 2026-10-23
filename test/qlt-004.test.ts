import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  RunRepository,
  ReportRepository,
  ReviewFindingRepository,
} from '../packages/db/src/index.js';
import {
  ReviewFindingSchema,
  ReviewFindingInputSchema,
  FindingSeveritySchema,
  computeReviewStats,
  isReviewPassing,
  extractJsonFindings,
  validateReviewFindings,
  type ReviewFinding,
  type ReviewResult,
} from '../packages/shared/src/index.js';
import { ReviewerService } from '../apps/orchestrator/src/services/reviewer-service.js';
import { QualityConfigService } from '../apps/orchestrator/src/services/quality-config-service.js';
import { QualityRunner } from '../apps/orchestrator/src/services/quality-runner.js';
import { ScopeDiffService } from '../apps/orchestrator/src/services/scope-diff-service.js';
import { buildServer } from '../apps/orchestrator/src/server.js';

describe('QLT-004 Acceptance Tests: Reviewer agent: findings {severity, file, line, message} (zod) — Output hợp lệ schema', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let runRepo: RunRepository;
  let reportRepo: ReportRepository;
  let findingRepo: ReviewFindingRepository;
  let reviewerService: ReviewerService;
  let scopeDiffService: ScopeDiffService;
  let app: FastifyInstance;
  let testRepoDir: string;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    runRepo = new RunRepository(db);
    reportRepo = new ReportRepository(db);
    findingRepo = new ReviewFindingRepository(db);

    scopeDiffService = new ScopeDiffService({ db });
    reviewerService = new ReviewerService({
      db,
      scopeDiffService,
      config: {
        AGY_BIN: process.execPath,
      },
    });

    const qualityConfigService = new QualityConfigService({ db });
    const qualityRunner = new QualityRunner({ db, qualityConfigService });

    app = await buildServer({
      db,
      qualityConfigService,
      qualityRunner,
      scopeDiffService,
      reviewerService,
    });

    // Initialize temporary real git repository for testing diff reviews
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qlt-004-repo-'));
    execSync('git init -b main', { cwd: testRepoDir, stdio: 'ignore' });
    execSync('git config user.email "reviewer-test@example.com"', { cwd: testRepoDir, stdio: 'ignore' });
    execSync('git config user.name "Reviewer Test User"', { cwd: testRepoDir, stdio: 'ignore' });

    fs.mkdirSync(path.join(testRepoDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(testRepoDir, 'src', 'index.ts'),
      'export function hello(): string { return "world"; }\n',
    );
    execSync('git add . && git commit -m "initial commit"', { cwd: testRepoDir, stdio: 'ignore' });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    try {
      fs.rmSync(testRepoDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('Nghiệm thu 1: Zod schema xác thực chính xác cấu trúc findings {severity, file, line, message}', () => {
    const validFinding = {
      severity: 'high',
      file: 'src/services/auth.ts',
      line: 42,
      message: 'Token verification is bypassed',
      category: 'security',
      rule_id: 'SEC-001',
      suggestion: 'Remove dev bypass',
    };

    const parsed = ReviewFindingSchema.parse(validFinding);
    expect(parsed.severity).toBe('high');
    expect(parsed.file).toBe('src/services/auth.ts');
    expect(parsed.line).toBe(42);
    expect(parsed.message).toBe('Token verification is bypassed');
    expect(parsed.category).toBe('security');
    expect(parsed.rule_id).toBe('SEC-001');
    expect(parsed.suggestion).toBe('Remove dev bypass');

    const fromInput = ReviewFindingInputSchema.parse(validFinding);
    expect(fromInput.severity).toBe('high');
    expect(fromInput.file).toBe('src/services/auth.ts');
  });

  it('Nghiệm thu 2: Phân loại đúng toàn bộ các mức severity (critical, high, medium, low, info)', () => {
    const severities = ['critical', 'high', 'medium', 'low', 'info'] as const;
    for (const sev of severities) {
      expect(FindingSeveritySchema.parse(sev)).toBe(sev);
      const finding = ReviewFindingSchema.parse({
        severity: sev,
        file: 'src/example.ts',
        line: 1,
        message: `Finding with severity ${sev}`,
      });
      expect(finding.severity).toBe(sev);
    }
  });

  it('Nghiệm thu 3: Từ chối output sai schema hoặc thiếu trường bắt buộc', () => {
    // Missing severity
    expect(() =>
      ReviewFindingSchema.parse({
        file: 'src/a.ts',
        line: 1,
        message: 'No severity',
      }),
    ).toThrow();

    // Missing file
    expect(() =>
      ReviewFindingSchema.parse({
        severity: 'medium',
        line: 1,
        message: 'No file',
      }),
    ).toThrow();

    // Missing line
    expect(() =>
      ReviewFindingSchema.parse({
        severity: 'medium',
        file: 'src/a.ts',
        message: 'No line',
      }),
    ).toThrow();

    // Invalid severity
    expect(() =>
      ReviewFindingSchema.parse({
        severity: 'fatal',
        file: 'src/a.ts',
        line: 1,
        message: 'Invalid severity',
      }),
    ).toThrow();

    // Non-positive line number
    expect(() =>
      ReviewFindingSchema.parse({
        severity: 'low',
        file: 'src/a.ts',
        line: 0,
        message: 'Zero line',
      }),
    ).toThrow();
  });

  it('Nghiệm thu 4: Bóc tách JSON linh hoạt từ markdown code fences và raw json object/array', () => {
    const markdownOutput = `
Analysis of the provided diff:
\`\`\`json
[
  {
    "severity": "medium",
    "file": "src/utils.ts",
    "line": 15,
    "message": "Potential memory leak in cache map"
  }
]
\`\`\`
Overall looks reasonable.
`;

    const extracted = extractJsonFindings(markdownOutput);
    const findings = validateReviewFindings(extracted);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('medium');
    expect(findings[0]?.file).toBe('src/utils.ts');
    expect(findings[0]?.line).toBe(15);

    // Object with findings array
    const objectOutput = JSON.stringify({
      findings: [
        {
          severity: 'low',
          file: 'README.md',
          line: 1,
          message: 'Minor typo in documentation',
        },
      ],
    });
    const fromObject = validateReviewFindings(extractJsonFindings(objectOutput));
    expect(fromObject).toHaveLength(1);
    expect(fromObject[0]?.severity).toBe('low');
  });

  it('Nghiệm thu 5: Đánh giá Quality Gate tuân thủ rule SKILL-testing (chặn high/critical)', () => {
    const cleanFindings: ReviewFinding[] = [
      { severity: 'info', file: 'src/a.ts', line: 1, message: 'Informational' },
      { severity: 'low', file: 'src/b.ts', line: 5, message: 'Style hint' },
      { severity: 'medium', file: 'src/c.ts', line: 12, message: 'Optimization' },
    ];
    expect(isReviewPassing(cleanFindings)).toBe(true);

    const highFindings: ReviewFinding[] = [
      ...cleanFindings,
      { severity: 'high', file: 'src/d.ts', line: 99, message: 'Logic error' },
    ];
    expect(isReviewPassing(highFindings)).toBe(false);

    const criticalFindings: ReviewFinding[] = [
      { severity: 'critical', file: 'src/e.ts', line: 1, message: 'Data loss bug' },
    ];
    expect(isReviewPassing(criticalFindings)).toBe(false);

    const stats = computeReviewStats(highFindings);
    expect(stats.total).toBe(4);
    expect(stats.high).toBe(1);
    expect(stats.medium).toBe(1);
    expect(stats.low).toBe(1);
    expect(stats.info).toBe(1);
  });

  it('Nghiệm thu 6: Reviewer agent spawn tiến trình an toàn, thu thập stdout và parse kết quả', async () => {
    const agentFindings = [
      {
        severity: 'high',
        file: 'src/index.ts',
        line: 1,
        message: 'Exported function signature does not match required contract',
      },
    ];

    const script = `console.log(JSON.stringify(${JSON.stringify(agentFindings)})); process.exit(0);`;

    const result = await reviewerService.reviewDiff({
      repoPath: testRepoDir,
      diff: '+export function hello(): number { return 1; }',
      command: {
        exe: process.execPath,
        args: ['-e', script],
      },
    });

    expect(result.passed).toBe(false);
    expect(result.stats.high).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.file).toBe('src/index.ts');
  });

  it('Nghiệm thu 7: Lưu trữ bản ghi findings và report vào SQLite', () => {
    taskRepo.create({
      id: 'TSK-QLT-004',
      title: 'Reviewer Test Task',
    });

    runRepo.create({
      id: 'RUN-QLT-004',
      task_id: 'TSK-QLT-004',
      status: 'RUNNING',
    });

    const rawJson = JSON.stringify([
      {
        severity: 'critical',
        file: 'src/secret.ts',
        line: 8,
        message: 'Hardcoded credentials exposed',
      },
    ]);

    const result = reviewerService.parseAndValidateReview(rawJson, {
      taskId: 'TSK-QLT-004',
      runId: 'RUN-QLT-004',
    });

    expect(result.passed).toBe(false);

    // Verify persisted in review_findings table
    const storedFindings = findingRepo.findByTaskId('TSK-QLT-004');
    expect(storedFindings).toHaveLength(1);
    expect(storedFindings[0]?.severity).toBe('critical');
    expect(storedFindings[0]?.file).toBe('src/secret.ts');
    expect(storedFindings[0]?.line).toBe(8);

    // Verify audit report in reports table
    const reports = reportRepo.findByRunId('RUN-QLT-004');
    expect(reports).toHaveLength(1);
    expect(reports[0]?.kind).toBe('review_findings');
    const parsedContent = JSON.parse(reports[0]!.content) as ReviewResult;
    expect(parsedContent.passed).toBe(false);
    expect(parsedContent.stats.critical).toBe(1);
  });

  it('Nghiệm thu 8: REST API POST /api/quality/review/validate xác thực output thô', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/quality/review/validate',
      payload: {
        output: JSON.stringify([
          {
            severity: 'low',
            file: 'src/config.ts',
            line: 22,
            message: 'Inconsistent indentation',
          },
        ]),
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json().data as ReviewResult;
    expect(body.passed).toBe(true);
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]?.severity).toBe('low');
  });

  it('Nghiệm thu 9: REST API GET /api/quality/findings và GET /api/tasks/:id/review-findings', async () => {
    taskRepo.create({
      id: 'TSK-API-TEST',
      title: 'API Query Task',
    });

    reviewerService.parseAndValidateReview(
      JSON.stringify([
        { severity: 'high', file: 'src/a.ts', line: 10, message: 'Bug A' },
        { severity: 'medium', file: 'src/b.ts', line: 20, message: 'Issue B' },
      ]),
      { taskId: 'TSK-API-TEST' },
    );

    // Query task findings
    const taskFindingsRes = await app.inject({
      method: 'GET',
      url: '/api/tasks/TSK-API-TEST/review-findings',
    });
    expect(taskFindingsRes.statusCode).toBe(200);
    expect(taskFindingsRes.json().data).toHaveLength(2);

    // Query with filter severity=high
    const filteredRes = await app.inject({
      method: 'GET',
      url: '/api/quality/findings?severity=high',
    });
    expect(filteredRes.statusCode).toBe(200);
    const filteredData = filteredRes.json().data;
    expect(filteredData).toHaveLength(1);
    expect(filteredData[0].severity).toBe('high');
  });

  it('Nghiệm thu 10: REST API POST /api/tasks/:id/review thực thi kiểm tra cho task', async () => {
    taskRepo.create({
      id: 'TSK-REVIEW-EXEC',
      title: 'Review Execution Task',
      description: 'Check code for defects',
      acceptance_criteria: ['Function returns valid greeting'],
      scope_files: ['src/index.ts'],
    });

    const script = `console.log(JSON.stringify([])); process.exit(0);`;

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/TSK-REVIEW-EXEC/review',
      payload: {
        repoPath: testRepoDir,
        command: {
          exe: process.execPath,
          args: ['-e', script],
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json().data as ReviewResult;
    expect(data.passed).toBe(true);
    expect(data.findings).toEqual([]);
  });
});
