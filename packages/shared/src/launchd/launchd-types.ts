import { z } from 'zod';

export const LaunchdCalendarIntervalSchema = z.object({
  Month: z.number().int().min(1).max(12).optional(),
  Day: z.number().int().min(1).max(31).optional(),
  Weekday: z.number().int().min(0).max(7).optional(), // 0 or 7 is Sunday
  Hour: z.number().int().min(0).max(23).optional(),
  Minute: z.number().int().min(0).max(59).optional(),
});

export type LaunchdCalendarInterval = z.infer<typeof LaunchdCalendarIntervalSchema>;

export const LaunchdKeepAliveSchema = z.union([
  z.boolean(),
  z.object({
    SuccessfulExit: z.boolean().optional(),
    Crashed: z.boolean().optional(),
    NetworkState: z.boolean().optional(),
    AfterInitialDemand: z.boolean().optional(),
  }),
]);

export type LaunchdKeepAlive = z.infer<typeof LaunchdKeepAliveSchema>;

export const LaunchdProcessTypeSchema = z.enum([
  'Background',
  'Standard',
  'Adaptive',
  'Interactive',
]);

export type LaunchdProcessType = z.infer<typeof LaunchdProcessTypeSchema>;

export const LaunchdServiceConfigSchema = z.object({
  label: z.string().min(1),
  programArguments: z.array(z.string().min(1)).min(1),
  workingDirectory: z.string().optional(),
  environmentVariables: z.record(z.string(), z.string()).optional(),
  standardOutPath: z.string().optional(),
  standardErrorPath: z.string().optional(),
  keepAlive: LaunchdKeepAliveSchema.optional(),
  runAtLoad: z.boolean().optional(),
  processType: LaunchdProcessTypeSchema.optional(),
  nice: z.number().int().min(-20).max(20).optional(),
  startInterval: z.number().int().positive().optional(),
  startCalendarInterval: z.union([
    LaunchdCalendarIntervalSchema,
    z.array(LaunchdCalendarIntervalSchema),
  ]).optional(),
  throttleInterval: z.number().int().nonnegative().optional(),
  exitTimeout: z.number().int().positive().optional(),
  softResourceLimits: z.object({
    NumberOfFiles: z.number().int().positive().optional(),
  }).optional(),
});

export type LaunchdServiceConfig = z.infer<typeof LaunchdServiceConfigSchema>;
