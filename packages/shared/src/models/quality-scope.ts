import { z } from 'zod';

export const ScopeDiffFileStatusSchema = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'untracked',
]);

export type ScopeDiffFileStatus = z.infer<typeof ScopeDiffFileStatusSchema>;

export const FileDiffDetailSchema = z.object({
  path: z.string().min(1, 'File path cannot be empty'),
  oldPath: z.string().optional(),
  status: ScopeDiffFileStatusSchema,
  additions: z.number().int().min(0).default(0),
  deletions: z.number().int().min(0).default(0),
  patch: z.string().default(''),
  inScope: z.boolean().default(true),
});

export type FileDiffDetail = z.infer<typeof FileDiffDetailSchema>;

export const ScopeDiffStatsSchema = z.object({
  totalChanged: z.number().int().min(0).default(0),
  inScopeCount: z.number().int().min(0).default(0),
  outOfScopeCount: z.number().int().min(0).default(0),
  additions: z.number().int().min(0).default(0),
  deletions: z.number().int().min(0).default(0),
});

export type ScopeDiffStats = z.infer<typeof ScopeDiffStatsSchema>;

export const ScopeDiffResultSchema = z.object({
  taskId: z.string().nullable().optional(),
  repoPath: z.string(),
  baseRef: z.string().nullable().optional(),
  targetRef: z.string().nullable().optional(),
  scopeFiles: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  inScopeFiles: z.array(z.string()).default([]),
  outOfScopeFiles: z.array(z.string()).default([]), // Danh sách các file ngoài phạm vi (file lạ)
  isScopeClean: z.boolean().default(true),
  stats: ScopeDiffStatsSchema,
  fileDiffs: z.array(FileDiffDetailSchema).default([]),
  rawDiff: z.string().default(''),
});

export type ScopeDiffResult = z.infer<typeof ScopeDiffResultSchema>;

export const TaskDiffDataSchema = z.object({
  taskId: z.string(),
  repoPath: z.string(),
  scopeFiles: z.array(z.string()).default([]),
  isScopeClean: z.boolean().default(true),
  outOfScopeFiles: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  fileDiffs: z.array(FileDiffDetailSchema).default([]),
  rawDiff: z.string().default(''),
  stats: ScopeDiffStatsSchema.optional(),
});

export type TaskDiffData = z.infer<typeof TaskDiffDataSchema>;

export const CompareScopeInputSchema = z.object({
  repoPath: z.string().optional(),
  taskId: z.string().optional(),
  scopeFiles: z.array(z.string()).optional(),
  baseRef: z.string().optional(),
  targetRef: z.string().optional(),
  includeUntracked: z.boolean().optional().default(true),
  runId: z.string().optional(),
});

export type CompareScopeInput = z.input<typeof CompareScopeInputSchema>;

export interface ParsedDiffLine {
  type: 'add' | 'delete' | 'chunk' | 'header' | 'context';
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/**
 * Parses raw unified patch into structured lines with line numbers and line types.
 */
export function parsePatchLines(patch: string): ParsedDiffLine[] {
  if (!patch) return [];

  const lines = patch.split(/\r?\n/);
  const result: ParsedDiffLine[] = [];

  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match && match[1] && match[2]) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      result.push({
        type: 'chunk',
        text: line,
      });
    } else if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename from') ||
      line.startsWith('rename to')
    ) {
      result.push({
        type: 'header',
        text: line,
      });
    } else if (line.startsWith('+')) {
      result.push({
        type: 'add',
        text: line,
        newLineNumber: newLine++,
      });
    } else if (line.startsWith('-')) {
      result.push({
        type: 'delete',
        text: line,
        oldLineNumber: oldLine++,
      });
    } else {
      result.push({
        type: 'context',
        text: line,
        oldLineNumber: oldLine++,
        newLineNumber: newLine++,
      });
    }
  }

  return result;
}

/**
 * Normalizes file path for consistent matching across POSIX and Windows.
 * Removes leading './', converts backslashes to slashes, collapses multiple slashes.
 */
export function normalizeScopePath(filePath: string): string {
  let normalized = filePath.trim().replace(/\\/g, '/');
  // Strip leading ./
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  // Strip leading /
  if (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }
  // Collapse double slashes
  normalized = normalized.replace(/\/+/g, '/');
  return normalized;
}

/**
 * Converts a glob/wildcard pattern (e.g. `src/**\/*.ts`, `packages/db/*`, `*.json`)
 * into a regular expression.
 */
function globToRegex(pattern: string): RegExp {
  let normalized = normalizeScopePath(pattern);
  // If pattern ends with '/', treat as directory prefix matching everything under it
  if (normalized.endsWith('/')) {
    normalized += '**';
  }

  let regexStr = '^';
  let i = 0;
  while (i < normalized.length) {
    const char = normalized[i];
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        // '**' matches any character including '/'
        if (normalized[i + 2] === '/') {
          regexStr += '(?:.*/)?';
          i += 3;
          continue;
        } else {
          regexStr += '.*';
          i += 2;
          continue;
        }
      } else {
        // '*' matches any character except '/'
        regexStr += '[^/]*';
        i++;
        continue;
      }
    } else if (char === '?') {
      regexStr += '[^/]';
      i++;
      continue;
    } else if (['.', '+', '^', '$', '(', ')', '[', ']', '{', '}', '|', '\\'].includes(char!)) {
      regexStr += `\\${char}`;
      i++;
      continue;
    } else {
      regexStr += char;
      i++;
    }
  }
  regexStr += '$';
  return new RegExp(regexStr);
}

/**
 * Checks if a given file path is permitted within the defined scope patterns.
 * Supports exact paths, directory prefixes, and glob wildcards (*, **).
 */
export function isPathInScope(filePath: string, scopePatterns: string[]): boolean {
  if (scopePatterns.length === 0) {
    return false;
  }

  const normalizedFile = normalizeScopePath(filePath);

  for (const rawPattern of scopePatterns) {
    const pattern = normalizeScopePath(rawPattern);
    if (!pattern) continue;

    // 1. Exact match
    if (normalizedFile === pattern) {
      return true;
    }

    // 2. Directory prefix match (e.g., "src/" or "packages/db")
    if (pattern.endsWith('/')) {
      if (normalizedFile.startsWith(pattern)) {
        return true;
      }
    } else if (normalizedFile.startsWith(`${pattern}/`)) {
      return true;
    }

    // 3. Glob matching if wildcard exists
    if (pattern.includes('*') || pattern.includes('?')) {
      try {
        const regex = globToRegex(pattern);
        if (regex.test(normalizedFile)) {
          return true;
        }
      } catch {
        // Fallback to substring match if regex construction fails
        if (normalizedFile.includes(pattern.replace(/[*?]/g, ''))) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Evaluates scope compliance for a list of changed files against scope patterns.
 * Identifies exact out-of-scope files ("file lạ") and compiles comprehensive metrics.
 */
export function evaluateScopeCompliance(options: {
  changedFiles: string[];
  scopeFiles: string[];
  fileDiffs?: FileDiffDetail[];
  rawDiff?: string;
  taskId?: string | null;
  repoPath?: string;
  baseRef?: string | null;
  targetRef?: string | null;
}): ScopeDiffResult {
  const {
    changedFiles,
    scopeFiles,
    fileDiffs: inputDiffs = [],
    rawDiff = '',
    taskId = null,
    repoPath = '.',
    baseRef = null,
    targetRef = null,
  } = options;

  const inScopeFiles: string[] = [];
  const outOfScopeFiles: string[] = [];

  const uniqueChanged = Array.from(new Set(changedFiles.map(normalizeScopePath))).sort();

  for (const file of uniqueChanged) {
    if (isPathInScope(file, scopeFiles)) {
      inScopeFiles.push(file);
    } else {
      outOfScopeFiles.push(file);
    }
  }

  // Update inScope on individual file diff details
  const fileDiffs: FileDiffDetail[] = [];
  const diffsByPath = new Map<string, FileDiffDetail>();
  for (const diff of inputDiffs) {
    const norm = normalizeScopePath(diff.path);
    diffsByPath.set(norm, {
      ...diff,
      path: norm,
      inScope: isPathInScope(norm, scopeFiles),
    });
  }

  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const file of uniqueChanged) {
    const existing = diffsByPath.get(file);
    if (existing) {
      fileDiffs.push(existing);
      totalAdditions += existing.additions;
      totalDeletions += existing.deletions;
    } else {
      const inScope = isPathInScope(file, scopeFiles);
      fileDiffs.push({
        path: file,
        status: 'modified',
        additions: 0,
        deletions: 0,
        patch: '',
        inScope,
      });
    }
  }

  const isScopeClean = outOfScopeFiles.length === 0;

  return ScopeDiffResultSchema.parse({
    taskId,
    repoPath,
    baseRef,
    targetRef,
    scopeFiles,
    changedFiles: uniqueChanged,
    inScopeFiles,
    outOfScopeFiles,
    isScopeClean,
    stats: {
      totalChanged: uniqueChanged.length,
      inScopeCount: inScopeFiles.length,
      outOfScopeCount: outOfScopeFiles.length,
      additions: totalAdditions,
      deletions: totalDeletions,
    },
    fileDiffs,
    rawDiff,
  });
}

/**
 * Parses raw unified diff text into individual per-file diff structures.
 */
export function parseUnifiedDiff(rawDiff: string): FileDiffDetail[] {
  if (!rawDiff || !rawDiff.trim()) {
    return [];
  }

  const results: FileDiffDetail[] = [];
  const lines = rawDiff.split(/\r?\n/);

  let currentDiff: Partial<FileDiffDetail> | null = null;
  let patchLines: string[] = [];

  const flushCurrent = () => {
    if (currentDiff && currentDiff.path) {
      results.push({
        path: normalizeScopePath(currentDiff.path),
        oldPath: currentDiff.oldPath ? normalizeScopePath(currentDiff.oldPath) : undefined,
        status: currentDiff.status ?? 'modified',
        additions: currentDiff.additions ?? 0,
        deletions: currentDiff.deletions ?? 0,
        patch: patchLines.join('\n'),
        inScope: true,
      });
    }
    currentDiff = null;
    patchLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith('diff --git ')) {
      flushCurrent();

      // Example: diff --git a/path/to/file b/path/to/file
      const parts = line.slice('diff --git '.length).trim();
      const match = parts.match(/^a\/(.*?)\s+b\/(.*?)$/);
      let targetPath: string;
      let oldPath: string | undefined;

      if (match && match[1] && match[2]) {
        oldPath = match[1];
        targetPath = match[2];
      } else {
        const tokens = parts.split(' ');
        targetPath = tokens[tokens.length - 1]?.replace(/^b\//, '') ?? '';
      }

      currentDiff = {
        path: targetPath,
        oldPath,
        status: 'modified',
        additions: 0,
        deletions: 0,
      };
      patchLines.push(line);
      continue;
    }

    if (!currentDiff) {
      continue;
    }

    patchLines.push(line);

    if (line.startsWith('new file mode ')) {
      currentDiff.status = 'added';
    } else if (line.startsWith('deleted file mode ')) {
      currentDiff.status = 'deleted';
    } else if (line.startsWith('rename from ')) {
      currentDiff.status = 'renamed';
      currentDiff.oldPath = line.slice('rename from '.length).trim();
    } else if (line.startsWith('rename to ')) {
      currentDiff.status = 'renamed';
      currentDiff.path = line.slice('rename to '.length).trim();
    } else if (line.startsWith('+++ b/')) {
      const explicitPath = line.slice('+++ b/'.length).trim();
      if (explicitPath && explicitPath !== '/dev/null') {
        currentDiff.path = explicitPath;
      }
    } else if (line.startsWith('--- a/')) {
      const explicitOldPath = line.slice('--- a/'.length).trim();
      if (explicitOldPath && explicitOldPath !== '/dev/null') {
        currentDiff.oldPath = explicitOldPath;
      }
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      currentDiff.additions = (currentDiff.additions ?? 0) + 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      currentDiff.deletions = (currentDiff.deletions ?? 0) + 1;
    }
  }

  flushCurrent();
  return results;
}
