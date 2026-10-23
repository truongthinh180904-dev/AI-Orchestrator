import { describe, expect, it } from 'vitest';
import {
  FindingSeveritySchema,
  ReviewFindingSchema,
  ReviewFindingInputSchema,
  computeReviewStats,
  isReviewPassing,
  extractJsonFindings,
  validateReviewFindings,
  buildReviewerPrompt,
  type ReviewFinding,
} from '../models/quality-review.js';

describe('QLT-004: Reviewer agent findings schema & utilities', () => {
  describe('FindingSeveritySchema', () => {
    it('accepts all valid severity levels', () => {
      const validLevels = ['info', 'low', 'medium', 'high', 'critical'];
      for (const level of validLevels) {
        expect(FindingSeveritySchema.parse(level)).toBe(level);
      }
    });

    it('rejects invalid severity level', () => {
      expect(() => FindingSeveritySchema.parse('severe')).toThrow();
      expect(() => FindingSeveritySchema.parse('warning')).toThrow();
      expect(() => FindingSeveritySchema.parse('')).toThrow();
    });
  });

  describe('ReviewFindingSchema (QLT-004 core requirement: {severity, file, line, message})', () => {
    it('successfully parses valid finding object with all required fields', () => {
      const finding = {
        severity: 'high',
        file: 'apps/orchestrator/src/services/order.ts',
        line: 45,
        message: 'Unchecked null pointer reference on user session',
      };

      const parsed = ReviewFindingSchema.parse(finding);
      expect(parsed.severity).toBe('high');
      expect(parsed.file).toBe('apps/orchestrator/src/services/order.ts');
      expect(parsed.line).toBe(45);
      expect(parsed.message).toBe('Unchecked null pointer reference on user session');
    });

    it('accepts optional fields (category, rule_id, suggestion)', () => {
      const finding = {
        severity: 'critical',
        file: 'src/auth.ts',
        line: 12,
        message: 'Hardcoded secret token in code',
        category: 'security',
        rule_id: 'SEC-001',
        suggestion: 'Read secret from process.env instead',
      };

      const parsed = ReviewFindingSchema.parse(finding);
      expect(parsed.category).toBe('security');
      expect(parsed.rule_id).toBe('SEC-001');
      expect(parsed.suggestion).toBe('Read secret from process.env instead');
    });

    it('rejects finding with missing required fields', () => {
      expect(() => ReviewFindingSchema.parse({ severity: 'high', file: 'a.ts', line: 1 })).toThrow();
      expect(() => ReviewFindingSchema.parse({ severity: 'high', file: 'a.ts', message: 'msg' })).toThrow();
      expect(() => ReviewFindingSchema.parse({ severity: 'high', line: 1, message: 'msg' })).toThrow();
      expect(() => ReviewFindingSchema.parse({ file: 'a.ts', line: 1, message: 'msg' })).toThrow();
    });

    it('rejects non-positive or non-integer line numbers in strict schema', () => {
      expect(() =>
        ReviewFindingSchema.parse({
          severity: 'low',
          file: 'test.ts',
          line: 0,
          message: 'Zero line',
        }),
      ).toThrow();

      expect(() =>
        ReviewFindingSchema.parse({
          severity: 'low',
          file: 'test.ts',
          line: -5,
          message: 'Negative line',
        }),
      ).toThrow();

      expect(() =>
        ReviewFindingSchema.parse({
          severity: 'low',
          file: 'test.ts',
          line: 1.5,
          message: 'Float line',
        }),
      ).toThrow();
    });
  });

  describe('ReviewFindingInputSchema (Flexible parsing for LLM output)', () => {
    it('normalizes uppercase severity and string line numbers', () => {
      const raw = {
        severity: 'HIGH',
        file: 'src/index.ts',
        line: '10',
        message: 'Something is wrong',
      };

      const parsed = ReviewFindingInputSchema.parse(raw);
      expect(parsed.severity).toBe('high');
      expect(parsed.line).toBe(10);
    });

    it('normalizes alternative keys path -> file, comment -> message', () => {
      const raw = {
        severity: 'medium',
        path: 'src/utils.ts',
        lineNumber: 25,
        comment: 'Code style issue',
      };

      const parsed = ReviewFindingInputSchema.parse(raw);
      expect(parsed.file).toBe('src/utils.ts');
      expect(parsed.line).toBe(25);
      expect(parsed.message).toBe('Code style issue');
    });

    it('defaults invalid or missing line number to 1', () => {
      const raw = {
        severity: 'low',
        file: 'README.md',
        message: 'Typo in docs',
      };

      const parsed = ReviewFindingInputSchema.parse(raw);
      expect(parsed.line).toBe(1);
    });
  });

  describe('computeReviewStats and isReviewPassing', () => {
    it('computes accurate counts for each severity level', () => {
      const findings: ReviewFinding[] = [
        { severity: 'critical', file: 'a.ts', line: 1, message: 'm1' },
        { severity: 'high', file: 'b.ts', line: 2, message: 'm2' },
        { severity: 'high', file: 'c.ts', line: 3, message: 'm3' },
        { severity: 'medium', file: 'd.ts', line: 4, message: 'm4' },
        { severity: 'low', file: 'e.ts', line: 5, message: 'm5' },
        { severity: 'info', file: 'f.ts', line: 6, message: 'm6' },
      ];

      const stats = computeReviewStats(findings);
      expect(stats.total).toBe(6);
      expect(stats.critical).toBe(1);
      expect(stats.high).toBe(2);
      expect(stats.medium).toBe(1);
      expect(stats.low).toBe(1);
      expect(stats.info).toBe(1);
    });

    it('isReviewPassing enforces SKILL-testing rule (no high or critical)', () => {
      expect(isReviewPassing([])).toBe(true);
      expect(
        isReviewPassing([
          { severity: 'low', file: 'a.ts', line: 1, message: 'Minor style' },
          { severity: 'info', file: 'b.ts', line: 2, message: 'FYI' },
          { severity: 'medium', file: 'c.ts', line: 3, message: 'Refactor candidate' },
        ]),
      ).toBe(true);

      expect(
        isReviewPassing([
          { severity: 'high', file: 'a.ts', line: 1, message: 'Bug' },
        ]),
      ).toBe(false);

      expect(
        isReviewPassing([
          { severity: 'critical', file: 'a.ts', line: 1, message: 'Crash' },
        ]),
      ).toBe(false);
    });
  });

  describe('extractJsonFindings & validateReviewFindings', () => {
    it('extracts findings from markdown code fence with json tag', () => {
      const markdown = `
Here is my review of the changes:
\`\`\`json
[
  {
    "severity": "medium",
    "file": "src/api.ts",
    "line": 34,
    "message": "Missing input validation"
  }
]
\`\`\`
Hope this helps!
`;
      const extracted = extractJsonFindings(markdown);
      const validated = validateReviewFindings(extracted);
      expect(validated).toHaveLength(1);
      expect(validated[0]?.file).toBe('src/api.ts');
      expect(validated[0]?.severity).toBe('medium');
    });

    it('extracts findings from object with "findings" key', () => {
      const raw = JSON.stringify({
        summary: 'Found 1 issue',
        findings: [
          {
            severity: 'critical',
            file: 'packages/db/connection.ts',
            line: 50,
            message: 'SQL injection potential in raw query',
          },
        ],
      });

      const extracted = extractJsonFindings(raw);
      const validated = validateReviewFindings(extracted);
      expect(validated).toHaveLength(1);
      expect(validated[0]?.severity).toBe('critical');
    });

    it('extracts empty findings array [] correctly', () => {
      const extracted = extractJsonFindings('```json\n[]\n```');
      const validated = validateReviewFindings(extracted);
      expect(validated).toEqual([]);
    });

    it('throws when output contains invalid JSON or schema violations', () => {
      expect(() => extractJsonFindings('Just normal text without any json brackets')).toThrow();

      const invalidItem = [{ severity: 'unknown', file: 'a.ts', line: 1, message: 'm' }];
      expect(() => validateReviewFindings(invalidItem)).toThrow(/violates schema/);
    });
  });

  describe('buildReviewerPrompt', () => {
    it('creates structured prompt containing task details and diff', () => {
      const prompt = buildReviewerPrompt({
        task: {
          id: 'TSK-001',
          title: 'Add User Service',
          description: 'Implement user creation and authentication',
          acceptance_criteria: ['Hash password before saving', 'Emit user.created event'],
          scope_files: ['src/user.ts', 'src/events.ts'],
        },
        changedFiles: ['src/user.ts'],
        diff: '+function saveUser() {}',
      });

      expect(prompt).toContain('TASK INFORMATION:');
      expect(prompt).toContain('TSK-001');
      expect(prompt).toContain('Hash password before saving');
      expect(prompt).toContain('src/user.ts');
      expect(prompt).toContain('GIT DIFF:');
      expect(prompt).toContain('+function saveUser() {}');
      expect(prompt).toContain('CRITICAL REVIEW CONSTRAINTS:');
    });
  });
});
