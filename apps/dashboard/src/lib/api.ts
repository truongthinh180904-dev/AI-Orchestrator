import {
  AppError,
  type ImportDryRunResult,
  type ImportCommitResult,
  type TaskWithDependencies,
  type Feature,
  type TaskFilter,
  type FeatureFilter,
  type UpdateTaskInput,
} from '@ai-orchestrator/shared';

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
}

export const api = new ApiClient();
