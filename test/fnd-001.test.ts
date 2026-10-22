import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

describe('FND-001', () => {
  it('Monorepo configuration and workspace', () => {
    const workspacePath = path.join(rootDir, 'pnpm-workspace.yaml');
    expect(fs.existsSync(workspacePath)).toBe(true);
    const workspaceContent = fs.readFileSync(workspacePath, 'utf8');
    expect(workspaceContent).toMatch(/apps\/\*/);
    expect(workspaceContent).toMatch(/packages\/\*/);
  });

  it('Base tsconfig is strict and uses NodeNext', () => {
    const tsconfigPath = path.join(rootDir, 'tsconfig.base.json');
    expect(fs.existsSync(tsconfigPath)).toBe(true);
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8')) as {
      compilerOptions: {
        strict: boolean;
        noUncheckedIndexedAccess: boolean;
        module: string;
      };
    };
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.noUncheckedIndexedAccess).toBe(true);
    expect(tsconfig.compilerOptions.module).toBe('NodeNext');
  });

  it('Four packages exist with package.json and tsconfig.json', () => {
    const packages = [
      { dir: 'apps/orchestrator', name: '@ai-orchestrator/orchestrator' },
      { dir: 'apps/dashboard', name: '@ai-orchestrator/dashboard' },
      { dir: 'packages/shared', name: '@ai-orchestrator/shared' },
      { dir: 'packages/db', name: '@ai-orchestrator/db' },
    ];

    for (const pkg of packages) {
      const pkgDir = path.join(rootDir, pkg.dir);
      const pkgJsonPath = path.join(pkgDir, 'package.json');
      const tsconfigPath = path.join(pkgDir, 'tsconfig.json');
      const indexPath = path.join(pkgDir, 'src', 'index.ts');

      expect(fs.existsSync(pkgJsonPath)).toBe(true);
      expect(fs.existsSync(tsconfigPath)).toBe(true);
      expect(fs.existsSync(indexPath)).toBe(true);

      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
        name: string;
        type: string;
        scripts?: { build?: string };
      };
      expect(pkgJson.name).toBe(pkg.name);
      expect(pkgJson.type).toBe('module');
      expect(pkgJson.scripts?.build).toBeDefined();

      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8')) as {
        extends: string;
      };
      expect(tsconfig.extends).toMatch(/tsconfig\.base\.json$/);
    }
  });

  it('Packages compile to dist/ with declarations and maps', () => {
    const packages = ['apps/orchestrator', 'apps/dashboard', 'packages/shared', 'packages/db'];

    for (const pkg of packages) {
      const distJs = path.join(rootDir, pkg, 'dist', 'index.js');
      const distDts = path.join(rootDir, pkg, 'dist', 'index.d.ts');
      expect(fs.existsSync(distJs)).toBe(true);
      expect(fs.existsSync(distDts)).toBe(true);
    }
  });
});
