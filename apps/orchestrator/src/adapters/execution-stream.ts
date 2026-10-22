import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import {
  type EventRecord,
  type EventFilter,
  type CreateEventInput,
  type ProcessExitResult,
  type RunStatus,
  STANDARD_EVENT_TYPES,
} from '@ai-orchestrator/shared';
import { type ProcessHandle } from './process-adapter.js';
import {
  NdjsonParser,
  type NdjsonParsedEvent,
  type NdjsonParseErrorEvent,
} from './ndjson-parser.js';

export interface EventRecorderTarget {
  create(input: CreateEventInput): EventRecord;
  getNextSeq(runId: string): number;
  findByRunId(runId: string, filter?: EventFilter): EventRecord[];
  getRawLogs(runId: string): { type: string; text: string; seq: number; ts: string }[];
}

export interface RunRecorderTarget {
  updateStatus(
    id: string,
    status: RunStatus,
    details?: { exit_code?: number | null; finished_at?: string; pid?: number | null },
  ): unknown;
}

export interface ExecutionStreamOptions {
  runId: string;
  handle: ProcessHandle;
  eventRepository: EventRecorderTarget;
  runRepository?: RunRecorderTarget;
  recordRawStdout?: boolean;
  recordRawStderr?: boolean;
  recordParsedEvents?: boolean;
  recordLifecycle?: boolean;
  initialSeq?: number;
}

export interface ExecutionCompletionResult extends ProcessExitResult {
  events: EventRecord[];
}

export class ExecutionStreamRecorder extends EventEmitter {
  public readonly runId: string;
  private readonly _handle: ProcessHandle;
  private readonly _eventRepo: EventRecorderTarget;
  private readonly _runRepo?: RunRecorderTarget;
  private readonly _recordRawStdout: boolean;
  private readonly _recordRawStderr: boolean;
  private readonly _recordParsedEvents: boolean;
  private readonly _recordLifecycle: boolean;

  private _seq: number;
  private _ndjsonParser: NdjsonParser;
  private _stderrDecoder = new StringDecoder('utf8');
  private _stderrBuffer = '';
  private _completed = false;
  private readonly _completionPromise: Promise<ExecutionCompletionResult>;
  private _resolveCompletion!: (result: ExecutionCompletionResult) => void;
  private _rejectCompletion!: (err: Error) => void;

  constructor(options: ExecutionStreamOptions) {
    super();

    this.runId = options.runId;
    this._handle = options.handle;
    this._eventRepo = options.eventRepository;
    this._runRepo = options.runRepository;
    this._recordRawStdout = options.recordRawStdout ?? true;
    this._recordRawStderr = options.recordRawStderr ?? true;
    this._recordParsedEvents = options.recordParsedEvents ?? true;
    this._recordLifecycle = options.recordLifecycle ?? true;

    this._seq = options.initialSeq ?? this._eventRepo.getNextSeq(this.runId) - 1;

    this._completionPromise = new Promise<ExecutionCompletionResult>((resolve, reject) => {
      this._resolveCompletion = resolve;
      this._rejectCompletion = reject;
    });
    this._completionPromise.catch(() => {});

    this._ndjsonParser = new NdjsonParser({
      pushErrors: true,
      ignoreWhitespaceOnly: true,
      initialSeq: 0,
    });

    this._setupListeners();
  }

  public get currentSeq(): number {
    return this._seq;
  }

  public get isCompleted(): boolean {
    return this._completed;
  }

  public get handle(): ProcessHandle {
    return this._handle;
  }

  public waitForCompletion(): Promise<ExecutionCompletionResult> {
    return this._completionPromise;
  }

  public getEvents(filter?: EventFilter): EventRecord[] {
    return this._eventRepo.findByRunId(this.runId, filter);
  }

  public getRawLogs(): { type: string; text: string; seq: number; ts: string }[] {
    return this._eventRepo.getRawLogs(this.runId);
  }

  /**
   * Manually record a custom event into the run stream.
   */
  public recordEvent(type: string, payload: unknown, customTs?: string): EventRecord {
    this._seq++;
    const input: CreateEventInput = {
      run_id: this.runId,
      seq: this._seq,
      type,
      payload,
      ts: customTs ?? new Date().toISOString(),
    };

    const record = this._eventRepo.create(input);
    this.emit('event', record);
    this.emit(type, record);
    return record;
  }

  private _setupListeners(): void {
    // 1. Record process start if lifecycle recording is enabled
    if (this._recordLifecycle) {
      this.recordEvent(STANDARD_EVENT_TYPES.PROCESS_START, {
        pid: this._handle.pid,
        command: {
          exe: this._handle.command.exe,
          args: this._handle.command.args,
          cwd: this._handle.command.cwd,
        },
        startedAt: this._handle.startedAt.toISOString(),
      });
    }

    // 2. Attach NdjsonParser to stdout
    this._ndjsonParser.on('line', (line: string) => {
      if (this._recordRawStdout) {
        this.recordEvent(STANDARD_EVENT_TYPES.STDOUT, { text: line });
      }
    });

    this._ndjsonParser.on('event', (parsed: NdjsonParsedEvent) => {
      if (this._recordParsedEvents) {
        this.recordEvent(parsed.type, parsed.data);
      }
    });

    this._ndjsonParser.on('parse_error', (parseError: NdjsonParseErrorEvent) => {
      this.recordEvent(STANDARD_EVENT_TYPES.PARSE_ERROR, {
        raw: parseError.raw,
        errorMessage: parseError.errorMessage,
      });
    });

    if (this._handle.child.stdout) {
      this._handle.child.stdout.on('data', (chunk: Buffer) => {
        this._ndjsonParser.feed(chunk);
      });
    }

    // 3. Attach line-buffering to stderr
    if (this._handle.child.stderr) {
      this._handle.child.stderr.on('data', (chunk: Buffer) => {
        const text = typeof chunk === 'string' ? chunk : this._stderrDecoder.write(chunk);
        this._stderrBuffer += text;
        this._processStderrBuffer(false);
      });
    }

    // 4. Handle process error
    this._handle.on('error', (err: Error) => {
      this.recordEvent('process_error', {
        message: err.message,
        name: err.name,
      });
      if (!this._completed) {
        this._completed = true;
        this._rejectCompletion(err);
      }
    });

    // 5. Handle process close
    this._handle.on('close', (exitCode, signal, durationMs) => {
      this._flushStreams();

      if (this._recordLifecycle) {
        this.recordEvent(STANDARD_EVENT_TYPES.PROCESS_EXIT, {
          exitCode,
          signal,
          durationMs,
        });
      }

      if (this._runRepo) {
        try {
          this._runRepo.updateStatus(this.runId, exitCode === 0 ? 'SUCCESS' : 'ERROR', {
            exit_code: exitCode,
            finished_at: new Date().toISOString(),
          });
        } catch {
          // Suppress error updating run status if run record does not exist
        }
      }

      this._completed = true;
      const allEvents = this.getEvents();
      this.emit('finish', allEvents);

      this._resolveCompletion({
        exitCode,
        signal,
        durationMs,
        events: allEvents,
      });
    });
  }

  private _processStderrBuffer(isFlush: boolean): void {
    let newlineIndex: number;
    while ((newlineIndex = this._stderrBuffer.indexOf('\n')) !== -1) {
      const line = this._stderrBuffer.slice(0, newlineIndex);
      this._stderrBuffer = this._stderrBuffer.slice(newlineIndex + 1);
      this._emitStderrLine(line);
    }

    if (isFlush && this._stderrBuffer.length > 0) {
      const line = this._stderrBuffer;
      this._stderrBuffer = '';
      this._emitStderrLine(line);
    }
  }

  private _emitStderrLine(rawLine: string): void {
    let line = rawLine;
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }
    if (line.trim().length === 0) {
      return;
    }
    if (this._recordRawStderr) {
      this.recordEvent(STANDARD_EVENT_TYPES.STDERR, { text: line });
    }
  }

  private _flushStreams(): void {
    this._ndjsonParser.flush();

    const remainingStderr = this._stderrDecoder.end();
    if (remainingStderr.length > 0) {
      this._stderrBuffer += remainingStderr;
    }
    this._processStderrBuffer(true);
  }
}

export function attachExecutionStream(options: ExecutionStreamOptions): ExecutionStreamRecorder {
  return new ExecutionStreamRecorder(options);
}
