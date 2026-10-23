import { z } from 'zod';

export const CaffeinateFlagSchema = z.enum([
  'display', // -d: prevent display sleep
  'idle',    // -i: prevent idle sleep
  'disk',    // -m: prevent disk sleep
  'system',  // -s: prevent system sleep on AC power
  'user',    // -u: declare user is active
]);

export type CaffeinateFlag = z.infer<typeof CaffeinateFlagSchema>;

export const FLAG_CLI_MAP: Record<CaffeinateFlag, string> = {
  display: '-d',
  idle: '-i',
  disk: '-m',
  system: '-s',
  user: '-u',
};

export const PowerAssertionConfigSchema = z.object({
  flags: z.array(CaffeinateFlagSchema).default(['display', 'idle', 'disk', 'system']),
  timeoutSeconds: z.number().int().positive().optional(),
  waitPid: z.number().int().positive().optional(),
  reason: z.string().default('AI Orchestrator Execution Assertion'),
  caffeinatePath: z.string().default('/usr/bin/caffeinate'),
});

export type PowerAssertionConfig = z.infer<typeof PowerAssertionConfigSchema>;

export const PowerAssertionStateSchema = z.object({
  active: z.boolean(),
  pid: z.number().nullable(),
  flags: z.array(CaffeinateFlagSchema),
  reason: z.string().nullable(),
  startedAt: z.string().nullable(),
  platform: z.string(),
  available: z.boolean(),
  command: z.string().nullable(),
});

export type PowerAssertionState = z.infer<typeof PowerAssertionStateSchema>;
