import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../errors.js';
import type { ParsedConfig } from '../parser/types.js';
import { normalizeQualityCommand } from './command-parser.js';
import {
  RepoQualityConfigSchema,
  type QualityCommandDefinition,
  type RepoQualityConfig,
  type RepoQualityConfigInput,
} from './types.js';

export interface ResolveRepoQualityConfigOptions {
  repoPath?: string;
  repoId?: string;
  workbookConfig?: ParsedConfig | null;
  taskTestCommands?: string[];
  overrides?: RepoQualityConfigInput | null;
}

/**
 * Detects the preferred Node package manager for a given directory.
 */
export function detectPackageManager(dir: string): 'pnpm' | 'yarn' | 'npm' | 'bun' {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) {
    return 'yarn';
  }
  if (fs.existsSync(path.join(dir, 'bun.lockb')) || fs.existsSync(path.join(dir, 'bun.lock'))) {
    return 'bun';
  }
  return 'npm';
}

/**
 * Auto-detects verification commands from package.json scripts.
 */
function detectFromPackageJson(
  pkgJsonPath: string,
  repoDir: string,
): Partial<RepoQualityConfigInput> | null {
  if (!fs.existsSync(pkgJsonPath)) {
    return null;
  }

  try {
    const rawContent = fs.readFileSync(pkgJsonPath, 'utf-8');
    const pkg = JSON.parse(rawContent) as {
      scripts?: Record<string, string>;
      qualityGate?: RepoQualityConfigInput;
      quality?: RepoQualityConfigInput;
      orchestrator?: { quality?: RepoQualityConfigInput };
    };

    // If explicit qualityGate or orchestrator.quality config exists in package.json, return it!
    if (pkg.qualityGate) {
      return pkg.qualityGate;
    }
    if (pkg.quality) {
      return pkg.quality;
    }
    if (pkg.orchestrator?.quality) {
      return pkg.orchestrator.quality;
    }

    const scripts = pkg.scripts || {};
    const pm = detectPackageManager(repoDir);
    const runPrefix = pm === 'npm' ? 'npm run ' : `${pm} `;

    const detected: Partial<RepoQualityConfigInput> = {};

    // format
    if (scripts['format:check']) {
      detected.format = `${runPrefix}format:check`;
    } else if (scripts['check:format']) {
      detected.format = `${runPrefix}check:format`;
    } else if (scripts['format']) {
      detected.format = `${runPrefix}format`;
    }

    // lint
    if (scripts['lint']) {
      detected.lint = `${runPrefix}lint`;
    }

    // typecheck
    if (scripts['typecheck']) {
      detected.typecheck = `${runPrefix}typecheck`;
    } else if (scripts['check-types']) {
      detected.typecheck = `${runPrefix}check-types`;
    }

    // test
    if (scripts['test']) {
      detected.test = pm === 'npm' ? 'npm test' : `${pm} test`;
    }

    // build
    if (scripts['build']) {
      detected.build = `${runPrefix}build`;
    }

    return detected;
  } catch (err) {
    throw new AppError(
      'INVALID_PACKAGE_JSON',
      `Failed to parse package.json at ${pkgJsonPath}: ${(err as Error).message}`,
      { pkgJsonPath },
    );
  }
}

/**
 * Attempts to read a JSON quality config file from standard repository locations:
 * 1. quality.json
 * 2. .quality.json
 * 3. .orchestrator/quality.json
 * 4. .orchestrator.json
 */
function readRepoConfigFile(repoDir: string): RepoQualityConfigInput | null {
  const candidateFiles = [
    path.join(repoDir, 'quality.json'),
    path.join(repoDir, '.quality.json'),
    path.join(repoDir, '.orchestrator', 'quality.json'),
    path.join(repoDir, '.orchestrator.json'),
  ];

  for (const filePath of candidateFiles) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content) as RepoQualityConfigInput;
      } catch (err) {
        throw new AppError(
          'INVALID_QUALITY_CONFIG_FILE',
          `Failed to parse quality config file at ${filePath}: ${(err as Error).message}`,
          { filePath },
        );
      }
    }
  }

  return null;
}

/**
 * Reads quality config from imported Workbook ParsedConfig (sheet 'Config').
 */
export function loadQualityConfigFromWorkbook(
  workbookConfig: ParsedConfig,
  repoDir?: string,
): Partial<RepoQualityConfigInput> {
  const result: Partial<RepoQualityConfigInput> = {};
  const settings = workbookConfig.settings ?? {};
  const raw = workbookConfig.raw ?? {};

  const findSetting = (keys: string[]): unknown => {
    for (const k of keys) {
      if (settings[k] !== undefined && settings[k] !== null && settings[k] !== '') {
        return settings[k];
      }
      if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') {
        return raw[k];
      }
    }
    return undefined;
  };

  // 1. Stage-specific commands from settings/raw
  const formatVal = findSetting(['format_command', 'format', 'format_check', 'lệnh format']);
  if (typeof formatVal === 'string' && formatVal.trim()) {
    result.format = formatVal.trim();
  }

  const lintVal = findSetting(['lint_command', 'lint', 'lệnh lint']);
  if (typeof lintVal === 'string' && lintVal.trim()) {
    result.lint = lintVal.trim();
  }

  const typecheckVal = findSetting([
    'typecheck_command',
    'typecheck',
    'tsc',
    'check_types',
    'lệnh typecheck',
  ]);
  if (typeof typecheckVal === 'string' && typecheckVal.trim()) {
    result.typecheck = typecheckVal.trim();
  }

  const testVal = findSetting(['test_command', 'test', 'tests', 'lệnh test']);
  if (typeof testVal === 'string' && testVal.trim()) {
    result.test = testVal.trim();
  }

  const buildVal = findSetting(['build_command', 'build', 'lệnh build']);
  if (typeof buildVal === 'string' && buildVal.trim()) {
    result.build = buildVal.trim();
  }

  // 2. verify_commands list mapping
  const verifyCommands = workbookConfig.verify_commands ?? [];
  if (verifyCommands.length > 0) {
    const customList: string[] = [];
    for (const cmdLine of verifyCommands) {
      const lower = cmdLine.toLowerCase();
      const isFormat = lower.includes('format') || lower.includes('prettier');
      const isLint = lower.includes('lint') || lower.includes('eslint');
      const isTypecheck =
        lower.includes('typecheck') || lower.includes('tsc') || lower.includes('check-types');
      const isTest = lower.includes('test') || lower.includes('vitest') || lower.includes('jest');
      const isBuild = lower.includes('build');

      if (isFormat) {
        if (!result.format) {
          result.format = cmdLine;
        }
      } else if (isLint) {
        if (!result.lint) {
          result.lint = cmdLine;
        }
      } else if (isTypecheck) {
        if (!result.typecheck) {
          result.typecheck = cmdLine;
        }
      } else if (isTest) {
        if (!result.test) {
          result.test = cmdLine;
        }
      } else if (isBuild) {
        if (!result.build) {
          result.build = cmdLine;
        }
      } else {
        customList.push(cmdLine);
      }
    }
    if (customList.length > 0) {
      result.custom_commands = customList;
    }
  }

  if (workbookConfig.repository && !repoDir) {
    result.repo_path = workbookConfig.repository;
  }

  return result;
}

/**
 * Loads and resolves the full repository quality configuration from all available sources:
 * 1. Direct explicit overrides
 * 2. Repository config files (quality.json, .orchestrator/quality.json)
 * 3. Repository package.json (qualityGate section or auto-detected scripts)
 * 4. Imported Workbook ParsedConfig (verify_commands & settings)
 * 5. Task-specific test_commands (overriding or supplementing test stage)
 */
export function resolveRepoQualityConfig(
  options: ResolveRepoQualityConfigOptions = {},
): RepoQualityConfig {
  const repoPath = options.repoPath ? path.resolve(options.repoPath) : process.cwd();
  const repoId = options.repoId;
  const overrides = options.overrides ?? {};

  // 1. Read from repo files if directory exists
  let fileConfig: RepoQualityConfigInput | null = null;
  let pkgConfig: Partial<RepoQualityConfigInput> | null = null;

  if (fs.existsSync(repoPath) && fs.statSync(repoPath).isDirectory()) {
    fileConfig = readRepoConfigFile(repoPath);
    pkgConfig = detectFromPackageJson(path.join(repoPath, 'package.json'), repoPath);
  }

  // 2. Read from workbook config if provided
  let workbookConfigData: Partial<RepoQualityConfigInput> | null = null;
  if (options.workbookConfig) {
    workbookConfigData = loadQualityConfigFromWorkbook(options.workbookConfig, repoPath);
  }

  // 3. Merge sources in increasing priority order:
  // package.json scripts (lowest) -> workbook -> repo file config -> overrides (highest)
  const merged: RepoQualityConfigInput = {
    repo_id: repoId ?? fileConfig?.repo_id ?? overrides.repo_id,
    repo_path: repoPath,
    format:
      overrides.format !== undefined
        ? overrides.format
        : fileConfig?.format !== undefined
          ? fileConfig.format
          : workbookConfigData?.format !== undefined
            ? workbookConfigData.format
            : pkgConfig?.format ?? null,
    lint:
      overrides.lint !== undefined
        ? overrides.lint
        : fileConfig?.lint !== undefined
          ? fileConfig.lint
          : workbookConfigData?.lint !== undefined
            ? workbookConfigData.lint
            : pkgConfig?.lint ?? null,
    typecheck:
      overrides.typecheck !== undefined
        ? overrides.typecheck
        : fileConfig?.typecheck !== undefined
          ? fileConfig.typecheck
          : workbookConfigData?.typecheck !== undefined
            ? workbookConfigData.typecheck
            : pkgConfig?.typecheck ?? null,
    test:
      overrides.test !== undefined
        ? overrides.test
        : fileConfig?.test !== undefined
          ? fileConfig.test
          : workbookConfigData?.test !== undefined
            ? workbookConfigData.test
            : pkgConfig?.test ?? null,
    build:
      overrides.build !== undefined
        ? overrides.build
        : fileConfig?.build !== undefined
          ? fileConfig.build
          : workbookConfigData?.build !== undefined
            ? workbookConfigData.build
            : pkgConfig?.build ?? null,
    stop_on_first_failure:
      overrides.stop_on_first_failure ??
      fileConfig?.stop_on_first_failure ??
      workbookConfigData?.stop_on_first_failure ??
      true,
    default_timeout_ms:
      overrides.default_timeout_ms ??
      fileConfig?.default_timeout_ms ??
      workbookConfigData?.default_timeout_ms ??
      120_000,
  };

  // 4. If taskTestCommands provided and non-empty, override or specify the test stage!
  if (options.taskTestCommands && options.taskTestCommands.length > 0) {
    // If single command, map directly to test stage; if multiple, first goes to test stage and rest to custom
    merged.test = options.taskTestCommands[0];
  }

  // 5. Normalize individual stages into QualityCommandDefinition
  const defaultTimeoutMs = merged.default_timeout_ms ?? 120_000;
  const normOptions = { cwd: repoPath, defaultTimeoutMs };

  const formatCmd = normalizeQualityCommand('format', merged.format, normOptions);
  const lintCmd = normalizeQualityCommand('lint', merged.lint, normOptions);
  const typecheckCmd = normalizeQualityCommand('typecheck', merged.typecheck, normOptions);
  const testCmd = normalizeQualityCommand('test', merged.test, normOptions);
  const buildCmd = normalizeQualityCommand('build', merged.build, normOptions);

  // 6. Custom commands normalization
  const customCommandsList: QualityCommandDefinition[] = [];

  // From file config
  if (fileConfig?.custom_commands && Array.isArray(fileConfig.custom_commands)) {
    for (const c of fileConfig.custom_commands) {
      const norm = normalizeQualityCommand('custom', c, normOptions);
      if (norm) customCommandsList.push(norm);
    }
  }

  // From workbook
  if (
    workbookConfigData?.custom_commands &&
    Array.isArray(workbookConfigData.custom_commands)
  ) {
    for (const c of workbookConfigData.custom_commands) {
      const norm = normalizeQualityCommand('custom', c, normOptions);
      if (norm) customCommandsList.push(norm);
    }
  }

  // From overrides
  if (overrides.custom_commands && Array.isArray(overrides.custom_commands)) {
    for (const c of overrides.custom_commands) {
      const norm = normalizeQualityCommand('custom', c, normOptions);
      if (norm) customCommandsList.push(norm);
    }
  }

  // Additional taskTestCommands beyond index 0
  if (options.taskTestCommands && options.taskTestCommands.length > 1) {
    for (let i = 1; i < options.taskTestCommands.length; i++) {
      const norm = normalizeQualityCommand('custom', options.taskTestCommands[i], {
        cwd: repoPath,
        defaultTimeoutMs,
      });
      if (norm) {
        norm.name = `Task test command #${i + 1}`;
        customCommandsList.push(norm);
      }
    }
  }

  const resolved = {
    repo_id: merged.repo_id,
    repo_path: repoPath,
    format: formatCmd,
    lint: lintCmd,
    typecheck: typecheckCmd,
    test: testCmd,
    build: buildCmd,
    custom_commands: customCommandsList,
    stop_on_first_failure: merged.stop_on_first_failure ?? true,
    default_timeout_ms: defaultTimeoutMs,
  };

  return RepoQualityConfigSchema.parse(resolved);
}
