import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiClient, type StreamConnectionState } from '../lib/api.js';
import { AppError, type EventRecord } from '@ai-orchestrator/shared';

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

  it('getTaskHistory queries GET /api/tasks/:id/history', async () => {
    const mockHistory = {
      taskId: 'TSK-001',
      taskTitle: 'Sample Task',
      taskStatus: 'DONE',
      attempts: 1,
      maxAttempts: 3,
      latestRun: null,
      latestCheckpoint: null,
      history: [],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ data: mockHistory }),
    });

    const res = await client.getTaskHistory('TSK-001');
    expect(res.taskId).toBe('TSK-001');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/api/tasks/TSK-001/history');
    expect(init.method).toBe('GET');
  });

  it('getRunDetail queries GET /api/runs/:id/detail', async () => {
    const mockDetail = {
      run: { id: 'run-1', task_id: 'TSK-001', attempt: 1, status: 'SUCCESS' },
      task: null,
      result: { outcome: 'SUCCESS', success: true },
      checkpoints: [],
      reports: [],
      events: [],
      eventStats: { total: 0, byType: {} },
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ data: mockDetail }),
    });

    const res = await client.getRunDetail('run-1');
    expect(res.run.id).toBe('run-1');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/api/runs/run-1/detail');
    expect(init.method).toBe('GET');
  });

  it('getTaskCheckpoints queries GET /api/tasks/:id/checkpoints with filter', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ data: [{ id: 'cp-1', step: 'compile' }] }),
    });

    const checkpoints = await client.getTaskCheckpoints('TSK-001', { attempt: 1, step: 'compile' });
    expect(checkpoints).toHaveLength(1);
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/api/tasks/TSK-001/checkpoints?attempt=1&step=compile');
  });

  it('getRunReports queries GET /api/runs/:id/reports with filter', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ data: [{ id: 'rep-1', kind: 'acceptance' }] }),
    });

    const reports = await client.getRunReports('run-1', { kind: 'acceptance' });
    expect(reports).toHaveLength(1);
    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/api/runs/run-1/reports?kind=acceptance');
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

  it('getRunStreamUrl returns formatted SSE endpoint with options', () => {
    const url1 = client.getRunStreamUrl('run-123');
    expect(url1).toBe('http://localhost:3000/runs/run-123/stream');

    const url2 = client.getRunStreamUrl('run-123', { afterSeq: 10, live: true });
    expect(url2).toBe('http://localhost:3000/runs/run-123/stream?after_seq=10&live=true');
  });

  it('subscribeToRunStream connects via custom EventSourceClass and receives events', async () => {
    const eventsReceived: EventRecord[] = [];
    const stateHistory: StreamConnectionState[] = [];
    let doneResult: { runId: string; status: string } | null = null;

    class MockEventSource {
      url: string;
      onopen: (() => void) | null = null;
      onmessage: ((evt: MessageEvent) => void) | null = null;
      onerror: ((evt: Event) => void) | null = null;
      listeners: Record<string, ((evt: MessageEvent) => void)[]> = {};

      constructor(url: string) {
        this.url = url;
        setTimeout(() => {
          this.onopen?.();
          this.emit('stdout', {
            data: JSON.stringify({
              id: 1,
              run_id: 'run-123',
              seq: 1,
              type: 'stdout',
              payload: 'Hello test',
              ts: '2026-10-23T00:00:00Z',
            }),
          } as MessageEvent);
          this.emit('done', {
            data: JSON.stringify({ runId: 'run-123', status: 'SUCCESS' }),
          } as MessageEvent);
        }, 10);
      }

      addEventListener(type: string, cb: (evt: MessageEvent) => void) {
        this.listeners[type] = this.listeners[type] ?? [];
        this.listeners[type]!.push(cb);
      }

      emit(type: string, evt: MessageEvent) {
        for (const cb of this.listeners[type] ?? []) {
          cb(evt);
        }
      }

      close = vi.fn();
    }

    const unsubscribe = client.subscribeToRunStream(
      'run-123',
      {
        onEvent: (e) => eventsReceived.push(e),
        onStateChange: (s) => stateHistory.push(s),
        onDone: (d) => {
          doneResult = d;
        },
      },
      {
        EventSourceClass: MockEventSource as unknown as typeof EventSource,
      },
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(eventsReceived).toHaveLength(1);
    expect(eventsReceived[0]?.type).toBe('stdout');
    expect(eventsReceived[0]?.payload).toBe('Hello test');
    expect(doneResult).toEqual({ runId: 'run-123', status: 'SUCCESS' });
    expect(stateHistory).toContain('connected');
    expect(stateHistory).toContain('completed');

    unsubscribe();
  });

  describe('UI-007: Controls & Review API Methods', () => {
    it('getSchedulerStatus calls GET /api/scheduler/status', async () => {
      const mockStatus = {
        isRunning: true,
        isPaused: false,
        activeLock: null,
        activeTaskId: 'TSK-1',
        activeRunId: 'RUN-1',
        readyTasksCount: 3,
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: mockStatus }),
      });

      const res = await client.getSchedulerStatus();
      expect(res).toEqual(mockStatus);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/scheduler/status',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('pauseScheduler and resumeScheduler call POST endpoints', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: { paused: true, isPaused: true } }),
      });

      const pauseRes = await client.pauseScheduler();
      expect(pauseRes).toEqual({ paused: true, isPaused: true });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/scheduler/pause',
        expect.objectContaining({ method: 'POST' }),
      );

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: { resumed: true, isPaused: false } }),
      });

      const resumeRes = await client.resumeScheduler();
      expect(resumeRes).toEqual({ resumed: true, isPaused: false });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/scheduler/resume',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('stopScheduler calls POST /api/scheduler/stop', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: { stopped: true, isRunning: false } }),
      });

      const res = await client.stopScheduler();
      expect(res).toEqual({ stopped: true, isRunning: false });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/scheduler/stop',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('stopRun calls POST /api/runs/:id/stop with reason', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: { stopped: true } }),
      });

      const res = await client.stopRun('run-99', { reason: 'User test stop' });
      expect(res.stopped).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/runs/run-99/stop',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ reason: 'User test stop' }),
        }),
      );
    });

    it('approvePlan calls POST /api/plans/:id/approve', async () => {
      const mockPlan = { id: 'plan-1', status: 'APPROVED', title: 'Plan 1' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: mockPlan }),
      });

      const res = await client.approvePlan('plan-1', {
        approved_by: 'lead-reviewer',
        comments: 'LGTM',
      });
      expect(res).toEqual(mockPlan);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/plans/plan-1/approve',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ approved_by: 'lead-reviewer', comments: 'LGTM' }),
        }),
      );
    });

    it('rejectPlan calls POST /api/plans/:id/reject with reason', async () => {
      const mockPlan = { id: 'plan-1', status: 'REJECTED', title: 'Plan 1' };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: mockPlan }),
      });

      const res = await client.rejectPlan('plan-1', {
        reason: 'Scope too broad',
        rejected_by: 'reviewer',
      });
      expect(res).toEqual(mockPlan);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/plans/plan-1/reject',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ reason: 'Scope too broad', rejected_by: 'reviewer' }),
        }),
      );
    });

    it('executePlan calls POST /api/plans/:id/execute', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: { planId: 'plan-1', status: 'EXECUTING' } }),
      });

      const res = await client.executePlan('plan-1', { autoStart: true });
      expect(res.status).toBe('EXECUTING');
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/plans/plan-1/execute',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ autoStart: true }),
        }),
      );
    });
  });
});
