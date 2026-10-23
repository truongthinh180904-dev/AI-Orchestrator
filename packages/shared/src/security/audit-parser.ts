import {
  type AuditCounts,
  type AuditResult,
  type AuditVulnerability,
  type AuditVulnerabilitySeverity,
  AuditCountsSchema,
  AuditVulnerabilitySeveritySchema,
} from '../models/security-check.js';

export interface ParseAuditOptions {
  auditLevel?: 'info' | 'low' | 'moderate' | 'high' | 'critical';
  command?: string;
  exitCode?: number | null;
  stderr?: string;
  durationMs?: number;
}

/**
 * Parses stdout from `pnpm audit --json` (or `npm audit --json`), extracting vulnerabilities,
 * severity counts, and determining Quality Gate pass/fail status.
 */
export function parsePnpmAuditOutput(
  stdout: string,
  options: ParseAuditOptions = {},
): AuditResult {
  const command = options.command ?? 'pnpm audit --json';
  const exitCode = options.exitCode ?? null;
  const stderr = options.stderr ?? '';
  const durationMs = options.durationMs ?? 0;
  const auditLevel = options.auditLevel ?? 'high';

  const emptyCounts: AuditCounts = {
    info: 0,
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
    total: 0,
  };

  if (!stdout || !stdout.trim()) {
    // If exit code is 0 and stdout is empty, no vulnerabilities found
    const passed = exitCode === 0;
    return {
      passed,
      command,
      exit_code: exitCode,
      stdout: stdout ?? '',
      stderr,
      duration_ms: durationMs,
      vulnerabilities: [],
      counts: emptyCounts,
      highOrCriticalCount: 0,
      summary: passed
        ? 'Audit passed: 0 vulnerabilities found'
        : 'Audit output was empty but process exited with non-zero code',
    };
  }

  // Find JSON substring if stdout contains log prefixes/suffixes
  let parsedJson: unknown = null;
  try {
    parsedJson = JSON.parse(stdout);
  } catch {
    const firstBrace = stdout.indexOf('{');
    const lastBrace = stdout.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        const potentialJson = stdout.slice(firstBrace, lastBrace + 1);
        parsedJson = JSON.parse(potentialJson);
      } catch {
        // Not valid JSON
      }
    }
  }

  if (!parsedJson || typeof parsedJson !== 'object') {
    const passed = exitCode === 0;
    return {
      passed,
      command,
      exit_code: exitCode,
      stdout,
      stderr,
      duration_ms: durationMs,
      vulnerabilities: [],
      counts: emptyCounts,
      highOrCriticalCount: 0,
      summary: passed
        ? 'Audit command completed with non-JSON output'
        : 'Audit command failed with unparseable output',
    };
  }

  const rawObj = parsedJson as Record<string, unknown>;
  const vulnerabilities: AuditVulnerability[] = [];
  const counts: AuditCounts = { ...emptyCounts };

  // Format 1: pnpm audit format with "advisories" dictionary
  if (rawObj.advisories && typeof rawObj.advisories === 'object') {
    const advisories = rawObj.advisories as Record<string, unknown>;
    for (const [key, item] of Object.entries(advisories)) {
      if (item && typeof item === 'object') {
        const adv = item as Record<string, unknown>;
        const rawSeverity = String(adv.severity ?? 'moderate').toLowerCase();
        const severityResult = AuditVulnerabilitySeveritySchema.safeParse(rawSeverity);
        const severity: AuditVulnerabilitySeverity = severityResult.success
          ? severityResult.data
          : 'moderate';

        const paths: string[] = [];
        if (Array.isArray(adv.findings)) {
          for (const f of adv.findings) {
            if (f && typeof f === 'object' && Array.isArray((f as Record<string, unknown>).paths)) {
              for (const p of (f as Record<string, unknown>).paths as unknown[]) {
                if (typeof p === 'string') paths.push(p);
              }
            }
          }
        }

        vulnerabilities.push({
          id: adv.id ? String(adv.id) : key,
          title: String(adv.title ?? `Vulnerability in ${adv.module_name ?? 'dependency'}`),
          module_name: String(adv.module_name ?? 'unknown'),
          severity,
          vulnerable_versions: adv.vulnerable_versions ? String(adv.vulnerable_versions) : undefined,
          patched_versions: adv.patched_versions ? String(adv.patched_versions) : undefined,
          cwe: typeof adv.cwe === 'string' ? adv.cwe : Array.isArray(adv.cwe) ? adv.cwe.join(', ') : undefined,
          url: adv.url ? String(adv.url) : undefined,
          paths,
        });

        counts[severity] += 1;
        counts.total += 1;
      }
    }
  }
  // Format 2: npm audit format with "vulnerabilities" object
  else if (rawObj.vulnerabilities && typeof rawObj.vulnerabilities === 'object') {
    const vulns = rawObj.vulnerabilities as Record<string, unknown>;
    for (const [pkgName, item] of Object.entries(vulns)) {
      if (item && typeof item === 'object') {
        const v = item as Record<string, unknown>;
        const rawSeverity = String(v.severity ?? 'moderate').toLowerCase();
        const severityResult = AuditVulnerabilitySeveritySchema.safeParse(rawSeverity);
        const severity: AuditVulnerabilitySeverity = severityResult.success
          ? severityResult.data
          : 'moderate';

        vulnerabilities.push({
          id: pkgName,
          title: `Vulnerability in ${pkgName}`,
          module_name: String(v.name ?? pkgName),
          severity,
          vulnerable_versions: typeof v.range === 'string' ? v.range : undefined,
          paths: Array.isArray(v.nodes) ? v.nodes.map(String) : [],
        });

        counts[severity] += 1;
        counts.total += 1;
      }
    }
  }

  // Format 3: metadata counts if available (e.g. pnpm metadata.vulnerabilities)
  if (rawObj.metadata && typeof rawObj.metadata === 'object') {
    const meta = rawObj.metadata as Record<string, unknown>;
    if (meta.vulnerabilities && typeof meta.vulnerabilities === 'object') {
      const metaVulns = meta.vulnerabilities as Record<string, unknown>;
      const parsedMeta = AuditCountsSchema.safeParse({
        info: Number(metaVulns.info ?? counts.info),
        low: Number(metaVulns.low ?? counts.low),
        moderate: Number(metaVulns.moderate ?? counts.moderate),
        high: Number(metaVulns.high ?? counts.high),
        critical: Number(metaVulns.critical ?? counts.critical),
        total:
          Number(metaVulns.info ?? 0) +
          Number(metaVulns.low ?? 0) +
          Number(metaVulns.moderate ?? 0) +
          Number(metaVulns.high ?? 0) +
          Number(metaVulns.critical ?? 0),
      });
      if (parsedMeta.success) {
        counts.info = parsedMeta.data.info;
        counts.low = parsedMeta.data.low;
        counts.moderate = parsedMeta.data.moderate;
        counts.high = parsedMeta.data.high;
        counts.critical = parsedMeta.data.critical;
        counts.total = parsedMeta.data.total;
      }
    }
  }

  const highOrCriticalCount = counts.high + counts.critical;

  // Determine pass/fail based on policy:
  // Default: audit passes if high and critical vulnerabilities are 0 ("không có lỗ hổng high+")
  let passed: boolean;
  if (auditLevel === 'critical') {
    passed = counts.critical === 0;
  } else if (auditLevel === 'high') {
    passed = highOrCriticalCount === 0;
  } else if (auditLevel === 'moderate') {
    passed = counts.moderate === 0 && highOrCriticalCount === 0;
  } else if (auditLevel === 'low') {
    passed = counts.low === 0 && counts.moderate === 0 && highOrCriticalCount === 0;
  } else {
    passed = counts.total === 0;
  }

  const summary = passed
    ? `Audit PASS: ${counts.total} vulnerabilities (${counts.critical} critical, ${counts.high} high, ${counts.moderate} moderate, ${counts.low} low, ${counts.info} info)`
    : `Audit FAIL: ${highOrCriticalCount} high/critical vulnerabilities found (${counts.critical} critical, ${counts.high} high, ${counts.moderate} moderate, ${counts.low} low)`;

  return {
    passed,
    command,
    exit_code: exitCode,
    stdout,
    stderr,
    duration_ms: durationMs,
    vulnerabilities,
    counts,
    highOrCriticalCount,
    summary,
  };
}
