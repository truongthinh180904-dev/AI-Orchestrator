import { describe, it, expect } from 'vitest';
import {
  PlanSchema,
  PlanTaskSchema,
  PlanTaskInputSchema,
  PlanContentSchema,
  extractJsonPlan,
  validatePlanTasksGraph,
} from '../models/plan.js';
import { AppError } from '../errors.js';

describe('Plan Schemas & Validation', () => {
  describe('PlanTaskSchema & PlanTaskInputSchema', () => {
    it('validates a valid task schema with scope_files and acceptance_criteria', () => {
      const validTask = {
        id: 'TASK-1',
        title: 'Setup authentication schema',
        description: 'Define SQLite tables for users and sessions',
        scope_files: ['packages/db/migrations/005_auth.sql'],
        acceptance_criteria: ['Migration runs cleanly', 'Table exists'],
        dependencies: [],
        test_commands: ['pnpm test'],
        priority: 1,
        timeout_minutes: 20,
        worker_type: 'agy',
      };

      const parsed = PlanTaskSchema.parse(validTask);
      expect(parsed.id).toBe('TASK-1');
      expect(parsed.scope_files).toEqual(['packages/db/migrations/005_auth.sql']);
      expect(parsed.acceptance_criteria).toEqual(['Migration runs cleanly', 'Table exists']);
    });

    it('rejects task with empty scope_files', () => {
      const task = {
        id: 'TASK-1',
        title: 'Task without scope',
        scope_files: [],
        acceptance_criteria: ['Criterion 1'],
      };

      expect(() => PlanTaskSchema.parse(task)).toThrow();
    });

    it('rejects task with empty acceptance_criteria', () => {
      const task = {
        id: 'TASK-1',
        title: 'Task without acceptance',
        scope_files: ['file1.ts'],
        acceptance_criteria: [],
      };

      expect(() => PlanTaskSchema.parse(task)).toThrow();
    });

    it('normalizes flexible aliases (files, scope, acceptance) via PlanTaskInputSchema', () => {
      const input = {
        id: 'TASK-ALIAS',
        title: 'Task with aliases',
        files: ['src/index.ts', 'src/types.ts'],
        acceptance: ['Must compile without error'],
      };

      const normalized = PlanTaskInputSchema.parse(input);
      expect(normalized.scope_files).toEqual(['src/index.ts', 'src/types.ts']);
      expect(normalized.acceptance_criteria).toEqual(['Must compile without error']);
      expect(normalized.dependencies).toEqual([]);
      expect(normalized.timeout_minutes).toBe(30);
    });
  });

  describe('PlanContentSchema', () => {
    it('validates valid planner output content', () => {
      const content = {
        title: 'Feature Release Architecture',
        description: 'Detailed implementation steps',
        tasks: [
          {
            id: 'T1',
            title: 'Create schemas',
            scope_files: ['packages/shared/src/models/feature.ts'],
            acceptance_criteria: ['Passes zod check'],
          },
          {
            id: 'T2',
            title: 'Implement repository',
            scope_files: ['packages/db/src/repositories/feature-repository.ts'],
            acceptance_criteria: ['CRUD methods operational'],
            dependencies: ['T1'],
          },
        ],
      };

      const parsed = PlanContentSchema.parse(content);
      expect(parsed.title).toBe('Feature Release Architecture');
      expect(parsed.tasks).toHaveLength(2);
      expect(parsed.tasks[1]?.dependencies).toEqual(['T1']);
    });

    it('validates a full plan via PlanSchema', () => {
      const fullPlan = {
        id: 'plan_full_1',
        feature_id: null,
        title: 'Full Plan',
        description: 'Testing full plan schema',
        repository: '.',
        status: 'PENDING_APPROVAL' as const,
        tasks: [
          {
            id: 'T1',
            title: 'Task 1',
            description: null,
            scope_files: ['file.ts'],
            acceptance_criteria: ['Done'],
            dependencies: [],
            test_commands: [],
            priority: 0,
            timeout_minutes: 30,
            worker_type: 'agy',
          },
        ],
        raw_output: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        approved_at: null,
        approved_by: null,
        rejection_reason: null,
      };

      const parsed = PlanSchema.parse(fullPlan);
      expect(parsed.id).toBe('plan_full_1');
      expect(parsed.status).toBe('PENDING_APPROVAL');
    });

    it('rejects plan with empty tasks array', () => {
      const emptyPlan = {
        title: 'Empty Plan',
        tasks: [],
      };

      expect(() => PlanContentSchema.parse(emptyPlan)).toThrow();
    });
  });

  describe('extractJsonPlan', () => {
    it('extracts JSON from standard markdown code fence ```json ... ```', () => {
      const markdown = `
Here is the recommended execution plan for your repo:

\`\`\`json
{
  "title": "Auth Plan",
  "tasks": [
    {
      "id": "T1",
      "title": "Create User Table",
      "scope_files": ["migrations/001.sql"],
      "acceptance_criteria": ["Table created"]
    }
  ]
}
\`\`\`

Let me know if you want any modifications.
`;
      const result = extractJsonPlan(markdown) as { title: string; tasks: unknown[] };
      expect(result.title).toBe('Auth Plan');
      expect(result.tasks).toHaveLength(1);
    });

    it('extracts direct raw JSON', () => {
      const raw = JSON.stringify({
        title: 'Direct JSON',
        tasks: [
          {
            id: 'T1',
            title: 'Task 1',
            scope_files: ['file.ts'],
            acceptance_criteria: ['Done'],
          },
        ],
      });

      const result = extractJsonPlan(raw) as { title: string };
      expect(result.title).toBe('Direct JSON');
    });

    it('extracts JSON embedded with preamble and postamble without code fence', () => {
      const text = `
Plan generated successfully:
{"title":"Embedded JSON","tasks":[{"id":"T1","title":"Task 1","scope_files":["a.ts"],"acceptance_criteria":["ok"]}]}
End of plan.
`;
      const result = extractJsonPlan(text) as { title: string };
      expect(result.title).toBe('Embedded JSON');
    });

    it('throws AppError with INVALID_PLAN_SCHEMA when no valid JSON is found', () => {
      expect(() => extractJsonPlan('Just plain conversational text with no json')).toThrow(AppError);
      expect(() => extractJsonPlan('')).toThrow(AppError);
    });
  });

  describe('validatePlanTasksGraph', () => {
    it('passes for a valid acyclic plan task graph', () => {
      const tasks = [
        {
          id: 'T1',
          title: 'Base task',
          description: null,
          scope_files: ['f1.ts'],
          acceptance_criteria: ['AC1'],
          dependencies: [],
          test_commands: [],
          priority: 0,
          timeout_minutes: 30,
          worker_type: 'agy',
        },
        {
          id: 'T2',
          title: 'Second task',
          description: null,
          scope_files: ['f2.ts'],
          acceptance_criteria: ['AC2'],
          dependencies: ['T1'],
          test_commands: [],
          priority: 0,
          timeout_minutes: 30,
          worker_type: 'agy',
        },
      ];

      expect(() => validatePlanTasksGraph(tasks)).not.toThrow();
    });

    it('detects duplicate task IDs in plan', () => {
      const tasks = [
        {
          id: 'DUP',
          title: 'First dup',
          description: null,
          scope_files: ['f1.ts'],
          acceptance_criteria: ['AC1'],
          dependencies: [],
          test_commands: [],
          priority: 0,
          timeout_minutes: 30,
          worker_type: 'agy',
        },
        {
          id: 'DUP',
          title: 'Second dup',
          description: null,
          scope_files: ['f2.ts'],
          acceptance_criteria: ['AC2'],
          dependencies: [],
          test_commands: [],
          priority: 0,
          timeout_minutes: 30,
          worker_type: 'agy',
        },
      ];

      expect(() => validatePlanTasksGraph(tasks)).toThrow(AppError);
      expect(() => validatePlanTasksGraph(tasks)).toThrow(/duplicate task ID/i);
    });

    it('detects missing dependency reference in plan', () => {
      const tasks = [
        {
          id: 'T1',
          title: 'Task referencing non-existent dep',
          description: null,
          scope_files: ['f1.ts'],
          acceptance_criteria: ['AC1'],
          dependencies: ['NON_EXISTENT_ID'],
          test_commands: [],
          priority: 0,
          timeout_minutes: 30,
          worker_type: 'agy',
        },
      ];

      expect(() => validatePlanTasksGraph(tasks)).toThrow(AppError);
      expect(() => validatePlanTasksGraph(tasks)).toThrow(/non-existent task/i);
    });

    it('detects self-dependency in plan', () => {
      const tasks = [
        {
          id: 'T1',
          title: 'Task depending on itself',
          description: null,
          scope_files: ['f1.ts'],
          acceptance_criteria: ['AC1'],
          dependencies: ['T1'],
          test_commands: [],
          priority: 0,
          timeout_minutes: 30,
          worker_type: 'agy',
        },
      ];

      expect(() => validatePlanTasksGraph(tasks)).toThrow(AppError);
      expect(() => validatePlanTasksGraph(tasks)).toThrow(/cannot depend on itself/i);
    });

    it('detects circular dependency among plan tasks', () => {
      const tasks = [
        {
          id: 'A',
          title: 'Task A',
          description: null,
          scope_files: ['a.ts'],
          acceptance_criteria: ['AC'],
          dependencies: ['B'],
          test_commands: [],
          priority: 0,
          timeout_minutes: 30,
          worker_type: 'agy',
        },
        {
          id: 'B',
          title: 'Task B',
          description: null,
          scope_files: ['b.ts'],
          acceptance_criteria: ['AC'],
          dependencies: ['A'],
          test_commands: [],
          priority: 0,
          timeout_minutes: 30,
          worker_type: 'agy',
        },
      ];

      expect(() => validatePlanTasksGraph(tasks)).toThrow(AppError);
      expect(() => validatePlanTasksGraph(tasks)).toThrow(/contains a cycle/i);
    });
  });
});
