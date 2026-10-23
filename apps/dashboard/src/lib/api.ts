import {
  AppError,
  type ImportDryRunResult,
  type ImportCommitResult,
  type TaskWithDependencies,
  type Feature,
  type TaskFilter,
  type FeatureFilter,
  type UpdateTaskInput,
  type TaskRunHistory,
  type RunDetail,
  type Checkpoint,
  type CheckpointFilter,
  type Report,
  type ReportFilter,
  type EventRecord,
  type TaskDiffData,
  type ScopeDiffResult,
  type CompareScopeInput,
} from '@ai-orchestrator/shared';

export type StreamConnectionState =
  'connecting' | 'connected' | 'disconnected' | 'completed' | 'error';

export interface StreamHandlers {
  onEvent?: (event: EventRecord) => void;
  onError?: (error: Error) => void;
  onDone?: (data: { runId: string; status: string }) => void;
  onStateChange?: (state: StreamConnectionState) => void;
  onHeartbeat?: () => void;
}

export interface StreamOptions {
  afterSeq?: number;
  live?: boolean;
  EventSourceClass?: typeof EventSource;
  reconnect?: boolean;
  reconnectIntervalMs?: number;
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface ImportSourceParams {
  filePath?: string;
  file?: File | Blob;
  filename?: string;
  fileContent?: string;
  files?: Record<string, string>;
  tasks?: Record<string, unknown>[];
  features?: Record<string, unknown>[];
  repository?: string;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (
      options.baseUrl ??
      (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_ORCH_URL
        ? process.env.NEXT_PUBLIC_ORCH_URL
        : 'http://127.0.0.1:3000')
    ).replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private async request<T>(endpoint: string, init?: RequestInit): Promise<T> {
    const url = `${this.baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, init);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError('NETWORK_ERROR', `Failed to connect to API at ${url}: ${message}`, {
        originalError: message,
      });
    }

    const contentType = res.headers.get('content-type') ?? '';
    const isJson = contentType.includes('application/json');

    if (!res.ok) {
      if (isJson) {
        const errorBody = (await res.json()) as {
          error?: { code?: string; message?: string; context?: unknown };
          message?: string;
        };
        const code = errorBody?.error?.code ?? `HTTP_${res.status}`;
        const message =
          errorBody?.error?.message ??
          errorBody?.message ??
          `Request failed with status ${res.status}`;
        const context = errorBody?.error?.context;
        throw new AppError(
          code,
          message,
          context ? (context as Record<string, unknown>) : undefined,
        );
      }
      const rawText = await res.text();
      throw new AppError(
        `HTTP_${res.status}`,
        rawText || `Request failed with status ${res.status}`,
      );
    }

    if (isJson) {
      const body = (await res.json()) as { data?: T } & T;
      return (body && typeof body === 'object' && 'data' in body ? body.data : body) as T;
    }

    return (await res.text()) as unknown as T;
  }

  private buildImportPayload(
    params: ImportSourceParams,
    mode: 'dry-run' | 'commit',
  ): { body: string | FormData; headers?: Record<string, string> } {
    if (params.file) {
      const formData = new FormData();
      formData.append('file', params.file, params.filename ?? 'import-file');
      formData.append('mode', mode);
      formData.append('dryRun', mode === 'dry-run' ? 'true' : 'false');
      if (params.filePath) formData.append('filePath', params.filePath);
      return { body: formData };
    }

    const jsonPayload: Record<string, unknown> = {
      mode,
      dryRun: mode === 'dry-run',
    };

    if (params.filePath) jsonPayload.filePath = params.filePath;
    if (params.fileContent) jsonPayload.fileContent = params.fileContent;
    if (params.filename) jsonPayload.filename = params.filename;
    if (params.files) jsonPayload.files = params.files;
    if (params.tasks) jsonPayload.tasks = params.tasks;
    if (params.features) jsonPayload.features = params.features;

    return {
      body: JSON.stringify(jsonPayload),
      headers: {
        'Content-Type': 'application/json',
      },
    };
  }

  async previewImport(params: ImportSourceParams): Promise<ImportDryRunResult> {
    const { body, headers } = this.buildImportPayload(params, 'dry-run');
    return this.request<ImportDryRunResult>('/api/import', {
      method: 'POST',
      body,
      headers,
    });
  }

  async commitImport(params: ImportSourceParams): Promise<ImportCommitResult> {
    const { body, headers } = this.buildImportPayload(params, 'commit');
    return this.request<ImportCommitResult>('/api/import', {
      method: 'POST',
      body,
      headers,
    });
  }

  async getTasks(
    filter?: Partial<TaskFilter> & { search?: string },
  ): Promise<TaskWithDependencies[]> {
    const query = new URLSearchParams();
    if (filter?.status) query.set('status', filter.status);
    if (filter?.feature_id) query.set('feature_id', filter.feature_id);
    if (filter?.phase) query.set('phase', filter.phase);
    if (filter?.search) query.set('search', filter.search);

    const qs = query.toString();
    const endpoint = `/api/tasks${qs ? `?${qs}` : ''}`;
    return this.request<TaskWithDependencies[]>(endpoint, {
      method: 'GET',
    });
  }

  async getTask(id: string): Promise<TaskWithDependencies> {
    return this.request<TaskWithDependencies>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
  }

  async getTaskDiff(
    id: string,
    options?: {
      baseRef?: string;
      targetRef?: string;
      includeUntracked?: boolean;
    },
  ): Promise<TaskDiffData> {
    const query = new URLSearchParams();
    if (options?.baseRef) query.set('baseRef', options.baseRef);
    if (options?.targetRef) query.set('targetRef', options.targetRef);
    if (options?.includeUntracked !== undefined) {
      query.set('includeUntracked', String(options.includeUntracked));
    }

    const qs = query.toString();
    const endpoint = `/api/tasks/${encodeURIComponent(id)}/diff${qs ? `?${qs}` : ''}`;
    return this.request<TaskDiffData>(endpoint, {
      method: 'GET',
    });
  }

  async getTaskScopeDiff(
    id: string,
    options?: {
      baseRef?: string;
      targetRef?: string;
      includeUntracked?: boolean;
      runId?: string;
    },
  ): Promise<ScopeDiffResult> {
    const query = new URLSearchParams();
    if (options?.baseRef) query.set('baseRef', options.baseRef);
    if (options?.targetRef) query.set('targetRef', options.targetRef);
    if (options?.includeUntracked !== undefined) {
      query.set('includeUntracked', String(options.includeUntracked));
    }
    if (options?.runId) query.set('runId', options.runId);

    const qs = query.toString();
    const endpoint = `/api/tasks/${encodeURIComponent(id)}/scope-diff${qs ? `?${qs}` : ''}`;
    return this.request<ScopeDiffResult>(endpoint, {
      method: 'GET',
    });
  }

  async compareScopeDiff(input: CompareScopeInput): Promise<ScopeDiffResult> {
    return this.request<ScopeDiffResult>('/api/quality/scope-diff', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
    });
  }

  async getTaskHistory(id: string): Promise<TaskRunHistory> {
    return this.request<TaskRunHistory>(`/api/tasks/${encodeURIComponent(id)}/history`, {
      method: 'GET',
    });
  }

  async getTaskCheckpoints(id: string, filter?: Partial<CheckpointFilter>): Promise<Checkpoint[]> {
    const query = new URLSearchParams();
    if (filter?.attempt) query.set('attempt', String(filter.attempt));
    if (filter?.step) query.set('step', filter.step);
    if (filter?.status) query.set('status', filter.status);
    if (filter?.run_id) query.set('run_id', filter.run_id);

    const qs = query.toString();
    return this.request<Checkpoint[]>(
      `/api/tasks/${encodeURIComponent(id)}/checkpoints${qs ? `?${qs}` : ''}`,
      {
        method: 'GET',
      },
    );
  }

  async getRunDetail(id: string): Promise<RunDetail> {
    return this.request<RunDetail>(`/api/runs/${encodeURIComponent(id)}/detail`, {
      method: 'GET',
    });
  }

  async getRunReports(runId: string, filter?: Partial<ReportFilter>): Promise<Report[]> {
    const query = new URLSearchParams();
    if (filter?.kind) query.set('kind', filter.kind);
    const qs = query.toString();
    return this.request<Report[]>(
      `/api/runs/${encodeURIComponent(runId)}/reports${qs ? `?${qs}` : ''}`,
      {
        method: 'GET',
      },
    );
  }

  async patchTask(id: string, updates: UpdateTaskInput): Promise<TaskWithDependencies> {
    return this.request<TaskWithDependencies>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updates),
    });
  }

  async getFeatures(filter?: Partial<FeatureFilter>): Promise<Feature[]> {
    const query = new URLSearchParams();
    if (filter?.status) query.set('status', filter.status);

    const qs = query.toString();
    const endpoint = `/api/features${qs ? `?${qs}` : ''}`;
    return this.request<Feature[]>(endpoint, {
      method: 'GET',
    });
  }

  async getFeature(id: string): Promise<Feature> {
    return this.request<Feature>(`/api/features/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
  }

  async checkHealth(): Promise<{ status: string; timestamp?: string }> {
    return this.request<{ status: string; timestamp?: string }>('/api/health', {
      method: 'GET',
    });
  }

  getRunStreamUrl(runId: string, options?: { afterSeq?: number; live?: boolean }): string {
    const query = new URLSearchParams();
    if (options?.afterSeq !== undefined) query.set('after_seq', String(options.afterSeq));
    if (options?.live !== undefined) query.set('live', String(options.live));
    const qs = query.toString();
    return `${this.baseUrl}/runs/${encodeURIComponent(runId)}/stream${qs ? `?${qs}` : ''}`;
  }

  subscribeToRunStream(
    runId: string,
    handlers: StreamHandlers,
    options: StreamOptions = {},
  ): () => void {
    let closed = false;
    let currentAfterSeq = options.afterSeq;
    const reconnectEnabled = options.reconnect ?? false;
    const reconnectIntervalMs = options.reconnectIntervalMs ?? 2000;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let abortController: AbortController | null = null;
    let activeEventSource: EventSource | null = null;

    const cleanupActive = () => {
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      if (activeEventSource) {
        activeEventSource.close();
        activeEventSource = null;
      }
    };

    const handleEvent = (event: EventRecord) => {
      if (closed) return;
      if (event.seq > (currentAfterSeq ?? 0)) {
        currentAfterSeq = event.seq;
      }
      handlers.onEvent?.(event);
    };

    const handleDone = (data: { runId: string; status: string }) => {
      if (closed) return;
      handlers.onStateChange?.('completed');
      handlers.onDone?.(data);
      closed = true;
      cleanupActive();
    };

    const connect = () => {
      if (closed) return;
      handlers.onStateChange?.('connecting');

      const ESClass =
        options.EventSourceClass ??
        (typeof globalThis !== 'undefined' ? globalThis.EventSource : undefined);

      if (ESClass) {
        const url = this.getRunStreamUrl(runId, {
          afterSeq: currentAfterSeq,
          live: options.live,
        });

        try {
          const es = new ESClass(url);
          activeEventSource = es;

          es.onopen = () => {
            if (closed) return;
            handlers.onStateChange?.('connected');
          };

          const COMMON_EVENT_TYPES = [
            'stdout',
            'stderr',
            'process_start',
            'process_exit',
            'checkpoint',
            'agent_output',
            'result',
            'parse_error',
            'message',
          ];

          const parseAndDispatch = (dataStr: string) => {
            try {
              const parsed = JSON.parse(dataStr) as EventRecord;
              handleEvent(parsed);
            } catch {
              // ignore invalid JSON in event data
            }
          };

          es.onmessage = (evt) => {
            if (closed) return;
            parseAndDispatch(evt.data);
          };

          for (const type of COMMON_EVENT_TYPES) {
            es.addEventListener(type, (evt) => {
              if (closed) return;
              parseAndDispatch((evt as MessageEvent).data);
            });
          }

          es.addEventListener('done', (evt) => {
            if (closed) return;
            try {
              const parsed = JSON.parse((evt as MessageEvent).data) as {
                runId: string;
                status: string;
              };
              handleDone(parsed);
            } catch {
              handleDone({ runId, status: 'DONE' });
            }
          });

          es.onerror = () => {
            if (closed) return;
            handlers.onStateChange?.('disconnected');
            if (!reconnectEnabled) {
              handlers.onError?.(new Error(`EventSource connection failed for run ${runId}`));
            }
          };
        } catch (err) {
          if (closed) return;
          const error = err instanceof Error ? err : new Error(String(err));
          handlers.onStateChange?.('error');
          handlers.onError?.(error);
        }
      } else {
        // Fallback to fetch streaming with ReadableStream / line parsing
        abortController = new AbortController();
        const url = this.getRunStreamUrl(runId, {
          afterSeq: currentAfterSeq,
          live: options.live,
        });

        const startFetchStream = async () => {
          try {
            const res = await this.fetchFn(url, {
              headers: {
                Accept: 'text/event-stream',
                'Cache-Control': 'no-cache',
                ...(currentAfterSeq !== undefined
                  ? { 'last-event-id': String(currentAfterSeq) }
                  : {}),
              },
              signal: abortController?.signal,
            });

            if (!res.ok) {
              throw new Error(`SSE stream request failed with status ${res.status}`);
            }

            handlers.onStateChange?.('connected');

            if (!res.body) {
              throw new Error('Response body is null, cannot stream');
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (!closed) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const blocks = buffer.split('\n\n');
              buffer = blocks.pop() ?? '';

              for (const block of blocks) {
                if (closed) break;
                if (!block.trim()) continue;

                let eventType = 'message';
                let dataStr = '';

                for (const line of block.split('\n')) {
                  if (line.startsWith(':')) {
                    handlers.onHeartbeat?.();
                  } else if (line.startsWith('event:')) {
                    eventType = line.slice(6).trim();
                  } else if (line.startsWith('data:')) {
                    dataStr += (dataStr ? '\n' : '') + line.slice(5).trim();
                  }
                }

                if (eventType === 'done') {
                  try {
                    const parsed = JSON.parse(dataStr) as { runId: string; status: string };
                    handleDone(parsed);
                  } catch {
                    handleDone({ runId, status: 'DONE' });
                  }
                  return;
                }

                if (dataStr) {
                  try {
                    const event = JSON.parse(dataStr) as EventRecord;
                    handleEvent(event);
                  } catch {
                    // skip parse error
                  }
                }
              }
            }

            if (!closed) {
              handlers.onStateChange?.('disconnected');
              if (reconnectEnabled) {
                reconnectTimeout = setTimeout(connect, reconnectIntervalMs);
              }
            }
          } catch (err) {
            if (closed) return;
            handlers.onStateChange?.('error');
            const error = err instanceof Error ? err : new Error(String(err));
            handlers.onError?.(error);

            if (reconnectEnabled) {
              reconnectTimeout = setTimeout(connect, reconnectIntervalMs);
            }
          }
        };

        void startFetchStream();
      }
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      cleanupActive();
      handlers.onStateChange?.('disconnected');
    };
  }
}

export const api = new ApiClient();
