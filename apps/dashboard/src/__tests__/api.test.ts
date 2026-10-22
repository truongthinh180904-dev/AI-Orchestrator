import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiClient } from '../lib/api.js';
import { AppError } from '@ai-orchestrator/shared';

describe('ApiClient', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let client: ApiClient;

  beforeEach(() => {
    mockFetch = vi.fn();
    client = new ApiClient({
      baseUrl: 'http://localhost:3000',
      fetchFn: mockFetch as unknown as typeof fetch,
    });
  });

  it('getBaseUrl returns configured base URL without trailing slash', () => {
    const c = new ApiClient({ baseUrl: 'http://localhost:3000/' });
    expect(c.getBaseUrl()).toBe('http://localhost:3000');
  });

  it('previewImport sends POST /api/import with mode=dry-run and JSON body', async () => {
    const mockResult = {
      dryRun: true,
      valid: true,
      summary: { tasksCount: 5, featuresCount: 1, errorsCount: 0, warningsCount: 0 },
      report: { valid: true, errors: [], warnings: [] },
      preview: { tasks: [], features: [] },
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ data: mockResult }),
    });

    const res = await client.previewImport({
      filePath: 'fixtures/sample.xlsx',
      repository: '.',
    });

    expect(res).toEqual(mockResult);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/api/import');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.mode).toBe('dry-run');
    expect(body.dryRun).toBe(true);
    expect(body.filePath).toBe('fixtures/sample.xlsx');
  });

  it('previewImport with File sends FormData', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        data: {
          dryRun: true,
          valid: true,
          summary: { tasksCount: 1, featuresCount: 0, errorsCount: 0, warningsCount: 0 },
          report: { valid: true, errors: [], warnings: [] },
          preview: { tasks: [], features: [] },
        },
      }),
    });

    const fakeBlob = new Blob(['task_id,title\nTSK-1,Test'], { type: 'text/csv' });
    const res = await client.previewImport({
      file: fakeBlob,
      filename: 'test.csv',
    });

    expect(res.valid).toBe(true);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('commitImport sends POST /api/import with mode=commit', async () => {
    const mockResult = {
      dryRun: false,
      valid: true,
      imported: { tasksCount: 2, featuresCount: 1 },
      tasks: [],
      features: [],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ data: mockResult }),
    });

    const res = await client.commitImport({
      filePath: 'fixtures/sample.xlsx',
    });

    expect(res).toEqual(mockResult);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.mode).toBe('commit');
    expect(body.dryRun).toBe(false);
  });

  it('unwraps error responses into AppError with code, message, and context', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        error: {
          code: 'IMPORT_VALIDATION_FAILED',
          message: 'Data contains duplicate task_id',
          context: { duplicateId: 'TSK-001' },
        },
      }),
    });

    await expect(client.commitImport({ filePath: 'invalid.xlsx' })).rejects.toThrow(AppError);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({
        error: {
          code: 'IMPORT_VALIDATION_FAILED',
          message: 'Data contains duplicate task_id',
          context: { duplicateId: 'TSK-001' },
        },
      }),
    });

    try {
      await client.commitImport({ filePath: 'invalid.xlsx' });
    } catch (err: unknown) {
      const appErr = err as AppError;
      expect(appErr.code).toBe('IMPORT_VALIDATION_FAILED');
      expect(appErr.message).toBe('Data contains duplicate task_id');
      expect(appErr.context).toEqual({ duplicateId: 'TSK-001' });
    }
  });

  it('handles network failure by throwing AppError NETWORK_ERROR', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

    await expect(client.checkHealth()).rejects.toThrow(AppError);
  });

  it('getTasks queries GET /api/tasks with query params', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ data: [{ id: 'TSK-001', title: 'Task 1' }] }),
    });

    const tasks = await client.getTasks({ status: 'TODO', search: 'Task' });
    expect(tasks).toHaveLength(1);
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/tasks?status=TODO&search=Task');
  });

  it('getTask queries GET /api/tasks/:id', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ data: { id: 'TSK-001', title: 'Task 1' } }),
    });

    const task = await client.getTask('TSK-001');
    expect(task.id).toBe('TSK-001');
  });

  it('patchTask sends PATCH /api/tasks/:id with updates', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ data: { id: 'TSK-001', status: 'RUNNING' } }),
    });

    const task = await client.patchTask('TSK-001', { status: 'RUNNING' });
    expect(task.status).toBe('RUNNING');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/api/tasks/TSK-001');
    expect(init.method).toBe('PATCH');
  });

  it('getFeatures and getFeature query feature endpoints', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ data: [{ id: 'FEAT-001', name: 'Feature 1' }] }),
    });

    const features = await client.getFeatures();
    expect(features).toHaveLength(1);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ data: { id: 'FEAT-001', name: 'Feature 1' } }),
    });

    const feature = await client.getFeature('FEAT-001');
    expect(feature.id).toBe('FEAT-001');
  });

  it('checkHealth queries GET /api/health', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ data: { status: 'ok', timestamp: '2026-10-23T00:00:00Z' } }),
    });

    const health = await client.checkHealth();
    expect(health.status).toBe('ok');
  });
});
