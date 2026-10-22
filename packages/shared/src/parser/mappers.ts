import {
  TASK_HEADER_ALIASES,
  FEATURE_HEADER_ALIASES,
  CONFIG_HEADER_ALIASES,
  normalizeHeader,
  parseString,
  parseNumber,
  parseIdList,
  parseMultilineList,
  type ParsedTaskRow,
  type ParsedFeatureRow,
  type ParsedConfig,
} from './types.js';
import { TASK_STATUSES, type TaskStatus } from '../models/task.js';
import { FEATURE_STATUSES, type FeatureStatus } from '../models/feature.js';

function matchHeader(key: string, aliasMap: Record<string, string>): string {
  const norm = normalizeHeader(key);
  if (aliasMap[norm]) {
    return aliasMap[norm];
  }
  const cleanKey = norm.replace(/\s+/g, '_');
  if (aliasMap[cleanKey]) {
    return aliasMap[cleanKey];
  }
  return cleanKey;
}

export function canonicalizeRow(
  raw: Record<string, unknown>,
  aliasMap: Record<string, string>,
): Record<string, unknown> {
  const canonical: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const matched = matchHeader(key, aliasMap);
    canonical[matched] = value;
  }
  return canonical;
}

export function mapTaskRow(raw: Record<string, unknown>, rowNumber: number): ParsedTaskRow {
  const c = canonicalizeRow(raw, TASK_HEADER_ALIASES);

  const id = parseString(c['id'], '') ?? '';
  const featureId = parseString(c['feature_id'], null);
  const title = parseString(c['title'], '') ?? '';
  const description = parseString(c['description'], null);
  const phase = parseString(c['phase'], null);
  const workerType = parseString(c['worker_type'], 'agy') ?? 'agy';
  const repository = parseString(c['repository'], '.') ?? '.';
  const acceptanceCriteria = parseMultilineList(c['acceptance_criteria']);
  const testCommands = parseMultilineList(c['test_commands']);
  const priority = parseNumber(c['priority'], 0);
  const maxAttempts = Math.max(1, parseNumber(c['max_attempts'], 3));
  const timeoutMinutes = Math.max(1, parseNumber(c['timeout_minutes'], 30));
  const dependencies = parseIdList(c['dependencies']);

  let status: TaskStatus = 'TODO';
  const rawStatus = parseString(c['status'], null)?.toUpperCase();
  if (rawStatus && (TASK_STATUSES as readonly string[]).includes(rawStatus)) {
    status = rawStatus as TaskStatus;
  }

  return {
    id,
    feature_id: featureId,
    title,
    description,
    phase,
    worker_type: workerType,
    repository,
    acceptance_criteria: acceptanceCriteria,
    test_commands: testCommands,
    priority,
    max_attempts: maxAttempts,
    timeout_minutes: timeoutMinutes,
    dependencies,
    status,
    rowNumber,
    raw,
  };
}

export function mapFeatureRow(raw: Record<string, unknown>, rowNumber: number): ParsedFeatureRow {
  const c = canonicalizeRow(raw, FEATURE_HEADER_ALIASES);

  const id = parseString(c['id'], '') ?? '';
  const name = parseString(c['name'], '') ?? '';
  const description = parseString(c['description'], null);
  const requiredTasks = parseIdList(c['required_tasks']);
  const integrationTests = parseMultilineList(c['integration_tests']);
  const releasePolicy = parseString(c['release_policy'], null);

  let status: FeatureStatus = 'TODO';
  const rawStatus = parseString(c['status'], null)?.toUpperCase();
  if (rawStatus && (FEATURE_STATUSES as readonly string[]).includes(rawStatus)) {
    status = rawStatus as FeatureStatus;
  }

  return {
    id,
    name,
    description,
    required_tasks: requiredTasks,
    integration_tests: integrationTests,
    release_policy: releasePolicy,
    status,
    rowNumber,
    raw,
  };
}

export function mapConfigRows(rawRows: Array<{ rowNumber: number; data: Record<string, unknown> }>): ParsedConfig {
  const combinedRaw: Record<string, unknown> = {};
  const settings: Record<string, unknown> = {};

  if (rawRows.length === 0) {
    return {
      repository: '.',
      agy_bin: 'agy',
      agy_args: '-p',
      verify_commands: [],
      max_attempts: 3,
      timeout_minutes: 30,
      max_concurrency: 1,
      settings: {},
      raw: {},
    };
  }

  // Check if first row has key/value columns
  const firstRow = rawRows[0];
  if (!firstRow) {
    return {
      repository: '.',
      agy_bin: 'agy',
      agy_args: '-p',
      verify_commands: [],
      max_attempts: 3,
      timeout_minutes: 30,
      max_concurrency: 1,
      settings: {},
      raw: {},
    };
  }

  const firstCanon = canonicalizeRow(firstRow.data, CONFIG_HEADER_ALIASES);
  const isKeyValueFormat = 'key' in firstCanon && 'value' in firstCanon;

  if (isKeyValueFormat) {
    for (const r of rawRows) {
      const canon = canonicalizeRow(r.data, CONFIG_HEADER_ALIASES);
      const key = parseString(canon['key'], null);
      if (key) {
        const val = canon['value'];
        combinedRaw[key] = val;
      }
    }
  } else {
    // Horizontal row format (first row contains config keys as column headers)
    for (const r of rawRows) {
      for (const [key, value] of Object.entries(r.data)) {
        if (value !== null && value !== undefined && value !== '') {
          combinedRaw[key] = value;
        }
      }
    }
  }

  const canon = canonicalizeRow(combinedRaw, {
    repository: 'repository',
    repo: 'repository',
    agy_bin: 'agy_bin',
    agybin: 'agy_bin',
    'agy bin': 'agy_bin',
    agy_args: 'agy_args',
    agyargs: 'agy_args',
    'agy args': 'agy_args',
    verify_commands: 'verify_commands',
    verify_command: 'verify_commands',
    'verify commands': 'verify_commands',
    quality_commands: 'verify_commands',
    'lệnh kiểm định': 'verify_commands',
    max_attempts: 'max_attempts',
    maxattempts: 'max_attempts',
    'max attempts': 'max_attempts',
    timeout_minutes: 'timeout_minutes',
    timeout: 'timeout_minutes',
    'timeout minutes': 'timeout_minutes',
    max_concurrency: 'max_concurrency',
    concurrency: 'max_concurrency',
  });

  const repository = parseString(canon['repository'], '.') ?? '.';
  const agyBin = parseString(canon['agy_bin'], 'agy') ?? 'agy';
  const agyArgs = parseString(canon['agy_args'], '-p') ?? '-p';
  const verifyCommands = parseMultilineList(canon['verify_commands']);
  const maxAttempts = Math.max(1, parseNumber(canon['max_attempts'], 3));
  const timeoutMinutes = Math.max(1, parseNumber(canon['timeout_minutes'], 30));
  const maxConcurrency = Math.max(1, parseNumber(canon['max_concurrency'], 1));

  // Collect other custom settings
  const knownKeys = new Set([
    'repository',
    'agy_bin',
    'agy_args',
    'verify_commands',
    'max_attempts',
    'timeout_minutes',
    'max_concurrency',
  ]);

  for (const [k, v] of Object.entries(combinedRaw)) {
    const matched = matchHeader(k, {});
    if (!knownKeys.has(matched)) {
      settings[k] = v;
    }
  }

  return {
    repository,
    agy_bin: agyBin,
    agy_args: agyArgs,
    verify_commands: verifyCommands,
    max_attempts: maxAttempts,
    timeout_minutes: timeoutMinutes,
    max_concurrency: maxConcurrency,
    settings,
    raw: combinedRaw,
  };
}
