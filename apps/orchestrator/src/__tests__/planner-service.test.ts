import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase, runMigrations } from '@ai-orchestrator/db';
import { PlannerService, buildPlannerPrompt } from '../services/planner-service.js';
import { buildServer } from '../server.js';
import { AppError } from '@ai-orchestrator/shared';

describe('PlannerService (ORC-006)', () => {
  let db: Database.Database;
  let plannerService: PlannerService;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runMigrations(db);
    plannerService = new PlannerService({
      db,
      config: {
        AGY_BIN: process.execPath,
      },
    });
  });

  afterEach(() => {
    db.close();
  });

  describe('Prompt generation', () => {
    it('generates planner prompt including goal, constraints, schema and context files', () => {
      const prompt = buildPlannerPrompt('Build JWT authentication', {
        contextFiles: ['packages/shared/src/models/user.ts'],
      });

      expect(prompt).toContain('Build JWT authentication');
      expect(prompt).toContain('packages/shared/src/models/user.ts');
      expect(prompt).toContain('scope_files');
      expect(prompt).toContain('acceptance_criteria');
      expect(prompt).toContain('dependencies');
    });
  });

  describe('generatePlan with real process execution (node -e)', () => {
    it('calls AGY process, parses valid JSON plan, and saves it to SQLite', async () => {
      const planPayload = {
        title: 'Authentication Feature Plan',
        description: 'Step-by-step authentication rollout',
        tasks: [
          {
            id: 'AUTH-1',
            title: 'Define Auth Models',
            scope_files: ['packages/shared/src/models/auth.ts'],
            acceptance_criteria: ['UserSchema defined and exported'],
            dependencies: [],
            test_commands: ['pnpm test'],
          },
          {
            id: 'AUTH-2',
            title: 'Auth Repository & Migrations',
            scope_files: [
              'packages/db/migrations/005_auth.sql',
              'packages/db/src/repositories/auth-repository.ts',
            ],
            acceptance_criteria: [
              'Migration executes cleanly',
              'AuthRepository passes CRUD tests',
            ],
            dependencies: ['AUTH-1'],
            test_commands: ['pnpm test'],
          },
        ],
      };

      // Mock CLI using node -e printing the markdown code fence JSON
      const mockScript = `console.log(\`Here is the plan:\\n\\\`\\\`\\\`json\\n${JSON.stringify(planPayload)}\\n\\\`\\\`\\\`\`);`;

      const customService = new PlannerService({
        db,
        config: {
          AGY_BIN: process.execPath,
          AGY_ARGS: '-e',
        },
      });

      const plan = await customService.generatePlan({
        goal: 'Implement Authentication',
        command: { exe: process.execPath, args: ['-e', mockScript] },
        repository: '.',
      });

      expect(plan.id).toBeDefined();
      expect(plan.title).toBe('Authentication Feature Plan');
      expect(plan.status).toBe('PENDING_APPROVAL');
      expect(plan.tasks).toHaveLength(2);
      expect(plan.tasks[0]?.scope_files).toEqual(['packages/shared/src/models/auth.ts']);
      expect(plan.tasks[1]?.dependencies).toEqual(['AUTH-1']);

      // Check that it was persisted in SQLite
      const fetched = customService.getPlan(plan.id);
      expect(fetched.id).toBe(plan.id);
      expect(fetched.tasks[0]?.id).toBe('AUTH-1');
    });

    it('throws AppError when process outputs invalid JSON schema', async () => {
      const invalidPayload = {
        title: 'Invalid Plan without tasks',
        tasks: [],
      };

      const mockScript = `console.log(JSON.stringify(${JSON.stringify(invalidPayload)}));`;

      const customService = new PlannerService({
        db,
        config: {
          AGY_BIN: process.execPath,
          AGY_ARGS: '-e',
        },
      });

      await expect(
        customService.generatePlan({
          goal: 'Invalid goal',
          command: { exe: process.execPath, args: ['-e', mockScript] },
          repository: '.',
        }),
      ).rejects.toThrow(AppError);
    });

    it('throws AppError when tasks have circular dependencies', async () => {
      const cyclicPayload = {
        title: 'Cyclic Plan',
        tasks: [
          {
            id: 'T1',
            title: 'Task 1',
            scope_files: ['f1.ts'],
            acceptance_criteria: ['done'],
            dependencies: ['T2'],
          },
          {
            id: 'T2',
            title: 'Task 2',
            scope_files: ['f2.ts'],
            acceptance_criteria: ['done'],
            dependencies: ['T1'],
          },
        ],
      };

      const mockScript = `console.log(JSON.stringify(${JSON.stringify(cyclicPayload)}));`;

      const customService = new PlannerService({
        db,
      });

      await expect(
        customService.generatePlan({
          goal: 'Cyclic goal',
          command: { exe: process.execPath, args: ['-e', mockScript] },
          repository: '.',
        }),
      ).rejects.toThrow(/cycle/i);
    });

    it('throws AppError when task is missing scope_files', async () => {
      const invalidPayload = {
        title: 'No Scope Plan',
        tasks: [
          {
            id: 'T1',
            title: 'Task without scope',
            scope_files: [],
            acceptance_criteria: ['done'],
          },
        ],
      };

      const mockScript = `console.log(JSON.stringify(${JSON.stringify(invalidPayload)}));`;

      const customService = new PlannerService({
        db,
      });

      await expect(
        customService.generatePlan({
          goal: 'Missing scope goal',
          command: { exe: process.execPath, args: ['-e', mockScript] },
          repository: '.',
        }),
      ).rejects.toThrow(/scope/i);
    });

    it('throws AppError when repository directory does not exist', async () => {
      await expect(
        plannerService.generatePlan({
          goal: 'Goal',
          repository: '/non/existent/path/for/repo',
        }),
      ).rejects.toThrow(AppError);
    });
  });

  describe('parseAndValidatePlan direct parser', () => {
    it('parses raw text and persists validated plan', () => {
      const raw = `
        \`\`\`json
        {
          "title": "Offline Plan",
          "tasks": [
            {
              "id": "T-1",
              "title": "Setup",
              "scope_files": ["setup.ts"],
              "acceptance_criteria": ["Setup completed"]
            }
          ]
        }
        \`\`\`
      `;

      const plan = plannerService.parseAndValidatePlan(raw, {
        repository: '.',
      });

      expect(plan.id).toBeDefined();
      expect(plan.title).toBe('Offline Plan');
      expect(plan.tasks[0]?.id).toBe('T-1');
    });
  });

  describe('Fastify REST API endpoints', () => {
    it('POST /plans/generate generates and returns 201 with plan', async () => {
      const planPayload = {
        title: 'API Plan',
        tasks: [
          {
            id: 'API-1',
            title: 'Endpoint task',
            scope_files: ['routes.ts'],
            acceptance_criteria: ['200 OK'],
          },
        ],
      };

      const mockScript = `console.log(JSON.stringify(${JSON.stringify(planPayload)}));`;

      const customPlanner = new PlannerService({
        db,
        config: {
          AGY_BIN: process.execPath,
          AGY_ARGS: '-e',
        },
      });

      const server = await buildServer({
        db,
        plannerService: customPlanner,
      });

      const res = await server.inject({
        method: 'POST',
        url: '/api/plans/generate',
        payload: {
          goal: 'API Goal',
          command: { exe: process.execPath, args: ['-e', mockScript] },
          repository: '.',
        },
      });

      expect(res.statusCode).toBe(201);
      const json = JSON.parse(res.payload);
      expect(json.data.title).toBe('API Plan');
      expect(json.data.tasks).toHaveLength(1);

      await server.close();
    });

    it('POST /plans/validate validates raw plan JSON and returns 200', async () => {
      const server = await buildServer({
        db,
        plannerService,
      });

      const res = await server.inject({
        method: 'POST',
        url: '/api/plans/validate',
        payload: {
          rawOutput: JSON.stringify({
            title: 'Validated via HTTP',
            tasks: [
              {
                id: 'V-1',
                title: 'V Task',
                scope_files: ['v.ts'],
                acceptance_criteria: ['v ok'],
              },
            ],
          }),
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.data.title).toBe('Validated via HTTP');

      await server.close();
    });

    it('GET /plans/:id returns 404 for non-existent plan', async () => {
      const server = await buildServer({
        db,
        plannerService,
      });

      const res = await server.inject({
        method: 'GET',
        url: '/api/plans/plan-non-existent',
      });

      expect(res.statusCode).toBe(404);
      const json = JSON.parse(res.payload);
      expect(json.error.code).toBe('PLAN_NOT_FOUND');

      await server.close();
    });

    it('GET /plans lists stored plans', async () => {
      plannerService.parseAndValidatePlan(
        JSON.stringify({
          title: 'Listed Plan',
          tasks: [
            {
              id: 'L-1',
              title: 'L Task',
              scope_files: ['l.ts'],
              acceptance_criteria: ['l ok'],
            },
          ],
        }),
      );

      const server = await buildServer({
        db,
        plannerService,
      });

      const res = await server.inject({
        method: 'GET',
        url: '/api/plans',
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.payload);
      expect(json.data.length).toBeGreaterThanOrEqual(1);

      await server.close();
    });
  });
});
