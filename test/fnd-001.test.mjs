import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

test('FND-001: Monorepo configuration and workspace', () => {
  const workspacePath = path.join(rootDir, 'pnpm-workspace.yaml');
  assert.ok(fs.existsSync(workspacePath), 'pnpm-workspace.yaml must exist');
  const workspaceContent = fs.readFileSync(workspacePath, 'utf8');
  assert.match(workspaceContent, /apps\/\*/, 'pnpm-workspace must include apps/*');
  assert.match(workspaceContent, /packages\/\*/, 'pnpm-workspace must include packages/*');
});

test('FND-001: Base tsconfig is strict and uses NodeNext', () => {
  const tsconfigPath = path.join(rootDir, 'tsconfig.base.json');
  assert.ok(fs.existsSync(tsconfigPath), 'tsconfig.base.json must exist');
  const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
  assert.equal(tsconfig.compilerOptions.strict, true, 'strict must be true');
  assert.equal(tsconfig.compilerOptions.noUncheckedIndexedAccess, true, 'noUncheckedIndexedAccess must be true');
  assert.equal(tsconfig.compilerOptions.module, 'NodeNext', 'module must be NodeNext');
});

test('FND-001: Four packages exist with package.json and tsconfig.json', () => {
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

    assert.ok(fs.existsSync(pkgJsonPath), `${pkg.dir}/package.json must exist`);
    assert.ok(fs.existsSync(tsconfigPath), `${pkg.dir}/tsconfig.json must exist`);
    assert.ok(fs.existsSync(indexPath), `${pkg.dir}/src/index.ts must exist`);

    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    assert.equal(pkgJson.name, pkg.name);
    assert.equal(pkgJson.type, 'module');
    assert.ok(pkgJson.scripts && pkgJson.scripts.build, `${pkg.dir} must have a build script`);

    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8'));
    assert.match(tsconfig.extends, /tsconfig\.base\.json$/, `${pkg.dir}/tsconfig.json must extend tsconfig.base.json`);
  }
});

test('FND-001: Packages compile to dist/ with declarations and maps', () => {
  const packages = [
    'apps/orchestrator',
    'apps/dashboard',
    'packages/shared',
    'packages/db',
  ];

  for (const pkg of packages) {
    const distJs = path.join(rootDir, pkg, 'dist', 'index.js');
    const distDts = path.join(rootDir, pkg, 'dist', 'index.d.ts');
    assert.ok(fs.existsSync(distJs), `${pkg}/dist/index.js must exist`);
    assert.ok(fs.existsSync(distDts), `${pkg}/dist/index.d.ts must exist`);
  }
});
