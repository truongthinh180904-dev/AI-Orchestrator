import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  createDatabase,
  runMigrations,
  TaskRepository,
  RunRepository,
  ReportRepository,
} from '@ai-orchestrator/db';
import { ReviewerService } from '../services/reviewer-service.js';
import { buildServer } from '../server.js';
import { AppError } from '@ai-orchestrator/shared';

describe('ReviewerService (QLT-004)', () => {
  let db: Database.Database;
  let taskRepo: TaskRepository;
  let runRepo: RunRepository;
  let reportRepo: ReportRepository;
  let reviewerService: ReviewerService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    taskRepo = new TaskRepository(db);
    runRepo = new RunRepository(db);
    reportRepo = new ReportRepository(db);
    reviewerService = new ReviewerService({
      db,
      config: {
        AGY_BIN: process.execPath,
      },
    });
  });

  afterEach(() => {
    db.close();
  });

  describe('parseAndValidateReview', () => {
    it('parses valid JSON findings, computes stats, and determines passed status', () => {
      taskRepo.create({
        id: 'TSK-001',
        title: 'Billing Service Implementation',
      });
      runRepo.create({
        id: 'RUN-001',
        task_id: 'TSK-001',
        status: 'RUNNING',
      });

      const rawOutput = JSON.stringify([
        {
          severity: 'medium',
          file: 'src/services/billing.ts',
          line: 25,
          message: 'Missing rounding for monetary values',
          category: 'correctness',
          suggestion: 'Math.round or toFixed(2)',
        },
        {
          severity: 'low',
          file: 'src/utils/format.ts',
          line: 10,
          message: 'Unused parameter in formatter function',
        },
      ]);

      const result = reviewerService.parseAndValidateReview(rawOutput, {
        taskId: 'TSK-001',
        runId: 'RUN-001',
      });

      expect(result.passed).toBe(true);
      expect(result.findings).toHaveLength(2);
      expect(result.stats.total).toBe(2);
      expect(result.stats.medium).toBe(1);
      expect(result.stats.low).toBe(1);
      expect(result.stats.high).toBe(0);
      expect(result.stats.critical).toBe(0);

      // Verify findings persisted to DB
      const dbFindings = reviewerService.getFindingsForTask('TSK-001');
      expect(dbFindings).toHaveLength(2);
      expect(dbFindings[0]?.file).toBe('src/services/billing.ts');
      expect(dbFindings[0]?.severity).toBe('medium');

      // Verify report persisted in reports table
      const reports = reportRepo.findByRunId('RUN-001');
      expect(reports).toHaveLength(1);
      expect(reports[0]?.kind).toBe('review_findings');
    });

    it('marks passed = false when severity is high or critical', () => {
      const rawOutput = `
\`\`\`json
[
  {
    "severity": "high",
    "file": "src/api/payment.ts",
    "line": 88,
    "message": "Payment gateway webhook signature is not verified"
  }
]
\`\`\`
`;

      const result = reviewerService.parseAndValidateReview(rawOutput, {
        taskId: 'TSK-SEC',
      });

      expect(result.passed).toBe(false);
      expect(result.stats.high).toBe(1);
      expect(result.summary).toContain('Found 0 critical and 1 high');
    });

    it('throws AppError INVALID_REVIEW_FINDINGS when output cannot be parsed as JSON', () => {
      expect(() =>
        reviewerService.parseAndValidateReview('Sorry I cannot review this code.'),
      ).toThrowError(AppError);
    });

    it('throws AppError INVALID_REVIEW_SCHEMA when findings fail zod schema', () => {
      const invalidJson = JSON.stringify([
        {
          severity: 'unknown_level',
          file: 'src/test.ts',
          line: 1,
          message: 'test',
        },
      ]);

      expect(() => reviewerService.parseAndValidateReview(invalidJson)).toThrowError(AppError);
    });
  });

  describe('reviewDiff with process spawning (node -e)', () => {
    it('spawns mock process, receives json findings, and returns ReviewResult', async () => {
      const mockFindings = [
        {
          severity: 'info',
          file: 'src/logger.ts',
          line: 12,
          message: 'Consider using structured context log',
        },
      ];

      const script = `console.log(JSON.stringify(${JSON.stringify(mockFindings)})); process.exit(0);`;

      const result = await reviewerService.reviewDiff({
        taskId: 'TSK-MOCK',
        diff: '--- a/src/logger.ts\n+++ b/src/logger.ts\n@@ -1 +1 @@\n-console.log\n+logger.info',
        command: {
          exe: process.execPath,
          args: ['-e', script],
        },
      });

      expect(result.passed).toBe(true);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.file).toBe('src/logger.ts');
    });

    it('handles mock process failure with non-zero exit code and no output', async () => {
      const script = `console.error('Process fatal failure'); process.exit(1);`;

      await expect(
        reviewerService.reviewDiff({
          taskId: 'TSK-FAIL',
          diff: '+added code',
          command: {
            exe: process.execPath,
            args: ['-e', script],
          },
        }),
      ).rejects.toThrowError(AppError);
    });
  });

  describe('reviewTask with DB task lookup', () => {
    it('looks up task criteria, extracts diff, and reviews successfully', async () => {
      taskRepo.create({
        id: 'TSK-999',
        title: 'Security Hardening',
        description: 'Sanitize all user inputs',
        acceptance_criteria: ['Use zod for validation', 'Reject malicious tags'],
        scope_files: ['src/sanitizer.ts'],
      });

      const script = `console.log(JSON.stringify([])); process.exit(0);`;

      const result = await reviewerService.reviewTask('TSK-999', {
        command: {
          exe: process.execPath,
          args: ['-e', script],
        },
      });

      expect(result).toBeDefined();
      expect(result.passed).toBe(true);
      expect(result.findings).toEqual([]);
    });

    it('throws AppError TASK_NOT_FOUND when task does not exist', async () => {
      await expect(reviewerService.reviewTask('NON_EXISTENT_TASK')).rejects.toThrowError(
        'Task with id NON_EXISTENT_TASK does not exist',
      );
    });
  });

  describe('Fastify REST API endpoints', () => {
    it('POST /api/quality/review/validate validates raw json without agent spawn', async () => {
      const server = await buildServer({ db, reviewerService });

      const response = await server.inject({
        method: 'POST',
        url: '/api/quality/review/validate',
        payload: {
          output: JSON.stringify([
            {
              severity: 'low',
              file: 'src/index.ts',
              line: 5,
              message: 'Minor formatting issue',
            },
          ]),
          taskId: 'TSK-API',
        },
      });

      expect(response.statusCode).toBe(200);
      const data = response.json().data;
      expect(data.passed).toBe(true);
      expect(data.findings).toHaveLength(1);
      expect(data.findings[0].file).toBe('src/index.ts');

      await server.close();
    });

    it('GET /api/quality/findings returns list and count of findings with filters', async () => {
      taskRepo.create({
        id: 'TSK-FILTER',
        title: 'Filter Test Task',
      });

      const server = await buildServer({ db, reviewerService });

      reviewerService.parseAndValidateReview(
        JSON.stringify([
          { severity: 'high', file: 'src/auth.ts', line: 10, message: 'Auth bug' },
          { severity: 'low', file: 'src/style.css', line: 1, message: 'Color contrast' },
        ]),
        { taskId: 'TSK-FILTER' },
      );

      const responseAll = await server.inject({
        method: 'GET',
        url: '/api/quality/findings',
      });

      expect(responseAll.statusCode).toBe(200);
      const allData = responseAll.json().data;
      expect(allData).toHaveLength(2);

      const responseFiltered = await server.inject({
        method: 'GET',
        url: '/api/quality/findings?severity=high',
      });

      expect(responseFiltered.statusCode).toBe(200);
      const filteredData = responseFiltered.json().data;
      expect(filteredData).toHaveLength(1);
      expect(filteredData[0].severity).toBe('high');

      await server.close();
    });

    it('GET /api/tasks/:id/review-findings retrieves task findings', async () => {
      taskRepo.create({
        id: 'TSK-TASK-GET',
        title: 'Get Task Test',
      });

      const server = await buildServer({ db, reviewerService });

      reviewerService.parseAndValidateReview(
        JSON.stringify([
          { severity: 'medium', file: 'src/calc.ts', line: 20, message: 'Divide by zero' },
        ]),
        { taskId: 'TSK-TASK-GET' },
      );

      const response = await server.inject({
        method: 'GET',
        url: '/api/tasks/TSK-TASK-GET/review-findings',
      });

      expect(response.statusCode).toBe(200);
      const data = response.json().data;
      expect(data).toHaveLength(1);
      expect(data[0].message).toBe('Divide by zero');

      await server.close();
    });
  });
});
