import fs from 'node:fs';
import path from 'node:path';
import {
  type SecretFinding,
  maskSecret,
  hashSecret,
} from '../models/security-check.js';

export interface SecretPatternRule {
  id: string;
  name: string;
  description: string;
  regex: RegExp;
}

/**
 * Built-in high-confidence secret detection rules.
 * Matches common credentials, API keys, private keys, and authorization tokens.
 */
export const BUILTIN_SECRET_RULES: SecretPatternRule[] = [
  {
    id: 'private_key',
    name: 'Private Key',
    description: 'Unencrypted Private Key header found',
    regex: /-----BEGIN (?:RSA|OPENSSH|DSA|EC|PGP)?\s*PRIVATE KEY-----/g,
  },
  {
    id: 'aws_access_key',
    name: 'AWS Access Key',
    description: 'AWS Access Key ID format (AKIA/ASIA/...)',
    regex: /\b(AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'github_pat',
    name: 'GitHub Personal Access Token',
    description: 'GitHub PAT, OAuth token, or installation secret',
    regex: /\b(?:ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}|gho_[a-zA-Z0-9]{36}|ghs_[a-zA-Z0-9]{36})\b/g,
  },
  {
    id: 'slack_token',
    name: 'Slack Token',
    description: 'Slack Bot, User, or App Token',
    regex: /\bxox[baprs]-[0-9a-zA-Z]{10,48}\b/g,
  },
  {
    id: 'ai_api_key',
    name: 'AI Service API Key',
    description: 'OpenAI, Anthropic, or compatible AI API key',
    regex: /\b(?:sk-[a-zA-Z0-9]{20,60}|sk-ant-[a-zA-Z0-9]{20,60})\b/g,
  },
  {
    id: 'jwt_token',
    name: 'JSON Web Token (JWT)',
    description: 'Hard-coded JSON Web Token with claims and signature',
    regex: /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
  },
  {
    id: 'generic_credential',
    name: 'Hard-coded Credential Assignment',
    description: 'Hard-coded password, api_key or secret assignment in source code',
    regex: /(?:password|passwd|secret|api_key|apikey|private_key|token)\s*[:=]\s*['"][^'"\s]{8,}['"]/gi,
  },
];

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.turbo',
  '.cache',
]);

const IGNORED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.zip',
  '.tar',
  '.gz',
  '.db',
  '.sqlite',
  '.pdf',
  '.lock',
]);

const IGNORED_FILENAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  '.env.example',
  '.gitignore',
  'tsconfig.json',
]);

/**
 * Checks if a relative file path should be ignored during secret scanning.
 */
export function isIgnoredScanPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/');

  for (const seg of segments) {
    if (IGNORED_DIRECTORIES.has(seg)) {
      return true;
    }
  }

  const baseName = path.basename(normalized);
  if (IGNORED_FILENAMES.has(baseName)) {
    return true;
  }

  const ext = path.extname(normalized).toLowerCase();
  if (IGNORED_EXTENSIONS.has(ext)) {
    return true;
  }

  return false;
}

/**
 * Scans a text string (file content or diff) for secrets using the built-in rule set.
 * Masked previews and secret hashes are generated; plaintext secrets are never stored.
 */
export function scanTextForSecrets(
  content: string,
  filePath = '<content>',
  rules: SecretPatternRule[] = BUILTIN_SECRET_RULES,
): SecretFinding[] {
  if (!content || !content.trim()) return [];

  const findings: SecretFinding[] = [];
  const lines = content.split('\n');

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    const lineNumber = lineIndex + 1;

    for (const rule of rules) {
      // Reset regex index for global regexes
      rule.regex.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = rule.regex.exec(line)) !== null) {
        const rawSecret = match[0];
        const masked = maskSecret(rawSecret);
        const secretHash = hashSecret(rawSecret);

        findings.push({
          rule_id: rule.id,
          description: rule.description,
          file: filePath,
          line: lineNumber,
          match_preview: masked,
          secret_hash: secretHash,
        });

        // Avoid infinite loops with 0-length matches
        if (rule.regex.lastIndex === match.index) {
          rule.regex.lastIndex++;
        }
      }
    }
  }

  return findings;
}

/**
 * Parses Gitleaks JSON report output, masking all plaintext matches.
 */
export function parseGitleaksJson(jsonString: string): SecretFinding[] {
  if (!jsonString || !jsonString.trim()) return [];

  let rawList: unknown = null;
  try {
    rawList = JSON.parse(jsonString);
  } catch {
    const startIdx = jsonString.indexOf('[');
    const endIdx = jsonString.lastIndexOf(']');
    if (startIdx !== -1 && endIdx > startIdx) {
      try {
        rawList = JSON.parse(jsonString.slice(startIdx, endIdx + 1));
      } catch {
        return [];
      }
    }
  }

  if (!Array.isArray(rawList)) return [];

  const findings: SecretFinding[] = [];
  for (const item of rawList) {
    if (item && typeof item === 'object') {
      const g = item as Record<string, unknown>;
      const rawMatch = String(g.Match ?? g.Secret ?? '');
      const masked = maskSecret(rawMatch);
      const secretHash = rawMatch ? hashSecret(rawMatch) : undefined;
      const line = Number(g.StartLine ?? g.Line ?? 1);

      findings.push({
        rule_id: String(g.RuleID ?? g.rule_id ?? 'gitleaks-rule'),
        description: String(g.Description ?? 'Secret detected by Gitleaks'),
        file: String(g.File ?? g.file ?? '<unknown>'),
        line: line > 0 ? line : 1,
        match_preview: masked,
        secret_hash: secretHash,
        commit: g.Commit ? String(g.Commit) : undefined,
        author: g.Author ? String(g.Author) : undefined,
        date: g.Date ? String(g.Date) : undefined,
      });
    }
  }

  return findings;
}

export interface ScanDirectoryOptions {
  maxFiles?: number;
  maxFileSize?: number;
  rules?: SecretPatternRule[];
}

const DEFAULT_MAX_FILES = 2000;
const DEFAULT_MAX_FILE_SIZE = 1024 * 1024; // 1 MB

/**
 * Scans a directory tree on disk for secrets using the built-in scanner.
 */
export async function scanDirectoryForSecrets(
  dirPath: string,
  options: ScanDirectoryOptions = {},
): Promise<{ findings: SecretFinding[]; filesScanned: number }> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const rules = options.rules ?? BUILTIN_SECRET_RULES;

  const findings: SecretFinding[] = [];
  let filesScanned = 0;

  async function walk(currentDir: string): Promise<void> {
    if (filesScanned >= maxFiles) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (filesScanned >= maxFiles) break;

      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(dirPath, fullPath);

      if (isIgnoredScanPath(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.size > maxFileSize) {
            continue;
          }

          const content = await fs.promises.readFile(fullPath, 'utf8');
          filesScanned++;

          const fileFindings = scanTextForSecrets(content, relativePath, rules);
          findings.push(...fileFindings);
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await walk(dirPath);

  return { findings, filesScanned };
}
