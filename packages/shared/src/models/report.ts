import { z } from 'zod';

export const ReportSchema = z.object({
  id: z.string().min(1, 'Report id cannot be empty'),
  run_id: z.string().nullable().default(null),
  kind: z.string().min(1, 'Report kind cannot be empty'),
  content: z.string().default(''),
  created_at: z.string(),
});

export type Report = z.infer<typeof ReportSchema>;

export const CreateReportInputSchema = z.object({
  id: z.string().min(1).optional(),
  run_id: z.string().nullable().optional(),
  kind: z.string().min(1, 'Report kind is required'),
  content: z.string().optional().default(''),
  created_at: z.string().optional(),
});

export type CreateReportInput = z.input<typeof CreateReportInputSchema>;
export type CreateReportData = z.output<typeof CreateReportInputSchema>;

export const ReportFilterSchema = z.object({
  run_id: z.string().optional(),
  kind: z.string().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
});

export type ReportFilter = z.infer<typeof ReportFilterSchema>;
