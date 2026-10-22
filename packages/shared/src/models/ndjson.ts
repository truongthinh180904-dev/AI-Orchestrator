import { z } from 'zod';

export const NdjsonParsedEventSchema = z.object({
  seq: z.number().int().positive(),
  type: z.string().min(1),
  data: z.unknown(),
  raw: z.string(),
  timestamp: z.string().datetime(),
});

export type NdjsonParsedEvent<T = unknown> = {
  seq: number;
  type: string;
  data: T;
  raw: string;
  timestamp: string;
};

export const NdjsonParseErrorEventSchema = z.object({
  seq: z.number().int().positive(),
  type: z.literal('parse_error'),
  raw: z.string(),
  errorMessage: z.string(),
  timestamp: z.string().datetime(),
});

export type NdjsonParseErrorEvent = {
  seq: number;
  type: 'parse_error';
  raw: string;
  error?: Error;
  errorMessage: string;
  timestamp: string;
};

export const NdjsonStreamEventSchema = z.union([
  NdjsonParsedEventSchema,
  NdjsonParseErrorEventSchema,
]);

export type NdjsonStreamEvent = NdjsonParsedEvent | NdjsonParseErrorEvent;

export const DEFAULT_MAX_LINE_LENGTH = 1024 * 1024; // 1 MB

export const NdjsonParserOptionsSchema = z.object({
  maxLineLength: z.number().int().positive().default(DEFAULT_MAX_LINE_LENGTH),
  ignoreWhitespaceOnly: z.boolean().default(true),
  pushErrors: z.boolean().default(true),
  initialSeq: z.number().int().nonnegative().default(0),
});

export type NdjsonParserOptions = z.input<typeof NdjsonParserOptionsSchema>;
export type NdjsonParserConfig = z.output<typeof NdjsonParserOptionsSchema>;
