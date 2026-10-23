import path from 'node:path';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import {
  type Plan,
  type PlanFilter,
  type GeneratePlanInput,
  type Env,
  GeneratePlanInputSchema,
  PlanContentSchema,
  extractJsonPlan,
  validatePlanTasksGraph,
  AppError,
  logger,
} from '@ai-orchestrator/shared';
import { PlanRepository } from '@ai-orchestrator/db';
import { processAdapter, ProcessAdapter, type ProcessHandle } from '../adapters/process-adapter.js';
import type { RepositoryRegistry } from '../adapters/repository-registry.js';
import { getOrchestratorConfig } from '../config.js';

export interface PlannerServiceOptions {
  db: Database.Database;
  processAdapter?: ProcessAdapter;
  repositoryRegistry?: RepositoryRegistry;
  config?: Partial<Env>;
}

export function buildPlannerPrompt(
  goal: string,
  options?: { contextFiles?: string[]; featureId?: string; repoPath?: string },
): string {
  const contextSnippet =
    options?.contextFiles && options.contextFiles.length > 0
      ? `\nRelevant context files to inspect:\n${options.contextFiles.map((f) => `- ${f}`).join('\n')}\n`
      : '';

  return (
    `You are the AI Project Planner. Analyze the repository codebase and generate an actionable, ordered execution plan in JSON to achieve the following goal.\n\n` +
    `GOAL:\n${goal}\n` +
    contextSnippet +
    `\nCRITICAL CONSTRAINTS:\n` +
    `1. Respond ONLY with a valid JSON object matching the schema below. No chat, explanations, or surrounding prose.\n` +
    `2. Break the work down into sequential tasks.\n` +
    `3. Every task MUST specify at least one file path in 'scope_files' (relative to repository root).\n` +
    `4. Every task MUST specify at least one concrete, testable requirement in 'acceptance_criteria'.\n` +
    `5. 'dependencies' must refer ONLY to other task IDs in this plan and must not contain circular dependencies.\n\n` +
    `SCHEMA:\n` +
    `{\n` +
    `  "title": "<Concise Plan Title>",\n` +
    `  "description": "<Optional Plan Summary>",\n` +
    `  "tasks": [\n` +
    `    {\n` +
    `      "id": "TSK-001",\n` +
    `      "title": "<Task Title>",\n` +
    `      "description": "<Task Description>",\n` +
    `      "scope_files": ["<path/to/file>"],\n` +
    `      "acceptance_criteria": ["<Criterion 1>"],\n` +
    `      "dependencies": [],\n` +
    `      "test_commands": ["pnpm test"],\n` +
    `      "priority": 0,\n` +
    `      "timeout_minutes": 30\n` +
    `    }\n` +
    `  ]\n` +
    `}`
  );
}

export class PlannerService {
  private readonly db: Database.Database;
  private readonly planRepo: PlanRepository;
  private readonly processAdapter: ProcessAdapter;
  private readonly repositoryRegistry?: RepositoryRegistry;
  private readonly config: Partial<Env>;

  constructor(options: PlannerServiceOptions) {
    this.db = options.db;
    this.planRepo = new PlanRepository(this.db);
    this.processAdapter = options.processAdapter ?? processAdapter;
    this.repositoryRegistry = options.repositoryRegistry;

    let config: Partial<Env> = options.config ?? {};
    if (!options.config) {
      try {
        config = getOrchestratorConfig();
      } catch {
        config = {
          AGY_BIN: process.env['AGY_BIN'] || 'agy',
          AGY_ARGS: process.env['AGY_ARGS'],
        };
      }
    }
    this.config = config;
  }

  getPlanRepository(): PlanRepository {
    return this.planRepo;
  }

  /**
   * Generates a structured plan by calling AGY on a target repository,
   * extracting and validating the JSON plan with Zod, and saving it to SQLite.
   */
  async generatePlan(input: GeneratePlanInput): Promise<Plan> {
    const validatedInput = GeneratePlanInputSchema.parse(input);

    // Resolve repository working directory
    const repoPath = validatedInput.repository && validatedInput.repository !== '.'
      ? path.resolve(validatedInput.repository)
      : process.cwd();

    if (!fs.existsSync(repoPath)) {
      throw new AppError('PATH_NOT_FOUND', `Repository directory does not exist: ${repoPath}`, {
        repository: validatedInput.repository,
        repoPath,
      });
    }

    const stat = fs.statSync(repoPath);
    if (!stat.isDirectory()) {
      throw new AppError('NOT_A_DIRECTORY', `Repository path is not a directory: ${repoPath}`, {
        repository: validatedInput.repository,
        repoPath,
      });
    }

    if (this.repositoryRegistry) {
      this.repositoryRegistry.assertCwdValid(repoPath);
    }

    // Build the prompt for AGY
    const prompt =
      validatedInput.customPrompt ??
      buildPlannerPrompt(validatedInput.goal, {
        contextFiles: validatedInput.contextFiles,
        featureId: validatedInput.feature_id ?? undefined,
        repoPath,
      });

    const exe = validatedInput.command?.exe ?? this.config.AGY_BIN ?? 'agy';
    let args: string[];
    if (validatedInput.command?.args) {
      args = [...validatedInput.command.args];
    } else {
      args = [];
      if (this.config.AGY_ARGS) {
        args.push(this.config.AGY_ARGS);
      }
      args.push('-p', prompt);
    }

    logger.info('Generating plan via AGY', {
      exe,
      argsCount: args.length,
      repoPath,
      goal: validatedInput.goal,
    });

    let handle: ProcessHandle;
    try {
      handle = this.processAdapter.spawn({
        exe,
        args,
        cwd: repoPath,
      });
    } catch (err: unknown) {
      const error = err as Error;
      throw new AppError('PLAN_SPAWN_ERROR', `Failed to spawn planner AGY process: ${error.message}`, {
        exe,
        args,
        repoPath,
      });
    }

    let stdoutData = '';
    let stderrData = '';

    handle.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString('utf8');
    });

    handle.stderr.on('data', (chunk) => {
      stderrData += chunk.toString('utf8');
    });

    let timeoutTimer: NodeJS.Timeout | undefined;
    if (validatedInput.timeoutMs && validatedInput.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        try {
          void handle.terminate({ forceSignal: 'SIGKILL', gracePeriodMs: 2000 });
        } catch {
          // ignore
        }
      }, validatedInput.timeoutMs);
    }

    const exitResult = await handle.waitForExit().finally(() => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
    });

    if (exitResult.exitCode !== 0 && !stdoutData.trim()) {
      throw new AppError(
        'PLAN_GENERATION_FAILED',
        `Planner AGY exited with code ${exitResult.exitCode}: ${stderrData.trim() || 'No error output'}`,
        {
          exitCode: exitResult.exitCode,
          stderr: stderrData,
          stdout: stdoutData,
        },
      );
    }

    // Parse and validate the output plan
    return this.parseAndValidatePlan(stdoutData || stderrData, {
      repository: validatedInput.repository,
      feature_id: validatedInput.feature_id ?? null,
      status: validatedInput.status ?? 'PENDING_APPROVAL',
      rawOutput: stdoutData || stderrData,
    });
  }

  /**
   * Parses raw output text, extracts JSON, validates against PlanContentSchema with Zod,
   * verifies task dependencies, and saves the validated Plan to SQLite.
   */
  parseAndValidatePlan(
    rawOutput: string,
    metadata?: {
      id?: string;
      repository?: string;
      feature_id?: string | null;
      status?: Plan['status'];
      rawOutput?: string;
    },
  ): Plan {
    // 1. Extract JSON
    const extracted = extractJsonPlan(rawOutput);

    // 2. Validate content with Zod
    const parsedContent = PlanContentSchema.safeParse(extracted);
    if (!parsedContent.success) {
      throw new AppError(
        'INVALID_PLAN_SCHEMA',
        `Plan schema validation failed: ${parsedContent.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        {
          issues: parsedContent.error.issues,
          extracted,
        },
      );
    }

    const content = parsedContent.data;

    // 3. Verify dependency graph of tasks
    validatePlanTasksGraph(content.tasks);

    // 4. Save and return plan
    return this.planRepo.create({
      id: metadata?.id,
      title: content.title,
      description: content.description ?? null,
      feature_id: metadata?.feature_id ?? null,
      repository: metadata?.repository ?? '.',
      status: metadata?.status ?? 'PENDING_APPROVAL',
      tasks: content.tasks,
      raw_output: metadata?.rawOutput ?? rawOutput,
    });
  }

  getPlan(id: string): Plan {
    const plan = this.planRepo.findById(id);
    if (!plan) {
      throw new AppError('PLAN_NOT_FOUND', `Plan with id '${id}' not found`, { id });
    }
    return plan;
  }

  listPlans(filter?: PlanFilter): Plan[] {
    return this.planRepo.findAll(filter);
  }

  deletePlan(id: string): boolean {
    const existing = this.planRepo.findById(id);
    if (!existing) {
      throw new AppError('PLAN_NOT_FOUND', `Plan with id '${id}' not found for deletion`, { id });
    }
    return this.planRepo.delete(id);
  }
}
