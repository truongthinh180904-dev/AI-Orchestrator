import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDatabase, runMigrations } from '@ai-orchestrator/db';
import { buildServer } from '../server.js';
import type Database from 'better-sqlite3';

describe('apps/orchestrator Server & Routes Unit Tests', () => {
  let db: Database.Database;
  let server: FastifyInstance;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    runMigrations(db);
    server = await buildServer({ db, logger: false });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    db.close();
  });

  it('buildServer responds to health check with 200 and ISO timestamp', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.data.status).toBe('ok');
    expect(typeof json.data.timestamp).toBe('string');
  });

  it('POST /import accepts raw tasks array and commits successfully', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/import',
      payload: {
        tasks: [
          { id: 'T-RAW-1', title: 'Task raw 1' },
          { id: 'T-RAW-2', title: 'Task raw 2', dependencies: 'T-RAW-1' },
        ],
        mode: 'commit',
      },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.data.imported.tasksCount).toBe(2);

    const listRes = await server.inject({ method: 'GET', url: '/tasks' });
    expect(listRes.json().data.length).toBe(2);
  });

  it('POST /import with multipart form-data uploads CSV correctly', async () => {
    const csvContent = 'id,title,status\nT-MP-1,Multipart Task 1,TODO\nT-MP-2,Multipart Task 2,TODO';
    const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';

    const body =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="mode"\r\n\r\n` +
      `commit\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="tasks.csv"\r\n` +
      `Content-Type: text/csv\r\n\r\n` +
      `${csvContent}\r\n` +
      `--${boundary}--\r\n`;

    const res = await server.inject({
      method: 'POST',
      url: '/import',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.data.dryRun).toBe(false);
    expect(json.data.imported.tasksCount).toBe(2);

    const verify = await server.inject({ method: 'GET', url: '/tasks/T-MP-1' });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().data.id).toBe('T-MP-1');
  });

  it('Centralized error handler formats 404 AppError correctly', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/tasks/MISSING-999',
    });
    expect(res.statusCode).toBe(404);
    const json = res.json();
    expect(json).toEqual({
      error: {
        code: 'TASK_NOT_FOUND',
        message: expect.stringContaining('MISSING-999'),
        context: { taskId: 'MISSING-999' },
      },
    });
  });

  it('Centralized error handler formats 400 ZodError correctly', async () => {
    const res = await server.inject({
      method: 'PATCH',
      url: '/tasks/ANY',
      payload: {
        priority: 'NOT_A_NUMBER',
      },
    });
    expect(res.statusCode).toBe(400);
    const json = res.json();
    expect(json.error.code).toBe('VALIDATION_ERROR');
    expect(json.error.context.issues).toBeDefined();
  });
});
