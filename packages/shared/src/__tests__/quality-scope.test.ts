import { describe, it, expect } from 'vitest';
import {
  normalizeScopePath,
  isPathInScope,
  evaluateScopeCompliance,
  parseUnifiedDiff,
  type FileDiffDetail,
} from '../models/quality-scope.js';

describe('QLT-003: Quality Scope Diff & Alien File Detection (Unit Tests)', () => {
  describe('normalizeScopePath', () => {
    it('normalizes paths with leading ./, slashes, and backslashes', () => {
      expect(normalizeScopePath('./src/index.ts')).toBe('src/index.ts');
      expect(normalizeScopePath('.\\src\\models\\task.ts')).toBe('src/models/task.ts');
      expect(normalizeScopePath('/packages/db/src/repo.ts')).toBe('packages/db/src/repo.ts');
      expect(normalizeScopePath('packages//shared///index.ts')).toBe('packages/shared/index.ts');
    });
  });

  describe('isPathInScope', () => {
    it('matches exact file paths', () => {
      const scope = ['packages/shared/src/models/task.ts', 'packages/db/src/repo.ts'];
      expect(isPathInScope('packages/shared/src/models/task.ts', scope)).toBe(true);
      expect(isPathInScope('./packages/shared/src/models/task.ts', scope)).toBe(true);
      expect(isPathInScope('packages/shared/src/other.ts', scope)).toBe(false);
    });

    it('matches directory prefix patterns', () => {
      const scope = ['packages/db/', 'apps/orchestrator/src/services'];
      expect(isPathInScope('packages/db/migrations/001.sql', scope)).toBe(true);
      expect(isPathInScope('packages/db/src/index.ts', scope)).toBe(true);
      expect(isPathInScope('apps/orchestrator/src/services/quality.ts', scope)).toBe(true);
      expect(isPathInScope('apps/orchestrator/src/routes/quality.ts', scope)).toBe(false);
      expect(isPathInScope('packages/shared/src/git.ts', scope)).toBe(false);
    });

    it('matches glob wildcards (* and **)', () => {
      const scope = ['src/*.ts', 'packages/**/__tests__/*.test.ts', '*.md'];
      // Single *
      expect(isPathInScope('src/index.ts', scope)).toBe(true);
      expect(isPathInScope('src/nested/index.ts', scope)).toBe(false);

      // Recursive **
      expect(isPathInScope('packages/db/__tests__/repo.test.ts', scope)).toBe(true);
      expect(isPathInScope('packages/shared/src/__tests__/git.test.ts', scope)).toBe(true);
      expect(isPathInScope('packages/db/src/repo.ts', scope)).toBe(false);

      // Root wildcard
      expect(isPathInScope('README.md', scope)).toBe(true);
      expect(isPathInScope('ROADMAP.md', scope)).toBe(true);
      expect(isPathInScope('docs/guide.md', scope)).toBe(false);
    });

    it('returns false for empty scope patterns', () => {
      expect(isPathInScope('src/index.ts', [])).toBe(false);
    });
  });

  describe('evaluateScopeCompliance', () => {
    it('detects clean scope when all changed files are within scope', () => {
      const scopeFiles = ['src/auth.ts', 'src/users.ts'];
      const changedFiles = ['src/auth.ts', './src/users.ts'];

      const result = evaluateScopeCompliance({
        changedFiles,
        scopeFiles,
        taskId: 'TASK-101',
      });

      expect(result.isScopeClean).toBe(true);
      expect(result.outOfScopeFiles).toEqual([]);
      expect(result.inScopeFiles).toEqual(['src/auth.ts', 'src/users.ts']);
      expect(result.stats.totalChanged).toBe(2);
      expect(result.stats.inScopeCount).toBe(2);
      expect(result.stats.outOfScopeCount).toBe(0);
    });

    it('báo đúng file lạ khi có file thay đổi ngoài phạm vi task', () => {
      const scopeFiles = ['packages/db/src/task-repo.ts', 'packages/db/migrations/007_scope.sql'];
      const changedFiles = [
        'packages/db/src/task-repo.ts',
        'packages/db/migrations/007_scope.sql',
        'apps/dashboard/src/app.tsx', // File lạ 1
        'secrets.env', // File lạ 2
      ];

      const result = evaluateScopeCompliance({
        changedFiles,
        scopeFiles,
        taskId: 'TASK-ALIEN',
      });

      expect(result.isScopeClean).toBe(false);
      // Tiêu chí cốt lõi: Báo đúng file lạ
      expect(result.outOfScopeFiles).toEqual(['apps/dashboard/src/app.tsx', 'secrets.env']);
      expect(result.inScopeFiles).toEqual([
        'packages/db/migrations/007_scope.sql',
        'packages/db/src/task-repo.ts',
      ]);
      expect(result.stats.totalChanged).toBe(4);
      expect(result.stats.inScopeCount).toBe(2);
      expect(result.stats.outOfScopeCount).toBe(2);
    });

    it('updates inScope status and calculates total additions/deletions on file diffs', () => {
      const scopeFiles = ['src/allowed.ts'];
      const fileDiffs: FileDiffDetail[] = [
        {
          path: 'src/allowed.ts',
          status: 'modified',
          additions: 15,
          deletions: 3,
          patch: '@@ -1 +1 @@',
          inScope: true,
        },
        {
          path: 'src/unauthorized.ts',
          status: 'added',
          additions: 40,
          deletions: 0,
          patch: '@@ -0 +1,40 @@',
          inScope: true,
        },
      ];

      const result = evaluateScopeCompliance({
        changedFiles: ['src/allowed.ts', 'src/unauthorized.ts'],
        scopeFiles,
        fileDiffs,
      });

      expect(result.isScopeClean).toBe(false);
      expect(result.outOfScopeFiles).toEqual(['src/unauthorized.ts']);
      expect(result.stats.additions).toBe(55);
      expect(result.stats.deletions).toBe(3);

      const allowedDetail = result.fileDiffs.find((f) => f.path === 'src/allowed.ts');
      const unauthDetail = result.fileDiffs.find((f) => f.path === 'src/unauthorized.ts');

      expect(allowedDetail?.inScope).toBe(true);
      expect(unauthDetail?.inScope).toBe(false);
    });
  });

  describe('parseUnifiedDiff', () => {
    it('returns empty array for empty diff string', () => {
      expect(parseUnifiedDiff('')).toEqual([]);
      expect(parseUnifiedDiff('   \n  ')).toEqual([]);
    });

    it('correctly parses additions, deletions, and paths from unified diff', () => {
      const sampleDiff = `diff --git a/src/index.ts b/src/index.ts
index e69de29..495992f 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,5 @@
 import express from 'express';
+import cors from 'cors';
+const port = 3000;
-console.log('old');
+console.log('new');
diff --git a/src/new-file.ts b/src/new-file.ts
new file mode 100644
--- /dev/null
+++ b/src/new-file.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
diff --git a/src/old-file.ts b/src/old-file.ts
deleted file mode 100644
--- a/src/old-file.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const deprecated = true;
-export const dead = true;
`;

      const diffs = parseUnifiedDiff(sampleDiff);
      expect(diffs).toHaveLength(3);

      // File 1: modified
      expect(diffs[0]?.path).toBe('src/index.ts');
      expect(diffs[0]?.status).toBe('modified');
      expect(diffs[0]?.additions).toBe(3);
      expect(diffs[0]?.deletions).toBe(1);

      // File 2: new file
      expect(diffs[1]?.path).toBe('src/new-file.ts');
      expect(diffs[1]?.status).toBe('added');
      expect(diffs[1]?.additions).toBe(2);
      expect(diffs[1]?.deletions).toBe(0);

      // File 3: deleted file
      expect(diffs[2]?.path).toBe('src/old-file.ts');
      expect(diffs[2]?.status).toBe('deleted');
      expect(diffs[2]?.additions).toBe(0);
      expect(diffs[2]?.deletions).toBe(2);
    });

    it('handles renamed files', () => {
      const renameDiff = `diff --git a/old-name.ts b/new-name.ts
similarity index 95%
rename from old-name.ts
rename to new-name.ts
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,1 +1,1 @@
-hello
+world
`;

      const diffs = parseUnifiedDiff(renameDiff);
      expect(diffs).toHaveLength(1);
      expect(diffs[0]?.path).toBe('new-name.ts');
      expect(diffs[0]?.oldPath).toBe('old-name.ts');
      expect(diffs[0]?.status).toBe('renamed');
      expect(diffs[0]?.additions).toBe(1);
      expect(diffs[0]?.deletions).toBe(1);
    });
  });
});
