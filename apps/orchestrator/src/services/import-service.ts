import type Database from 'better-sqlite3';
import { TaskRepository, FeatureRepository } from '@ai-orchestrator/db';
import {
  AppError,
  parseImportFile,
  parseCsvFiles,
  validateWorkbook,
  mapTaskRow,
  mapFeatureRow,
  FOUNDATION_TASK_IDS,
  ParsedConfigSchema,
  type ParsedWorkbookResult,
} from '@ai-orchestrator/shared';
import type { ImportExecutionResult } from '../types.js';

export interface ExecuteImportOptions {
  buffer?: Buffer;
  filePath?: string;
  fileContent?: string;
  filename?: string;
  files?: Record<string, string>;
  tasks?: Record<string, unknown>[];
  features?: Record<string, unknown>[];
  dryRun?: boolean;
  mode?: 'dry-run' | 'commit';
}

export class ImportService {
  private readonly taskRepo: TaskRepository;
  private readonly featureRepo: FeatureRepository;

  constructor(private readonly db: Database.Database) {
    this.taskRepo = new TaskRepository(db);
    this.featureRepo = new FeatureRepository(db);
  }

  async execute(options: ExecuteImportOptions): Promise<ImportExecutionResult> {
    const isDryRun = Boolean(options.dryRun) || options.mode === 'dry-run';

    let parsed: ParsedWorkbookResult;

    if (options.buffer) {
      parsed = await parseImportFile(options.buffer, { filename: options.filename });
    } else if (options.filePath) {
      parsed = await parseImportFile(options.filePath);
    } else if (options.files) {
      parsed = await parseImportFile(options.files);
    } else if (options.fileContent) {
      const content = options.fileContent;
      const filename = options.filename?.toLowerCase() ?? '';
      if (
        filename.endsWith('.xlsx') ||
        filename.endsWith('.xls') ||
        content.startsWith('UEsD')
      ) {
        const buf = Buffer.from(content, 'base64');
        parsed = await parseImportFile(buf, { filename: options.filename });
      } else {
        parsed = parseCsvFiles({ tasks: content });
      }
    } else if (options.tasks) {
      const parsedTasks = options.tasks.map((t, idx) => mapTaskRow(t, idx + 2));
      const parsedFeatures = (options.features ?? []).map((f, idx) => mapFeatureRow(f, idx + 2));
      parsed = {
        tasks: parsedTasks,
        features: parsedFeatures,
        config: ParsedConfigSchema.parse({}),
        sourceType: 'csv',
      };
    } else {
      throw new AppError(
        'INVALID_INPUT',
        'No import source provided. Expected filePath, fileContent, files, buffer, or tasks array',
      );
    }

    const existingTasks = this.taskRepo.findAll();
    const existingFeatures = this.featureRepo.findAll();
    const existingTaskIds = [
      ...existingTasks.map((t) => t.id),
      ...FOUNDATION_TASK_IDS,
    ];
    const existingFeatureIds = existingFeatures.map((f) => f.id);

    const report = validateWorkbook(parsed, {
      existingTaskIds,
      existingFeatureIds,
    });

    if (isDryRun) {
      return {
        dryRun: true,
        valid: report.valid,
        summary: {
          tasksCount: parsed.tasks.length,
          featuresCount: parsed.features.length,
          errorsCount: report.errors.length,
          warningsCount: report.warnings.length,
        },
        report,
        preview: {
          tasks: parsed.tasks,
          features: parsed.features,
        },
      };
    }

    // Commit mode: reject if validation fails
    if (!report.valid) {
      throw new AppError(
        'IMPORT_VALIDATION_FAILED',
        `Workbook validation failed with ${report.errors.length} error(s)`,
        {
          errors: report.errors,
          report,
          errorCount: report.errors.length,
          warningCount: report.warnings.length,
        },
      );
    }

    // Check if any referenced task dependencies belong to foundation tasks and are not yet in DB
    const referencedFoundationDeps = new Set<string>();
    const fndSet = new Set<string>(FOUNDATION_TASK_IDS);
    for (const task of parsed.tasks) {
      for (const dep of task.dependencies ?? []) {
        if (fndSet.has(dep) && !this.taskRepo.exists(dep)) {
          referencedFoundationDeps.add(dep);
        }
      }
    }

    // Execute atomic transaction
    const commitTx = this.db.transaction(() => {
      // 1. Seed any referenced foundation tasks if missing in DB
      for (const fndId of referencedFoundationDeps) {
        if (!this.taskRepo.exists(fndId)) {
          this.taskRepo.create({
            id: fndId,
            title: `Foundation Task ${fndId}`,
            phase: 'Foundation',
            status: 'DONE',
            acceptance_criteria: ['Completed in milestone FND'],
          });
        }
      }

      // 2. Insert features
      const createdFeatures = this.featureRepo.createMany(parsed.features);

      // 3. Insert tasks and dependencies
      const createdTasks = this.taskRepo.createMany(parsed.tasks);

      return { createdFeatures, createdTasks };
    });

    const { createdFeatures, createdTasks } = commitTx();

    return {
      dryRun: false,
      valid: true,
      imported: {
        tasksCount: createdTasks.length,
        featuresCount: createdFeatures.length,
      },
      tasks: createdTasks,
      features: createdFeatures,
    };
  }
}
