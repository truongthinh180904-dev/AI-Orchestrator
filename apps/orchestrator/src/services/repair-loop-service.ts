import type Database from 'better-sqlite3';
import {
  type RepairLoopRecord,
  type RepairIterationRecord,
  type RepairFeedback,
  type QualityPipelineResult,
  compileRepairFeedback,
  buildRepairPrompt,
  isRepairIterationPassed,
  AppError,
  logger,
  type Env,
} from '@ai-orchestrator/shared';
import {
  RepairLoopRepository,
  ReportRepository,
  TaskRepository,
  RunRepository,
} from '@ai-orchestrator/db';
import { QualityRunner } from './quality-runner.js';
import { ReviewerService } from './reviewer-service.js';
import { TaskStateService } from './task-state-service.js';
import { ProcessAdapter, processAdapter as defaultProcessAdapter } from '../adapters/process-adapter.js';
import { getOrchestratorConfig } from '../config.js';

export interface RepairLoopServiceOptions {
  db: Database.Database;
  qualityRunner?: QualityRunner;
  reviewerService?: ReviewerService;
  taskRepo?: TaskRepository;
  stateService?: TaskStateService;
  processAdapter?: ProcessAdapter;
  repairRepo?: RepairLoopRepository;
  reportRepo?: ReportRepository;
  runRepo?: RunRepository;
  config?: Partial<Env>;
}

export interface ExecuteRepairCycleOptions {
  taskId: string;
  runId?: string;
  repoPath?: string;
  maxIterations?: number;
  autoTransitionTask?: boolean;
  initialFeedback?: RepairFeedback;
  customPrompt?: string;
  executeFix?: (
    iteration: number,
    prompt: string,
    context: { taskId: string; loopId: string },
  ) => Promise<{ success: boolean; runId?: string; error?: string }>;
  onIterationStart?: (iteration: number, loop: RepairLoopRecord) => void;
  onIterationComplete?: (iteration: number, record: RepairIterationRecord) => void;
}

export interface RepairCycleResult {
  loopId: string;
  taskId: string;
  passed: boolean;
  status: 'PASSED' | 'FAILED' | 'STOPPED';
  totalIterations: number;
  maxIterations: number;
  finalReason: string | null;
  loop: RepairLoopRecord;
  iterations: RepairIterationRecord[];
  summary: string;
}

export class RepairLoopService {
  private readonly db: Database.Database;
  private readonly qualityRunner: QualityRunner;
  private readonly reviewerService: ReviewerService;
  private readonly taskRepo: TaskRepository;
  private readonly stateService: TaskStateService;
  private readonly processAdapter: ProcessAdapter;
  private readonly repairRepo: RepairLoopRepository;
  private readonly reportRepo: ReportRepository;
  private readonly runRepo: RunRepository;
  private readonly config: Partial<Env>;

  constructor(options: RepairLoopServiceOptions) {
    this.db = options.db;
    this.qualityRunner = options.qualityRunner ?? new QualityRunner({ db: this.db });
    this.reviewerService = options.reviewerService ?? new ReviewerService({ db: this.db });
    this.taskRepo = options.taskRepo ?? new TaskRepository(this.db);
    this.stateService = options.stateService ?? new TaskStateService(this.db);
    this.processAdapter = options.processAdapter ?? defaultProcessAdapter;
    this.repairRepo = options.repairRepo ?? new RepairLoopRepository(this.db);
    this.reportRepo = options.reportRepo ?? new ReportRepository(this.db);
    this.runRepo = options.runRepo ?? new RunRepository(this.db);

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

  getRepairRepository(): RepairLoopRepository {
    return this.repairRepo;
  }

  /**
   * Executes a bounded repair cycle (vòng sửa có giới hạn max N).
   * In each iteration:
   * 1. Constructs repair feedback and prompt.
   * 2. Runs the fixing worker agent.
   * 3. Runs QLT-002 verification pipeline and QLT-004 reviewer.
   * 4. If all checks pass: terminates early with PASSED.
   * 5. If max N reached and checks still fail: stops immediately with FAILED and transitions task to FAILED.
   */
  async runRepairCycle(options: ExecuteRepairCycleOptions): Promise<RepairCycleResult> {
    const { taskId, autoTransitionTask = true } = options;
    const maxIterations = Math.max(1, options.maxIterations ?? 3);

    const task = this.taskRepo.findById(taskId);
    if (!task) {
      throw new AppError('TASK_NOT_FOUND', `Task with id '${taskId}' not found`, { taskId });
    }

    const repoPath = options.repoPath ?? '.';

    // Create the master repair loop record in SQLite
    const loop = this.repairRepo.createLoop({
      task_id: taskId,
      run_id: options.runId ?? null,
      max_iterations: maxIterations,
      feedback_summary: options.initialFeedback?.summary ?? 'Starting repair cycle',
    });

    logger.info(`Starting repair loop '${loop.id}' for task '${taskId}' (max ${maxIterations} iterations)`, {
      loopId: loop.id,
      taskId,
      maxIterations,
    });

    let currentFeedback: RepairFeedback;

    // Determine initial feedback: either from input or by running an initial verification check
    if (options.initialFeedback) {
      currentFeedback = options.initialFeedback;
    } else {
      logger.info(`Running initial verification before repair loop for task '${taskId}'`, { taskId });
      const [pipelineResult, reviewResult] = await Promise.all([
        this.executeVerificationPipeline(taskId, repoPath, options.runId),
        this.reviewerService.reviewTask(taskId, {
          repoPath,
          runId: options.runId,
        }),
      ]);

      const passedInitial = isRepairIterationPassed({
        commandRecords: pipelineResult.records,
        reviewFindings: reviewResult.findings,
      });

      if (passedInitial) {
        // Initial verification already passes; no repair needed
        const finishedAt = new Date().toISOString();
        const updatedLoop = this.repairRepo.updateLoop(loop.id, {
          status: 'PASSED',
          passed: true,
          current_iteration: 0,
          final_reason: 'Task already passes all verification and review standards',
          finished_at: finishedAt,
        });

        this.saveAuditReport(taskId, options.runId, updatedLoop, []);

        return {
          loopId: loop.id,
          taskId,
          passed: true,
          status: 'PASSED',
          totalIterations: 0,
          maxIterations,
          finalReason: 'Task already passes all verification and review standards',
          loop: updatedLoop,
          iterations: [],
          summary: 'No repairs needed: verification passed initially',
        };
      }

      currentFeedback = compileRepairFeedback({
        commandRecords: pipelineResult.records,
        reviewFindings: reviewResult.findings,
        customSummary: 'Initial verification failed',
      });
    }

    const executedIterations: RepairIterationRecord[] = [];
    let loopPassed = false;
    let finalReason: string | null = null;

    // Iteration loop: 1 to maxIterations
    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      options.onIterationStart?.(iteration, loop);
      const iterStartTime = Date.now();

      // Build structured repair prompt
      const prompt = buildRepairPrompt({
        taskId,
        taskTitle: task.title,
        acceptanceCriteria: task.acceptance_criteria,
        feedback: currentFeedback,
        iteration,
        maxIterations,
      });

      const fullPrompt = options.customPrompt ? `${options.customPrompt}\n\n${prompt}` : prompt;

      // Create iteration record
      const iterRecord = this.repairRepo.createIteration({
        repair_loop_id: loop.id,
        iteration_number: iteration,
        run_id: options.runId ?? null,
        status: 'IN_PROGRESS',
        passed: false,
        command_failures_count: currentFeedback.command_failures.length,
        review_findings_count: currentFeedback.review_findings.length,
        prompt: fullPrompt,
        feedback: currentFeedback,
      });

      logger.info(`Executing repair iteration ${iteration}/${maxIterations} for task '${taskId}'`, {
        loopId: loop.id,
        iteration,
        failedCommands: currentFeedback.command_failures.length,
        reviewFindings: currentFeedback.review_findings.length,
      });

      // 1. Run fix worker
      try {
        if (options.executeFix) {
          await options.executeFix(iteration, fullPrompt, { taskId, loopId: loop.id });
        } else {
          await this.defaultExecuteFix(taskId, fullPrompt, repoPath);
        }
      } catch (err) {
        logger.warn(`Fix worker encountered an error on iteration ${iteration}`, {
          taskId,
          iteration,
          error: (err as Error).message,
        });
      }

      // 2. Run verification pipeline (QLT-002) and review (QLT-004)
      const pipelineResult = await this.executeVerificationPipeline(taskId, repoPath, options.runId);

      const reviewResult = await this.reviewerService.reviewTask(taskId, {
        repoPath,
        runId: options.runId,
      });

      const iterPassed = isRepairIterationPassed({
        commandRecords: pipelineResult.records,
        reviewFindings: reviewResult.findings,
      });

      const durationMs = Math.max(0, Date.now() - iterStartTime);

      // Re-compile feedback for this iteration
      const nextFeedback = compileRepairFeedback({
        commandRecords: pipelineResult.records,
        reviewFindings: reviewResult.findings,
      });

      // Update iteration record in DB
      const updatedIter = this.repairRepo.updateIteration(iterRecord.id, {
        status: iterPassed ? 'PASSED' : 'FAILED',
        passed: iterPassed,
        command_failures_count: pipelineResult.failed_commands,
        review_findings_count: reviewResult.findings.length,
        feedback: nextFeedback,
        duration_ms: durationMs,
      });

      executedIterations.push(updatedIter);
      options.onIterationComplete?.(iteration, updatedIter);

      // Update current iteration on master loop
      this.repairRepo.updateLoop(loop.id, {
        current_iteration: iteration,
      });

      if (iterPassed) {
        logger.info(`Repair iteration ${iteration}/${maxIterations} PASSED for task '${taskId}'`, {
          loopId: loop.id,
          iteration,
          durationMs,
        });
        loopPassed = true;
        finalReason = `Verification passed on iteration ${iteration}`;
        break;
      } else {
        logger.warn(`Repair iteration ${iteration}/${maxIterations} FAILED for task '${taskId}'`, {
          loopId: loop.id,
          iteration,
          failedCommands: pipelineResult.failed_commands,
          reviewFindings: reviewResult.findings.length,
        });

        currentFeedback = nextFeedback;
      }
    }

    const finishedAt = new Date().toISOString();
    const finalStatus = loopPassed ? 'PASSED' : 'FAILED';
    if (!loopPassed && !finalReason) {
      finalReason = 'MAX_REPAIR_ITERATIONS_EXCEEDED';
    }

    // Update master loop record in SQLite
    const finalizedLoop = this.repairRepo.updateLoop(loop.id, {
      status: finalStatus,
      passed: loopPassed,
      final_reason: finalReason,
      feedback_summary: currentFeedback.summary,
      finished_at: finishedAt,
    });

    // Handle task state transition
    if (autoTransitionTask) {
      const currentTask = this.taskRepo.findById(taskId);
      if (loopPassed) {
        if (currentTask && (currentTask.status === 'RUNNING' || currentTask.status === 'TODO' || currentTask.status === 'READY')) {
          this.stateService.markVerifying(taskId, {
            reason: `Repair loop passed on iteration ${finalizedLoop.current_iteration}`,
            runId: options.runId,
          });
        }
      } else {
        // "Hết lượt thì dừng, FAILED"
        if (currentTask && currentTask.status !== 'FAILED') {
          try {
            if (currentTask.status === 'RUNNING' || currentTask.status === 'VERIFYING') {
              this.stateService.markFailed(taskId, {
                reason: `Hết lượt sửa (${maxIterations} lần) nhưng kiểm định vẫn thất bại: ${finalReason}`,
                runId: options.runId,
              });
            } else {
              // If task was in TODO or READY, force transition to FAILED
              this.taskRepo.transitionStatus(taskId, 'FAILED', {
                reason: `Hết lượt sửa (${maxIterations} lần) nhưng kiểm định vẫn thất bại: ${finalReason}`,
                force: true,
              });
            }
          } catch (e) {
            logger.warn(`Failed to transition task status to FAILED: ${(e as Error).message}`);
          }
        }
      }
    }

    // Persist comprehensive audit report into reports table
    this.saveAuditReport(taskId, options.runId, finalizedLoop, executedIterations);

    const summary = loopPassed
      ? `Repair cycle PASSED after ${finalizedLoop.current_iteration} iteration(s)`
      : `Repair cycle FAILED: Exceeded maximum allowed iterations (${maxIterations})`;

    return {
      loopId: loop.id,
      taskId,
      passed: loopPassed,
      status: finalStatus,
      totalIterations: finalizedLoop.current_iteration,
      maxIterations,
      finalReason,
      loop: {
        ...finalizedLoop,
        iterations: executedIterations,
      },
      iterations: executedIterations,
      summary,
    };
  }

  /**
   * Retrieves a repair loop by ID including all associated iteration records.
   */
  getRepairLoop(id: string): RepairLoopRecord | null {
    return this.repairRepo.getLoopWithIterations(id);
  }

  /**
   * Retrieves all repair loops for a specific task.
   */
  getLoopsForTask(taskId: string): RepairLoopRecord[] {
    return this.repairRepo.findLoopsByTaskId(taskId);
  }

  /**
   * Executes the verification pipeline for a task, leveraging QualityConfigService when available
   * or falling back to task.test_commands.
   */
  async executeVerificationPipeline(
    taskId: string,
    repoPath: string,
    runId?: string,
  ): Promise<QualityPipelineResult> {
    try {
      return await this.qualityRunner.runForTask(taskId, {
        runId,
        repoPath,
        stopOnFirstFailure: false,
      });
    } catch {
      const task = this.taskRepo.findById(taskId);
      const testCommands = task?.test_commands ?? [];
      const commands = testCommands.map((cmdStr, idx) => ({
        id: `cmd_task_${idx}`,
        stage: 'test' as const,
        name: `Task Test ${idx + 1}`,
        command: cmdStr,
        exe: cmdStr.split(' ')[0] ?? 'pnpm',
        args: cmdStr.split(' ').slice(1),
        cwd: repoPath,
        timeout_ms: 120_000,
        enabled: true,
        required: true,
        continueOnError: false,
      }));

      return await this.qualityRunner.runPipeline(commands, {
        taskId,
        runId,
        repoPath,
        stopOnFirstFailure: false,
      });
    }
  }

  /**
   * Default execution method using ProcessAdapter to spawn the AI repair worker.
   */
  private async defaultExecuteFix(taskId: string, prompt: string, repoPath: string): Promise<void> {
    const agyBin = this.config.AGY_BIN || 'agy';
    const rawArgs = this.config.AGY_ARGS ? this.config.AGY_ARGS.split(' ') : ['-p'];
    const args = [...rawArgs, prompt];

    const handle = this.processAdapter.spawn({
      exe: agyBin,
      args,
      cwd: repoPath,
    });

    await handle.waitForExit();
  }

  /**
   * Saves an audit record in the reports table with kind 'repair_loop'.
   */
  private saveAuditReport(
    taskId: string,
    runId: string | undefined,
    loop: RepairLoopRecord,
    iterations: RepairIterationRecord[],
  ): void {
    try {
      this.reportRepo.create({
        run_id: runId ?? null,
        kind: 'repair_loop',
        content: JSON.stringify(
          {
            loop_id: loop.id,
            task_id: taskId,
            status: loop.status,
            passed: loop.passed,
            max_iterations: loop.max_iterations,
            total_iterations: loop.current_iteration,
            final_reason: loop.final_reason,
            feedback_summary: loop.feedback_summary,
            iterations: iterations.map((it) => ({
              iteration: it.iteration_number,
              status: it.status,
              passed: it.passed,
              command_failures_count: it.command_failures_count,
              review_findings_count: it.review_findings_count,
              duration_ms: it.duration_ms,
            })),
            created_at: loop.created_at,
            finished_at: loop.finished_at,
          },
          null,
          2,
        ),
      });
    } catch (err) {
      logger.warn(`Failed to save repair_loop report to database: ${(err as Error).message}`);
    }
  }
}
