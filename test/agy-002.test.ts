import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import {
  NdjsonParser,
  type NdjsonParsedEvent,
  type NdjsonParseErrorEvent,
  ProcessAdapter,
} from '../apps/orchestrator/src/adapters/index.js';
import {
  NdjsonParsedEventSchema,
  NdjsonParseErrorEventSchema,
  NdjsonStreamEventSchema,
} from '../packages/shared/src/index.js';

describe('AGY-002 Acceptance Tests: NdjsonParser', () => {
  describe('Tiêu chí 1: Chunk cắt giữa dòng (Chunk split in the middle of a line)', () => {
    it('ghép đúng các chunk bị cắt giữa đối tượng JSON qua nhiều lần feed', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      parser.on('event', (evt) => events.push(evt));

      // Chunk 1: nửa đầu JSON
      parser.feed('{"worker": "agy", "step": "');
      expect(events.length).toBe(0);
      expect(parser.buffer).toBe('{"worker": "agy", "step": "');

      // Chunk 2: nửa giữa JSON
      parser.feed('compile", "details": {"files": [');
      expect(events.length).toBe(0);

      // Chunk 3: nửa cuối JSON kèm newline
      parser.feed('"a.ts", "b.ts"]}}\n');
      expect(events.length).toBe(1);

      expect(events[0]?.data).toEqual({
        worker: 'agy',
        step: 'compile',
        details: { files: ['a.ts', 'b.ts'] },
      });
      expect(events[0]?.seq).toBe(1);
      expect(parser.buffer).toBe('');
    });

    it('hoạt động chuẩn xác khi dữ liệu bị cắt nhỏ từng byte / ký tự một', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      parser.on('event', (evt) => events.push(evt));

      const payload = { test: 'byte-by-byte', count: 42 };
      const rawLine = JSON.stringify(payload) + '\n';

      // Feed từng ký tự một
      for (let i = 0; i < rawLine.length; i++) {
        parser.feed(rawLine[i]!);
      }

      expect(events.length).toBe(1);
      expect(events[0]?.data).toEqual(payload);
      expect(events[0]?.seq).toBe(1);
    });

    it('không làm hỏng ký tự UTF-8 đa byte khi byte boundary bị cắt ngang', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      parser.on('event', (evt) => events.push(evt));

      const payload = {
        tiêu_đề: 'Kiểm thử tiếng Việt có dấu đầy đủ: ă, â, đ, ê, ô, ơ, ư',
        biểu_tượng: '🚀✨🔥🎯',
      };
      const jsonLine = JSON.stringify(payload) + '\n';
      const buf = Buffer.from(jsonLine, 'utf8');

      // Chia nhỏ thành 7 bytes mỗi chunk
      const chunkSize = 7;
      for (let i = 0; i < buf.length; i += chunkSize) {
        parser.feed(buf.subarray(i, i + chunkSize));
      }

      expect(events.length).toBe(1);
      expect(events[0]?.data).toEqual(payload);
      expect(events[0]?.raw).toBe(JSON.stringify(payload));
    });

    it('xử lý và parse được dòng cuối cùng khi kết thúc stream dù không có ký tự newline ở cuối', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      parser.on('event', (evt) => events.push(evt));

      parser.feed('{"completed": true, "exitCode": 0}');
      expect(events.length).toBe(0);

      // Kích hoạt flush khi stream kết thúc
      parser.flush();

      expect(events.length).toBe(1);
      expect(events[0]?.data).toEqual({ completed: true, exitCode: 0 });
      expect(parser.buffer).toBe('');
    });
  });

  describe('Tiêu chí 2: Dòng lỗi (JSON lỗi → event parse_error không crash)', () => {
    it('phát sinh sự kiện parse_error với đầy đủ thông tin khi gặp dòng JSON sai cú pháp', () => {
      const parser = new NdjsonParser();
      const errors: NdjsonParseErrorEvent[] = [];
      parser.on('parse_error', (err) => errors.push(err));

      const invalidRaw = '{ key_without_quotes: 123, }';
      parser.feed(`${invalidRaw}\n`);

      expect(errors.length).toBe(1);
      const err = errors[0]!;
      expect(err.type).toBe('parse_error');
      expect(err.raw).toBe(invalidRaw);
      expect(err.seq).toBe(1);
      expect(typeof err.errorMessage).toBe('string');
      expect(err.errorMessage.length).toBeGreaterThan(0);
      expect(err.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Xác thực khớp Zod schema
      expect(NdjsonParseErrorEventSchema.safeParse(err).success).toBe(true);
    });

    it('tuyệt đối không crash khi dòng lỗi xảy ra dù không đăng ký listener parse_error', () => {
      const parser = new NdjsonParser();

      // Không gắn listener on('parse_error')
      expect(() => {
        parser.feed('Syntax Error: Unexpected token < in JSON\n');
        parser.feed('<!DOCTYPE html><html><body>Error 500</body></html>\n');
        parser.feed('{ "unclosed": "brace"\n');
      }).not.toThrow();

      expect(parser.currentSeq).toBe(3);
    });

    it('tự phục hồi ngay lập tức, tiếp tục parse các dòng hợp lệ phía sau mà không bị ngắt dòng dữ liệu', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      const errors: NdjsonParseErrorEvent[] = [];

      parser.on('event', (evt) => events.push(evt));
      parser.on('parse_error', (err) => errors.push(err));

      parser.feed('{"event": "start", "type": "lifecycle"}\n');
      parser.feed('Raw console log message that is not JSON\n');
      parser.feed('{"event": "progress", "type": "step", "pct": 50}\n');
      parser.feed('[unbalanced array\n');
      parser.feed('{"event": "end", "type": "result", "status": "SUCCESS"}\n');

      expect(events.length).toBe(3);
      expect(errors.length).toBe(2);

      expect(events[0]?.type).toBe('lifecycle');
      expect(errors[0]?.raw).toBe('Raw console log message that is not JSON');
      expect(events[1]?.type).toBe('step');
      expect(errors[1]?.raw).toBe('[unbalanced array');
      expect(events[2]?.type).toBe('result');

      // seq tăng dần liên tục và duy nhất
      expect(events[0]?.seq).toBe(1);
      expect(errors[0]?.seq).toBe(2);
      expect(events[1]?.seq).toBe(3);
      expect(errors[1]?.seq).toBe(4);
      expect(events[2]?.seq).toBe(5);
    });

    it('bảo vệ chống tràn bộ nhớ (memory exhaustion): phát parse_error khi dòng vượt giới hạn maxLineLength', () => {
      const maxLen = 120;
      const parser = new NdjsonParser({ maxLineLength: maxLen });
      const errors: NdjsonParseErrorEvent[] = [];
      parser.on('parse_error', (err) => errors.push(err));

      const oversizedLine = 'A'.repeat(200);
      parser.feed(`${oversizedLine}\n`);

      expect(errors.length).toBe(1);
      expect(errors[0]?.type).toBe('parse_error');
      expect(errors[0]?.errorMessage).toContain(
        `Line length (${oversizedLine.length}) exceeds maximum limit (${maxLen})`,
      );
      expect(parser.buffer).toBe('');
    });
  });

  describe('Tiêu chí 3: Dòng rỗng (Empty lines)', () => {
    it('bỏ qua các dòng rỗng hoàn toàn mà không phát sinh event hay lỗi', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      const errors: NdjsonParseErrorEvent[] = [];

      parser.on('event', (evt) => events.push(evt));
      parser.on('parse_error', (err) => errors.push(err));

      parser.feed('\n\n\n\n\n');
      expect(events.length).toBe(0);
      expect(errors.length).toBe(0);
      expect(parser.currentSeq).toBe(0);
    });

    it('bỏ qua dòng chứa khoảng trắng (spaces, tabs) khi ignoreWhitespaceOnly được bật', () => {
      const parser = new NdjsonParser({ ignoreWhitespaceOnly: true });
      const events: NdjsonParsedEvent[] = [];
      const errors: NdjsonParseErrorEvent[] = [];

      parser.on('event', (evt) => events.push(evt));
      parser.on('parse_error', (err) => errors.push(err));

      parser.feed('     \n\t\t\t\n  \t  \t  \n');
      expect(events.length).toBe(0);
      expect(errors.length).toBe(0);
      expect(parser.currentSeq).toBe(0);
    });

    it('xử lý an toàn ký tự kết thúc dòng Windows CRLF (\\r\\n) và bỏ qua dòng CRLF rỗng', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      parser.on('event', (evt) => events.push(evt));

      parser.feed('\r\n\r\n{"platform": "win32"}\r\n\r\n{"platform": "posix"}\r\n\r\n');

      expect(events.length).toBe(2);
      expect(events[0]?.data).toEqual({ platform: 'win32' });
      expect(events[1]?.data).toEqual({ platform: 'posix' });
    });

    it('phân tách chính xác các dòng hợp lệ xen kẽ nhiều dòng rỗng liên tiếp', () => {
      const parser = new NdjsonParser();
      const events: NdjsonParsedEvent[] = [];
      parser.on('event', (evt) => events.push(evt));

      const input = ['', '{"id": "A"}', '', '', '{"id": "B"}', '   ', '{"id": "C"}', ''].join('\n');

      parser.feed(input);

      expect(events.length).toBe(3);
      expect(events.map((e) => (e.data as { id: string }).id)).toEqual(['A', 'B', 'C']);
      expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    });
  });

  describe('Tiêu chí 4: Chuẩn hóa Schema và Static Methods', () => {
    it('mọi event và error event đều vượt qua validation NdjsonStreamEventSchema', () => {
      const input = `
{"type": "init", "version": 1}
malformed line
{"type": "done", "success": true}
`;
      const { events, errors } = NdjsonParser.parse(input);

      expect(events.length).toBe(2);
      expect(errors.length).toBe(1);

      for (const evt of events) {
        const parseRes = NdjsonParsedEventSchema.safeParse(evt);
        expect(parseRes.success).toBe(true);
        expect(NdjsonStreamEventSchema.safeParse(evt).success).toBe(true);
      }

      for (const err of errors) {
        const parseRes = NdjsonParseErrorEventSchema.safeParse(err);
        expect(parseRes.success).toBe(true);
        expect(NdjsonStreamEventSchema.safeParse(err).success).toBe(true);
      }
    });

    it('NdjsonParser.parseStream xử lý trọn vẹn luồng dữ liệu async Readable stream', async () => {
      const readable = Readable.from([
        '{"item":',
        ' 1}\n\n{"item": 2',
        '}\nerroneous line\n{"item": 3}\n',
      ]);

      const result = await NdjsonParser.parseStream(readable);

      expect(result.events.length).toBe(3);
      expect(result.errors.length).toBe(1);
      expect(result.events[0]?.data).toEqual({ item: 1 });
      expect(result.events[1]?.data).toEqual({ item: 2 });
      expect(result.events[2]?.data).toEqual({ item: 3 });
      expect(result.errors[0]?.raw).toBe('erroneous line');
    });
  });

  describe('Tiêu chí 5: Tích hợp với ProcessAdapter (tiến trình thật phát stream)', () => {
    it('đọc và phân tích trực tiếp stream stdout phát từ child process thật (node -e)', async () => {
      const adapter = new ProcessAdapter();
      const parser = new NdjsonParser();

      const events: NdjsonParsedEvent[] = [];
      const errors: NdjsonParseErrorEvent[] = [];

      parser.on('event', (evt) => events.push(evt));
      parser.on('parse_error', (err) => errors.push(err));

      // Script node -e phát NDJSON giả lập: chunk cắt ngang, dòng rỗng, dòng lỗi, và dòng thành công
      const nodeScript = [
        'process.stdout.write("{\\"type\\": \\"step\\", \\"name\\": \\"init\\"}\\n");',
        'process.stdout.write("\\n\\n");', // Dòng rỗng
        'process.stdout.write("{\\"type\\": \\"step\\", \\"name\\": \\"pro");', // Chunk cắt ngang nửa 1
        'process.stdout.write("cessing\\"}\\n");', // Chunk cắt ngang nửa 2
        'process.stdout.write("NON_JSON_LOG_OUTPUT\\n");', // Dòng lỗi
        'process.stdout.write("{\\"type\\": \\"result\\", \\"status\\": \\"SUCCESS\\"}\\n");', // Kết quả
      ].join('');

      const handle = adapter.spawn({
        exe: 'node',
        args: ['-e', nodeScript],
        cwd: process.cwd(),
      });

      handle.stdout.pipe(parser);

      const exitResult = await handle.waitForExit();
      expect(exitResult.exitCode).toBe(0);

      // Chờ stream flush
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(events.length).toBe(3);
      expect(errors.length).toBe(1);

      expect(events[0]?.type).toBe('step');
      expect((events[0]?.data as { name: string }).name).toBe('init');

      expect(events[1]?.type).toBe('step');
      expect((events[1]?.data as { name: string }).name).toBe('processing');

      expect(errors[0]?.type).toBe('parse_error');
      expect(errors[0]?.raw).toBe('NON_JSON_LOG_OUTPUT');

      expect(events[2]?.type).toBe('result');
      expect((events[2]?.data as { status: string }).status).toBe('SUCCESS');

      // Xác thực chuỗi seq tăng dần chính xác
      expect(events[0]?.seq).toBe(1);
      expect(events[1]?.seq).toBe(2);
      expect(errors[0]?.seq).toBe(3);
      expect(events[2]?.seq).toBe(4);
    });
  });
});
