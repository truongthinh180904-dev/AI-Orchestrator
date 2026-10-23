import { describe, expect, it } from 'vitest';
import {
  RepairLoopStatusSchema,
  RepairIterationStatusSchema,
  extractCommandFailureSnippet,
  compileRepairFeedback,
  isRepairIterationPassed,
  buildRepairPrompt,
  type QualityCommandRecord,
  type ReviewFinding,
} from '../index.js';

describe('Repair Loop Models & Helpers', () => {
  it('validates status schemas', () => {
    expect(RepairLoopStatusSchema.parse('RUNNING')).toBe('RUNNING');
    expect(RepairLoopStatusSchema.parse('PASSED')).toBe('PASSED');
    expect(RepairLoopStatusSchema.parse('FAILED')).toBe('FAILED');
    expect(RepairLoopStatusSchema.parse('STOPPED')).toBe('STOPPED');
    expect(() => RepairLoopStatusSchema.parse('INVALID')).toThrow();

    expect(RepairIterationStatusSchema.parse('IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(RepairIterationStatusSchema.parse('PASSED')).toBe('PASSED');
    expect(RepairIterationStatusSchema.parse('FAILED')).toBe('FAILED');
  });

  it('extractCommandFailureSnippet extracts stderr, stdout or default message', () => {
    const dummyRecord: QualityCommandRecord = {
      id: 'rec-1',
      task_id: 'task-1',
      run_id: 'run-1',
      stage: 'test',
      command_id: 'cmd-test',
      name: 'Run Tests',
      command: 'pnpm test',
      exe: 'pnpm',
      args: ['test'],
      cwd: '/test/repo',
      exit_code: 1,
      signal: null,
      status: 'FAILURE',
      stdout: 'Running tests...',
      stderr: 'FAIL src/index.test.ts: Expected true but got false',
      duration_ms: 100,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    const snippet = extractCommandFailureSnippet(dummyRecord);
    expect(snippet).toContain('FAIL src/index.test.ts: Expected true but got false');

    const emptyRecord = { ...dummyRecord, stdout: '', stderr: '', exit_code: 2 };
    expect(extractCommandFailureSnippet(emptyRecord)).toContain('Command exited with code 2');
  });

  it('compileRepairFeedback groups command failures and review findings', () => {
    const failedCmd: QualityCommandRecord = {
      id: 'rec-1',
      task_id: 'task-1',
      run_id: 'run-1',
      stage: 'lint',
      command_id: 'cmd-lint',
      name: 'ESLint',
      command: 'pnpm lint',
      exe: 'pnpm',
      args: ['lint'],
      cwd: '/test/repo',
      exit_code: 1,
      signal: null,
      status: 'FAILURE',
      stdout: '',
      stderr: 'src/main.ts:10: Unexpected any',
      duration_ms: 50,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    const passedCmd: QualityCommandRecord = {
      ...failedCmd,
      id: 'rec-2',
      stage: 'test',
      command_id: 'cmd-test',
      command: 'pnpm test',
      exit_code: 0,
      status: 'SUCCESS',
      stderr: '',
    };

    const reviewFindings: ReviewFinding[] = [
      {
        severity: 'critical',
        file: 'src/auth.ts',
        line: 42,
        message: 'SQL Injection vulnerability',
        suggestion: 'Use parameterized queries',
      },
      {
        severity: 'low',
        file: 'src/style.ts',
        line: 5,
        message: 'Trailing whitespace',
      },
    ];

    const feedback = compileRepairFeedback({
      commandRecords: [failedCmd, passedCmd],
      reviewFindings,
      customSummary: 'Initial verification failed',
    });

    expect(feedback.command_failures).toHaveLength(1);
    expect(feedback.command_failures[0]?.command_id).toBe('cmd-lint');
    expect(feedback.review_findings).toHaveLength(2);
    expect(feedback.summary).toContain('1 verification command(s) failed');
    expect(feedback.summary).toContain('1 high/critical');
  });

  it('isRepairIterationPassed requires all commands to succeed and no high/critical findings', () => {
    const passedCmd: QualityCommandRecord = {
      id: 'rec-1',
      task_id: 'task-1',
      run_id: 'run-1',
      stage: 'test',
      command_id: 'cmd-test',
      name: 'Test',
      command: 'pnpm test',
      exe: 'pnpm',
      args: ['test'],
      cwd: '/test/repo',
      exit_code: 0,
      signal: null,
      status: 'SUCCESS',
      stdout: 'PASS',
      stderr: '',
      duration_ms: 10,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };

    const failedCmd: QualityCommandRecord = {
      ...passedCmd,
      id: 'rec-2',
      exit_code: 1,
      status: 'FAILURE',
    };

    const lowFinding: ReviewFinding = {
      severity: 'low',
      file: 'file.ts',
      line: 1,
      message: 'Consider renaming variable',
    };

    const highFinding: ReviewFinding = {
      severity: 'high',
      file: 'file.ts',
      line: 10,
      message: 'Uncaught promise rejection',
    };

    // When both commands pass and only low findings exist -> PASS
    expect(
      isRepairIterationPassed({
        commandRecords: [passedCmd],
        reviewFindings: [lowFinding],
      }),
    ).toBe(true);

    // If any command failed -> FAIL
    expect(
      isRepairIterationPassed({
        commandRecords: [passedCmd, failedCmd],
        reviewFindings: [lowFinding],
      }),
    ).toBe(false);

    // If review findings contain high or critical -> FAIL
    expect(
      isRepairIterationPassed({
        commandRecords: [passedCmd],
        reviewFindings: [highFinding],
      }),
    ).toBe(false);
  });

  it('buildRepairPrompt constructs a detailed, structured prompt for worker', () => {
    const feedback = compileRepairFeedback({
      commandRecords: [
        {
          id: 'rec-1',
          task_id: 'TASK-1',
          run_id: 'run-1',
          stage: 'lint',
          command_id: 'lint-cmd',
          name: 'Linter',
          command: 'pnpm lint',
          exe: 'pnpm',
          args: ['lint'],
          cwd: '/repo',
          exit_code: 1,
          signal: null,
          status: 'FAILURE',
          stdout: '',
          stderr: 'Type error in file.ts',
          duration_ms: 20,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
      ],
      reviewFindings: [
        {
          severity: 'high',
          file: 'src/main.ts',
          line: 25,
          message: 'Potential memory leak',
          suggestion: 'Clear interval in cleanup',
        },
      ],
    });

    const prompt = buildRepairPrompt({
      taskId: 'TASK-1',
      taskTitle: 'Implement authentication',
      taskDescription: 'Auth feature for users',
      acceptanceCriteria: ['Unit tests pass', 'Lint passes'],
      feedback,
      iteration: 2,
      maxIterations: 3,
    });

    expect(prompt).toContain('# REPAIR REQUEST (Iteration 2 of 3)');
    expect(prompt).toContain('Task ID: TASK-1');
    expect(prompt).toContain('Implement authentication');
    expect(prompt).toContain('## Acceptance Criteria:');
    expect(prompt).toContain('- Unit tests pass');
    expect(prompt).toContain('### Command Failures:');
    expect(prompt).toContain('pnpm lint');
    expect(prompt).toContain('Type error in file.ts');
    expect(prompt).toContain('### Code Review Findings:');
    expect(prompt).toContain('**[HIGH]** at `src/main.ts:25`: Potential memory leak');
    expect(prompt).toContain('*Suggestion*: Clear interval in cleanup');
    expect(prompt).toContain('Focus strictly on fixing the command failures');
  });
});
