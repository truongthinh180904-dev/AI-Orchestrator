import { AppError } from '../errors.js';
import {
  QualityCommandDefinitionSchema,
  type QualityCommandDefinition,
  type QualityCommandInput,
  type QualityStage,
} from './types.js';

export interface ParseCommandLineResult {
  exe: string;
  args: string[];
}

/**
 * Splits a command line string into an executable and an array of arguments,
 * respecting single/double quotes and escape characters.
 *
 * Examples:
 *   "pnpm test" -> { exe: "pnpm", args: ["test"] }
 *   "git commit -m 'feat: initial setup'" -> { exe: "git", args: ["commit", "-m", "feat: initial setup"] }
 *   "echo \"hello world\"" -> { exe: "echo", args: ["hello world"] }
 */
export function parseCommandLine(commandLine: string): ParseCommandLineResult {
  if (!commandLine || typeof commandLine !== 'string' || commandLine.trim().length === 0) {
    throw new AppError('INVALID_COMMAND', 'Command line cannot be empty', { commandLine });
  }

  const trimmed = commandLine.trim();
  const tokens: string[] = [];
  let currentToken = '';
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let isEscaped = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (char === undefined) {
      continue;
    }

    if (isEscaped) {
      currentToken += char;
      isEscaped = false;
      continue;
    }

    if (char === '\\') {
      isEscaped = true;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (/\s/.test(char) && !inDoubleQuote && !inSingleQuote) {
      if (currentToken.length > 0) {
        tokens.push(currentToken);
        currentToken = '';
      }
      continue;
    }

    currentToken += char;
  }

  if (isEscaped) {
    throw new AppError('INVALID_COMMAND', 'Command line has a trailing dangling escape backslash', {
      commandLine,
    });
  }

  if (inDoubleQuote || inSingleQuote) {
    throw new AppError('INVALID_COMMAND', 'Command line has unclosed quote character', {
      commandLine,
      quote: inDoubleQuote ? '"' : "'",
    });
  }

  if (currentToken.length > 0) {
    tokens.push(currentToken);
  }

  if (tokens.length === 0 || tokens[0] === undefined) {
    throw new AppError('INVALID_COMMAND', 'Parsed command line resulted in no tokens', {
      commandLine,
    });
  }

  const exe = tokens[0];
  const args = tokens.slice(1);

  return { exe, args };
}

export interface NormalizeQualityCommandOptions {
  cwd?: string;
  defaultTimeoutMs?: number;
  stageNamePrefix?: string;
}

const DEFAULT_STAGE_NAMES: Record<QualityStage, string> = {
  format: 'Format check',
  lint: 'Lint check',
  typecheck: 'TypeScript type check',
  test: 'Test runner',
  build: 'Production build',
  custom: 'Custom verification',
};

/**
 * Normalizes a raw QualityCommandInput (string, array, or object) into a fully validated QualityCommandDefinition.
 */
export function normalizeQualityCommand(
  stage: QualityStage,
  input: QualityCommandInput | null | undefined,
  options: NormalizeQualityCommandOptions = {},
): QualityCommandDefinition | null {
  if (input === null || input === undefined) {
    return null;
  }

  const cwd = options.cwd ?? process.cwd();
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
  const defaultStageName = DEFAULT_STAGE_NAMES[stage] ?? `${stage} check`;

  if (typeof input === 'string') {
    const parsed = parseCommandLine(input);
    return QualityCommandDefinitionSchema.parse({
      id: `${stage}-cmd`,
      stage,
      name: defaultStageName,
      command: input.trim(),
      exe: parsed.exe,
      args: parsed.args,
      cwd,
      timeout_ms: defaultTimeoutMs,
      enabled: true,
      required: stage !== 'build', // build is optional unless explicitly stated
      continueOnError: false,
    });
  }

  if (Array.isArray(input)) {
    if (input.length === 0) {
      return null;
    }
    const exe = input[0];
    const args = input.slice(1);
    const commandStr = input.join(' ');
    return QualityCommandDefinitionSchema.parse({
      id: `${stage}-cmd`,
      stage,
      name: defaultStageName,
      command: commandStr,
      exe,
      args,
      cwd,
      timeout_ms: defaultTimeoutMs,
      enabled: true,
      required: stage !== 'build',
      continueOnError: false,
    });
  }

  // Object input
  let exe = input.exe;
  let args = input.args ?? [];
  let commandStr = input.command;

  if (!exe && commandStr) {
    const parsed = parseCommandLine(commandStr);
    exe = parsed.exe;
    if (args.length === 0) {
      args = parsed.args;
    }
  } else if (exe && !commandStr) {
    commandStr = [exe, ...args].join(' ');
  }

  if (!exe || !commandStr) {
    throw new AppError(
      'INVALID_QUALITY_COMMAND',
      `Quality command for stage '${stage}' must define an executable or command string`,
      { stage, input },
    );
  }

  const rawDefinition = {
    id: input.id ?? `${stage}-cmd`,
    stage: input.stage ?? stage,
    name: input.name ?? defaultStageName,
    command: commandStr,
    exe,
    args,
    cwd: input.cwd ?? cwd,
    env: input.env,
    timeout_ms: input.timeout_ms ?? defaultTimeoutMs,
    enabled: input.enabled ?? true,
    required: input.required ?? (stage !== 'build'),
    continueOnError: input.continueOnError ?? false,
  };

  return QualityCommandDefinitionSchema.parse(rawDefinition);
}
