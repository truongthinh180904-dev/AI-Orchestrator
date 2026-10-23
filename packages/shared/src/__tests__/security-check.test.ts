import { describe, it, expect } from 'vitest';
import {
  parsePnpmAuditOutput,
  maskSecret,
  hashSecret,
  scanTextForSecrets,
  parseGitleaksJson,
  isIgnoredScanPath,
} from '../index.js';

describe('Security Check & Audit Parser (packages/shared)', () => {
  it('parses clean pnpm audit output with 0 vulnerabilities (PASS)', () => {
    const rawStdout = JSON.stringify({
      actions: [],
      advisories: {},
      muted: [],
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 0,
          critical: 0,
        },
        dependencies: 120,
        devDependencies: 45,
        optionalDependencies: 0,
        totalDependencies: 165,
      },
    });

    const result = parsePnpmAuditOutput(rawStdout, { exitCode: 0 });

    expect(result.passed).toBe(true);
    expect(result.counts.total).toBe(0);
    expect(result.counts.high).toBe(0);
    expect(result.counts.critical).toBe(0);
    expect(result.highOrCriticalCount).toBe(0);
    expect(result.vulnerabilities).toHaveLength(0);
    expect(result.summary).toContain('Audit PASS');
  });

  it('passes when only low or moderate vulnerabilities exist (no high+)', () => {
    const rawStdout = JSON.stringify({
      advisories: {
        '1001': {
          id: 1001,
          title: 'Low severity advisory',
          module_name: 'test-pkg',
          severity: 'low',
          vulnerable_versions: '<1.0.1',
          patched_versions: '>=1.0.1',
          findings: [{ paths: ['test-pkg'] }],
        },
        '1002': {
          id: 1002,
          title: 'Moderate severity advisory',
          module_name: 'other-pkg',
          severity: 'moderate',
          vulnerable_versions: '<2.0.0',
          patched_versions: '>=2.0.0',
          findings: [{ paths: ['other-pkg'] }],
        },
      },
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 1,
          moderate: 1,
          high: 0,
          critical: 0,
        },
      },
    });

    const result = parsePnpmAuditOutput(rawStdout, { exitCode: 1 });

    // Per SKILL-testing: "audit không có lỗ hổng high+"
    expect(result.passed).toBe(true);
    expect(result.counts.low).toBe(1);
    expect(result.counts.moderate).toBe(1);
    expect(result.counts.high).toBe(0);
    expect(result.counts.critical).toBe(0);
    expect(result.highOrCriticalCount).toBe(0);
    expect(result.vulnerabilities).toHaveLength(2);
  });

  it('fails Quality Gate when high or critical vulnerabilities exist', () => {
    const rawStdout = JSON.stringify({
      advisories: {
        '2001': {
          id: 2001,
          title: 'Remote code execution in core library',
          module_name: 'vulnerable-lib',
          severity: 'critical',
          vulnerable_versions: '<3.4.0',
          patched_versions: '>=3.4.0',
          cwe: 'CWE-1395',
          url: 'https://github.com/advisories/GHSA-1234',
          findings: [{ paths: ['app>vulnerable-lib'] }],
        },
        '2002': {
          id: 2002,
          title: 'Denial of service',
          module_name: 'dos-lib',
          severity: 'high',
          vulnerable_versions: '<2.1.0',
          findings: [{ paths: ['app>dos-lib'] }],
        },
      },
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 0,
          high: 1,
          critical: 1,
        },
      },
    });

    const result = parsePnpmAuditOutput(rawStdout, { exitCode: 1 });

    expect(result.passed).toBe(false);
    expect(result.counts.critical).toBe(1);
    expect(result.counts.high).toBe(1);
    expect(result.highOrCriticalCount).toBe(2);
    expect(result.summary).toContain('Audit FAIL');
    expect(result.vulnerabilities[0]?.severity).toBe('critical');
    expect(result.vulnerabilities[0]?.cwe).toBe('CWE-1395');
  });

  it('respects stricter custom auditLevel (e.g. moderate threshold)', () => {
    const rawStdout = JSON.stringify({
      advisories: {
        '3001': {
          id: 3001,
          title: 'Moderate issue',
          module_name: 'mod-lib',
          severity: 'moderate',
        },
      },
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0 },
      },
    });

    const result = parsePnpmAuditOutput(rawStdout, { auditLevel: 'moderate' });
    expect(result.passed).toBe(false);
  });

  it('handles empty or malformed audit output gracefully', () => {
    const emptyResult = parsePnpmAuditOutput('', { exitCode: 0 });
    expect(emptyResult.passed).toBe(true);
    expect(emptyResult.counts.total).toBe(0);

    const malformedResult = parsePnpmAuditOutput('Non-JSON error message from registry', { exitCode: 1 });
    expect(malformedResult.passed).toBe(false);
    expect(malformedResult.counts.total).toBe(0);
  });

  it('masks secrets and generates reproducible SHA-256 hashes without leaking secrets', () => {
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const masked = maskSecret(awsKey);

    expect(masked).not.toBe(awsKey);
    expect(masked.startsWith('AKI')).toBe(true);
    expect(masked.endsWith('PLE')).toBe(true);
    expect(masked).toContain('******');

    const shortSecret = 'secret';
    expect(maskSecret(shortSecret)).toBe('***[REDACTED]***');

    const hash1 = hashSecret(awsKey);
    const hash2 = hashSecret(awsKey);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
  });

  it('detects multiple credential formats with built-in regex scanner', () => {
    const sampleCode = `
      // Sample configuration
      const aws_key = "AKIA1234567890ABCDEF";
      const github_token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
      const slack = "xoxb-1234567890-abcdefghijklmnopqrstuv";
      const openai = "sk-1234567890abcdefghijklmnopqrstuvwxyz";
      const secretPass = 'password = "SuperSecretPassword123!"';
      const cleanLine = 'const port = 3000;';
    `;

    const findings = scanTextForSecrets(sampleCode, 'src/config.ts');

    expect(findings.length).toBeGreaterThanOrEqual(4);
    const ruleIds = findings.map((f) => f.rule_id);
    expect(ruleIds).toContain('aws_access_key');
    expect(ruleIds).toContain('github_pat');
    expect(ruleIds).toContain('slack_token');
    expect(ruleIds).toContain('ai_api_key');

    // Confirm that every match preview is masked
    for (const f of findings) {
      expect(f.match_preview).toContain('*');
      expect(f.file).toBe('src/config.ts');
      expect(f.line).toBeGreaterThan(0);
    }
  });

  it('parses Gitleaks JSON reports and redacts sensitive matches', () => {
    const gitleaksOutput = JSON.stringify([
      {
        Description: 'AWS Access Key',
        File: 'packages/db/connection.ts',
        StartLine: 42,
        RuleID: 'aws-access-key',
        Secret: 'AKIAIOSFODNN7EXAMPLE',
        Match: 'AKIAIOSFODNN7EXAMPLE',
        Commit: 'abc1234',
        Author: 'dev@example.com',
        Date: '2026-10-23T10:00:00Z',
      },
    ]);

    const findings = parseGitleaksJson(gitleaksOutput);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe('packages/db/connection.ts');
    expect(findings[0]?.line).toBe(42);
    expect(findings[0]?.rule_id).toBe('aws-access-key');
    expect(findings[0]?.match_preview).not.toBe('AKIAIOSFODNN7EXAMPLE');
    expect(findings[0]?.match_preview).toContain('*');
    expect(findings[0]?.commit).toBe('abc1234');
  });

  it('correctly filters out ignored scan paths (.git, node_modules, lockfiles, images)', () => {
    expect(isIgnoredScanPath('.git/HEAD')).toBe(true);
    expect(isIgnoredScanPath('node_modules/pkg/index.js')).toBe(true);
    expect(isIgnoredScanPath('pnpm-lock.yaml')).toBe(true);
    expect(isIgnoredScanPath('dist/bundle.js')).toBe(true);
    expect(isIgnoredScanPath('logo.png')).toBe(true);
    expect(isIgnoredScanPath('.env.example')).toBe(true);

    expect(isIgnoredScanPath('src/server.ts')).toBe(false);
    expect(isIgnoredScanPath('apps/orchestrator/src/config.ts')).toBe(false);
  });
});
