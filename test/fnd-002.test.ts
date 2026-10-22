import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

describe('FND-002', () => {
  it('Root package.json defines scripts lint, typecheck, test', () => {
    const pkgPath = path.join(rootDir, 'package.json');
    expect(fs.existsSync(pkgPath)).toBe(true);
    const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(pkgJson.scripts).toBeDefined();
    expect(pkgJson.scripts?.lint).toBeDefined();
    expect(pkgJson.scripts?.typecheck).toBeDefined();
    expect(pkgJson.scripts?.test).toBeDefined();
  });

  it('Configuration files for ESLint, Prettier, and Vitest exist', () => {
    const eslintConfig = path.join(rootDir, 'eslint.config.mjs');
    const prettierConfig = path.join(rootDir, '.prettierrc');
    const prettierIgnore = path.join(rootDir, '.prettierignore');
    const vitestConfig = path.join(rootDir, 'vitest.config.ts');

    expect(fs.existsSync(eslintConfig)).toBe(true);
    expect(fs.existsSync(prettierConfig)).toBe(true);
    expect(fs.existsSync(prettierIgnore)).toBe(true);
    expect(fs.existsSync(vitestConfig)).toBe(true);
  });

  it('Prettier config contains standard formatting rules', () => {
    const prettierPath = path.join(rootDir, '.prettierrc');
    const prettierConfig = JSON.parse(fs.readFileSync(prettierPath, 'utf8')) as {
      semi?: boolean;
      singleQuote?: boolean;
    };
    expect(prettierConfig.semi).toBe(true);
    expect(prettierConfig.singleQuote).toBe(true);
  });

  it('All workspace packages have typecheck script', () => {
    const packages = ['apps/orchestrator', 'apps/dashboard', 'packages/shared', 'packages/db'];

    for (const pkg of packages) {
      const pkgPath = path.join(rootDir, pkg, 'package.json');
      const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      expect(pkgJson.scripts?.typecheck).toBe('tsc --noEmit');
    }
  });
});
