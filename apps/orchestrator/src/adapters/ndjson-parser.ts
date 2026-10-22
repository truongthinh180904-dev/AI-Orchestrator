import { StringDecoder } from 'node:string_decoder';
import { Transform, type TransformCallback } from 'node:stream';
import {
  DEFAULT_MAX_LINE_LENGTH,
  type NdjsonParsedEvent,
  type NdjsonParseErrorEvent,
  type NdjsonParserOptions,
  type NdjsonStreamEvent,
} from '@ai-orchestrator/shared';

export {
  DEFAULT_MAX_LINE_LENGTH,
  type NdjsonParsedEvent,
  type NdjsonParseErrorEvent,
  type NdjsonParserOptions,
  type NdjsonStreamEvent,
};

function extractEventType(data: unknown): string {
  if (typeof data === 'object' && data !== null && 'type' in data) {
    const candidate = (data as Record<string, unknown>).type;
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return 'json';
}

export interface NdjsonParserEvents {
  event: (event: NdjsonParsedEvent) => void;
  parse_error: (errorEvent: NdjsonParseErrorEvent) => void;
  line: (line: string) => void;
  data: (streamEvent: NdjsonStreamEvent) => void;
  finish: () => void;
  close: () => void;
  end: () => void;
}

export class NdjsonParser extends Transform {
  private _buffer = '';
  private _decoder = new StringDecoder('utf8');
  private _seq: number;
  private readonly _maxLineLength: number;
  private readonly _ignoreWhitespaceOnly: boolean;
  private readonly _pushErrors: boolean;

  constructor(options: NdjsonParserOptions = {}) {
    super({
      readableObjectMode: true,
      writableObjectMode: false,
    });

    this._maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
    this._ignoreWhitespaceOnly = options.ignoreWhitespaceOnly ?? true;
    this._pushErrors = options.pushErrors ?? true;
    this._seq = options.initialSeq ?? 0;

    // Put stream into flowing mode by default so that push() does not block
    // or accumulate in memory if only event listeners (e.g. .on('event', ...)) are used.
    this.resume();
  }

  public get buffer(): string {
    return this._buffer;
  }

  public get currentSeq(): number {
    return this._seq;
  }

  public get maxLineLength(): number {
    return this._maxLineLength;
  }

  /**
   * Directly feeds a chunk (string or Buffer) into the parser without requiring stream piping.
   */
  public feed(chunk: Buffer | string): this {
    this._handleChunk(chunk);
    return this;
  }

  /**
   * Flushes any pending UTF-8 bytes from the decoder and processes any trailing line in the buffer.
   */
  public flush(): void {
    const remaining = this._decoder.end();
    if (remaining.length > 0) {
      this._buffer += remaining;
    }
    this._processBuffer(true);
  }

  /**
   * Resets the parser state (clearing internal buffer, decoder, and resetting seq).
   */
  public reset(newInitialSeq = 0): void {
    this._buffer = '';
    this._decoder = new StringDecoder('utf8');
    this._seq = newInitialSeq;
  }

  /**
   * Attaches this parser to a readable stream (e.g. processHandle.stdout or stderr).
   */
  public attach(stream: NodeJS.ReadableStream): this {
    stream.on('data', (chunk: Buffer | string) => {
      this._handleChunk(chunk);
    });

    stream.on('end', () => {
      this.flush();
      this.end();
    });

    return this;
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      this._handleChunk(chunk);
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.flush();
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private _handleChunk(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this._decoder.write(chunk);
    this._buffer += text;
    this._processBuffer(false);
  }

  private _processBuffer(isFlush: boolean): void {
    let newlineIndex: number;
    while ((newlineIndex = this._buffer.indexOf('\n')) !== -1) {
      const rawLine = this._buffer.slice(0, newlineIndex);
      this._buffer = this._buffer.slice(newlineIndex + 1);
      this._processLine(rawLine);
    }

    if (isFlush && this._buffer.length > 0) {
      const rawLine = this._buffer;
      this._buffer = '';
      this._processLine(rawLine);
    }

    // Protection against buffer growth without newline (memory exhaustion prevention)
    if (this._buffer.length > this._maxLineLength) {
      const oversizedContent = this._buffer;
      this._buffer = '';
      this._emitParseError(
        oversizedContent,
        new Error(
          `Line length (${oversizedContent.length}) exceeds maximum limit (${this._maxLineLength})`,
        ),
      );
    }
  }

  private _processLine(rawLine: string): void {
    let line = rawLine;
    if (line.endsWith('\r')) {
      line = line.slice(0, -1);
    }

    // Skip empty lines or whitespace-only lines if configured
    if (line.length === 0 || (this._ignoreWhitespaceOnly && line.trim().length === 0)) {
      return;
    }

    this.emit('line', line);

    if (line.length > this._maxLineLength) {
      this._emitParseError(
        line,
        new Error(`Line length (${line.length}) exceeds maximum limit (${this._maxLineLength})`),
      );
      return;
    }

    try {
      const data: unknown = JSON.parse(line);
      this._seq++;
      const type = extractEventType(data);
      const parsedEvent: NdjsonParsedEvent = {
        seq: this._seq,
        type,
        data,
        raw: rawLine,
        timestamp: new Date().toISOString(),
      };

      this.emit('event', parsedEvent);
      this.push(parsedEvent);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this._emitParseError(line, error);
    }
  }

  private _emitParseError(raw: string, error: Error): void {
    this._seq++;
    const errorEvent: NdjsonParseErrorEvent = {
      seq: this._seq,
      type: 'parse_error',
      raw,
      error,
      errorMessage: error.message,
      timestamp: new Date().toISOString(),
    };

    // Emitting 'parse_error' will NOT crash Node.js EventEmitter if no listener is registered.
    this.emit('parse_error', errorEvent);

    if (this._pushErrors) {
      this.push(errorEvent);
    }
  }

  /**
   * Synchronously parses a string or Buffer containing NDJSON lines.
   */
  public static parse(
    input: string | Buffer,
    options?: NdjsonParserOptions,
  ): {
    events: NdjsonParsedEvent[];
    errors: NdjsonParseErrorEvent[];
  } {
    const parser = new NdjsonParser(options);
    const events: NdjsonParsedEvent[] = [];
    const errors: NdjsonParseErrorEvent[] = [];

    parser.on('event', (evt) => events.push(evt));
    parser.on('parse_error', (err) => errors.push(err));

    parser.feed(input);
    parser.flush();

    return { events, errors };
  }

  /**
   * Asynchronously parses a readable stream of NDJSON lines until stream end.
   */
  public static async parseStream(
    stream: NodeJS.ReadableStream,
    options?: NdjsonParserOptions,
  ): Promise<{
    events: NdjsonParsedEvent[];
    errors: NdjsonParseErrorEvent[];
  }> {
    return new Promise((resolve, reject) => {
      const parser = new NdjsonParser(options);
      const events: NdjsonParsedEvent[] = [];
      const errors: NdjsonParseErrorEvent[] = [];

      parser.on('event', (evt) => events.push(evt));
      parser.on('parse_error', (err) => errors.push(err));

      parser.on('finish', () => resolve({ events, errors }));
      parser.on('error', reject);

      stream.pipe(parser);
    });
  }
}
