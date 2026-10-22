import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import {
  NdjsonParser,
  type NdjsonParsedEvent,
  type NdjsonParseErrorEvent,
  type NdjsonStreamEvent,
} from '../adapters/ndjson-parser.js';
import {
  NdjsonParsedEventSchema,
  NdjsonParseErrorEventSchema,
  NdjsonStreamEventSchema,
} from '@ai-orchestrator/shared';

describe('NdjsonParser Unit Tests', () => {
  describe('Chunk split in the middle of a line (chunk cắt giữa dòng)', () => {
    it('buffers incomplete lines and emits event when newline arrives in subsequent chunk', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      parser.on('event', (evt) => events.push(evt));

      // Feed partial chunk
      parser.feed('{"id": 1, "status": "star');
      expect(events.length).toBe(0);
      expect(parser.buffer).toBe('{"id": 1, "status": "star');

      // Feed rest of the chunk with newline
      parser.feed('ted"}\n');
      expect(events.length).toBe(1);
      expect(events[0]?.seq).toBe(1);
      expect(events[0]?.data).toEqual({ id: 1, status: 'started' });
      expect(events[0]?.type).toBe('json');
      expect(parser.buffer).toBe('');
    });

    it('handles a single line split across three chunks', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      parser.on('event', (evt) => events.push(evt));

      parser.feed('{"step": "bu');
      parser.feed('ild", "progre');
      parser.feed('ss": 50}\n');

      expect(events.length).toBe(1);
      expect(events[0]?.data).toEqual({ step: 'build', progress: 50 });
    });

    it('handles multiple lines interleaved across chunk boundaries', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      parser.on('event', (evt) => events.push(evt));

      parser.feed('{"line": 1}\n{"line": 2, "va');
      expect(events.length).toBe(1);
      expect(events[0]?.data).toEqual({ line: 1 });

      parser.feed('lue": "partial"}\n{"line": 3');
      expect(events.length).toBe(2);
      expect(events[1]?.data).toEqual({ line: 2, value: 'partial' });

      parser.feed('}\n');
      expect(events.length).toBe(3);
      expect(events[2]?.data).toEqual({ line: 3 });
    });

    it('correctly decodes multi-byte UTF-8 split across byte chunks without corruption', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      parser.on('event', (evt) => events.push(evt));

      // Vietnamese text + 4-byte emoji: "Tiếng Việt 🚀 Thành công"
      const payload = { message: 'Tiếng Việt 🚀 Hoàn thành nhiệm vụ' };
      const jsonLine = JSON.stringify(payload) + '\n';
      const fullBuffer = Buffer.from(jsonLine, 'utf8');

      // Find the index of the emoji 🚀 in bytes and split right inside it
      // The rocket emoji 🚀 is 4 bytes: 0xF0 0x9F 0x9A 0x80
      const emojiIndex = fullBuffer.indexOf(Buffer.from('🚀', 'utf8'));
      expect(emojiIndex).toBeGreaterThan(0);

      // Split 2 bytes into the 4-byte emoji
      const splitPoint = emojiIndex + 2;
      const chunk1 = fullBuffer.subarray(0, splitPoint);
      const chunk2 = fullBuffer.subarray(splitPoint);

      parser.feed(chunk1);
      expect(events.length).toBe(0);

      parser.feed(chunk2);
      expect(events.length).toBe(1);
      expect(events[0]?.data).toEqual(payload);
      expect((events[0]?.data as typeof payload).message).toContain('Tiếng Việt 🚀');
    });

    it('flushes trailing line without trailing newline when stream ends / flush is called', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      parser.on('event', (evt) => events.push(evt));

      parser.feed('{"final": true}');
      expect(events.length).toBe(0);

      parser.flush();
      expect(events.length).toBe(1);
      expect(events[0]?.data).toEqual({ final: true });
      expect(parser.buffer).toBe('');
    });
  });

  describe('Malformed lines and error handling (dòng lỗi, không crash)', () => {
    it('emits parse_error event on invalid JSON syntax and does not crash', () => {
      const parser = new NdjsonParser();
      const parseErrors: NdjsonParseErrorEvent[] = [];
      const events: NdjsonParsedEvent[] = [];

      parser.on('parse_error', (err) => parseErrors.push(err));
      parser.on('event', (evt) => events.push(evt));

      parser.feed('this is completely invalid json\n');

      expect(parseErrors.length).toBe(1);
      expect(events.length).toBe(0);

      const err = parseErrors[0]!;
      expect(err.type).toBe('parse_error');
      expect(err.raw).toBe('this is completely invalid json');
      expect(err.seq).toBe(1);
      expect(err.errorMessage).toBeDefined();
      expect(err.error).toBeInstanceOf(Error);
      expect(err.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Validate against Zod schema
      expect(() => NdjsonParseErrorEventSchema.parse(err)).not.toThrow();
    });

    it('does not crash or throw uncaught exception even if no parse_error listener is registered', () => {
      const parser = new NdjsonParser();
      // Notice: NO listener on 'parse_error'
      expect(() => {
        parser.feed('{bad-json: broken}\n');
      }).not.toThrow();

      expect(parser.currentSeq).toBe(1);
    });

    it('recovers immediately and processes subsequent valid lines after encountering errors', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      const errors: NdjsonParseErrorEvent[] = [];

      parser.on('event', (evt) => events.push(evt));
      parser.on('parse_error', (err) => errors.push(err));

      parser.feed('{"step": 1}\n');
      parser.feed('Random unparseable log text from process\n');
      parser.feed('{"step": 2}\n');
      parser.feed('{"incomplete":\n');
      parser.feed('{"step": 3}\n');

      expect(events.length).toBe(3);
      expect(errors.length).toBe(2);

      expect(events.map((e) => e.data)).toEqual([{ step: 1 }, { step: 2 }, { step: 3 }]);
      expect(errors[0]?.raw).toBe('Random unparseable log text from process');
      expect(errors[1]?.raw).toBe('{"incomplete":');

      // Sequence numbers strictly monotonic
      expect(events[0]?.seq).toBe(1);
      expect(errors[0]?.seq).toBe(2);
      expect(events[1]?.seq).toBe(3);
      expect(errors[1]?.seq).toBe(4);
      expect(events[2]?.seq).toBe(5);
    });

    it('safely discards lines exceeding maxLineLength and emits parse_error to protect memory', () => {
      const parser = new NdjsonParser({ maxLineLength: 50 });
      const errors: NdjsonParseErrorEvent[] = [];
      parser.on('parse_error', (err) => errors.push(err));

      const longString = 'x'.repeat(100);
      parser.feed(`{"msg": "${longString}"}\n`);

      expect(errors.length).toBe(1);
      expect(errors[0]?.errorMessage).toContain('exceeds maximum limit');
      expect(parser.buffer).toBe('');
    });

    it('safely drops oversized buffer without newline to prevent memory exhaustion', () => {
      const parser = new NdjsonParser({ maxLineLength: 50 });
      const errors: NdjsonParseErrorEvent[] = [];
      parser.on('parse_error', (err) => errors.push(err));

      // Feed more than 50 bytes without newline
      parser.feed('a'.repeat(60));

      expect(errors.length).toBe(1);
      expect(errors[0]?.errorMessage).toContain('exceeds maximum limit');
      expect(parser.buffer).toBe('');
    });
  });

  describe('Empty and whitespace lines (dòng rỗng)', () => {
    it('completely ignores empty lines without emitting events or errors', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      const errors: NdjsonParseErrorEvent[] = [];

      parser.on('event', (evt) => events.push(evt));
      parser.on('parse_error', (err) => errors.push(err));

      parser.feed('\n\n\n');
      expect(events.length).toBe(0);
      expect(errors.length).toBe(0);
      expect(parser.currentSeq).toBe(0);
    });

    it('ignores whitespace-only lines (spaces and tabs)', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      const errors: NdjsonParseErrorEvent[] = [];

      parser.on('event', (evt) => events.push(evt));
      parser.on('parse_error', (err) => errors.push(err));

      parser.feed('   \n\t\t\t\n  \t  \n');
      expect(events.length).toBe(0);
      expect(errors.length).toBe(0);
    });

    it('handles Windows CRLF (\\r\\n) and ignores empty CRLF lines', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      parser.on('event', (evt) => events.push(evt));

      parser.feed('\r\n\r\n{"os": "windows"}\r\n\r\n');
      expect(events.length).toBe(1);
      expect(events[0]?.data).toEqual({ os: 'windows' });
    });

    it('accurately parses valid lines interspersed with multiple empty lines', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      parser.on('event', (evt) => events.push(evt));

      const input = '\n\n{"a": 1}\n\n\n\n{"b": 2}\n\n';
      parser.feed(input);

      expect(events.length).toBe(2);
      expect(events[0]?.data).toEqual({ a: 1 });
      expect(events[0]?.seq).toBe(1);
      expect(events[1]?.data).toEqual({ b: 2 });
      expect(events[1]?.seq).toBe(2);
    });
  });

  describe('Event types and schema validation', () => {
    it('extracts event type property when present in JSON object', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      parser.on('event', (evt) => events.push(evt));

      parser.feed('{"type": "progress", "percent": 75}\n');
      parser.feed('{"type": "result", "status": "SUCCESS"}\n');
      parser.feed('{"noType": true}\n');

      expect(events.length).toBe(3);
      expect(events[0]?.type).toBe('progress');
      expect(events[1]?.type).toBe('result');
      expect(events[2]?.type).toBe('json');

      for (const e of events) {
        expect(() => NdjsonParsedEventSchema.parse(e)).not.toThrow();
        expect(() => NdjsonStreamEventSchema.parse(e)).not.toThrow();
      }
    });

    it('emits line event for every candidate line before parsing', () => {
      const parser = new NdjsonParser();
      const lines: string[] = [];
      parser.on('line', (l) => lines.push(l));

      parser.feed('{"x": 1}\ninvalid json\n');

      expect(lines).toEqual(['{"x": 1}', 'invalid json']);
    });
  });

  describe('Static helpers: parse and parseStream', () => {
    it('NdjsonParser.parse parses complete string synchronously', () => {
      const content = `
{"type": "init", "v": 1}
not valid json
{"type": "done", "ok": true}
`;
      const result = NdjsonParser.parse(content);

      expect(result.events.length).toBe(2);
      expect(result.errors.length).toBe(1);
      expect(result.events[0]?.type).toBe('init');
      expect(result.events[1]?.type).toBe('done');
      expect(result.errors[0]?.raw).toBe('not valid json');
    });

    it('NdjsonParser.parseStream reads from readable stream asynchronously', async () => {
      const chunks = ['{"part": 1}\n{"pa', 'rt": 2}\n', 'malformed\n{"part": 3}\n'];
      const stream = Readable.from(chunks);

      const result = await NdjsonParser.parseStream(stream);

      expect(result.events.length).toBe(3);
      expect(result.errors.length).toBe(1);
      expect(result.events.map((e) => (e.data as { part: number }).part)).toEqual([1, 2, 3]);
    });
  });

  describe('Reset and State Control', () => {
    it('resets buffer and allows resetting initial sequence number', () => {
      const parser = new NdjsonParser({ initialSeq: 10 });
      parser.feed('{"a": 1}\n');
      expect(parser.currentSeq).toBe(11);

      parser.feed('partial line');
      expect(parser.buffer).toBe('partial line');

      parser.reset(50);
      expect(parser.buffer).toBe('');
      expect(parser.currentSeq).toBe(50);

      const events: NdjsonParsedEvent[] = [];
      parser.on('event', (evt) => events.push(evt));
      parser.feed('{"b": 2}\n');
      expect(events[0]?.seq).toBe(51);
    });
  });

  describe('Transform Stream integration', () => {
    it('can be piped from a readable stream and emits data events in objectMode', async () => {
      const parser = new NdjsonParser();
      const streamEvents: NdjsonStreamEvent[] = [];

      parser.on('data', (data: NdjsonStreamEvent) => {
        streamEvents.push(data);
      });

      const readable = Readable.from(['{"id": 1}\n', 'invalid\n', '{"id": 2}\n']);

      await new Promise<void>((resolve, reject) => {
        parser.on('finish', resolve);
        parser.on('error', reject);
        readable.pipe(parser);
      });

      expect(streamEvents.length).toBe(3);
      expect(streamEvents[0]?.seq).toBe(1);
      expect((streamEvents[0] as NdjsonParsedEvent).data).toEqual({ id: 1 });
      expect(streamEvents[1]?.type).toBe('parse_error');
      expect((streamEvents[2] as NdjsonParsedEvent).data).toEqual({ id: 2 });
    });
  });
});
