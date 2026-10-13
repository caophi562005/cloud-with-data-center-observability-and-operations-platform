import {
  AlertSeverity,
  AlertStatus,
  AlertWorkflowStatus,
} from '@prisma/client';
import { z } from 'zod';

const uuid = z.string().uuid();
export const alertOrganizationParamsSchema = z
  .object({ organizationId: uuid })
  .strict();
export const alertParamsSchema = alertOrganizationParamsSchema
  .extend({ id: uuid })
  .strict();
const positiveInteger = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^[1-9]\d*$/u)
      .transform(Number),
  ])
  .pipe(z.number().int().min(1).max(2_147_483_647));
const pagination = {
  page: positiveInteger.default(1),
  pageSize: positiveInteger.pipe(z.number().max(100)).default(50),
};
const safeOffset = (query: { page: number; pageSize: number }): boolean =>
  (query.page - 1) * query.pageSize <= 2_147_483_647;
export const alertListQuerySchema = z
  .object({
    ...pagination,
    signalStatus: z.enum(AlertStatus).optional(),
    workflowStatus: z.enum(AlertWorkflowStatus).optional(),
    severity: z.enum(AlertSeverity).optional(),
    vmId: uuid.optional(),
    q: z.string().trim().min(1).max(120).optional(),
    sort: z
      .enum(['severity_desc', 'started_at_desc', 'started_at_asc'])
      .optional(),
  })
  .strict()
  .refine(safeOffset, { message: 'Invalid page offset', path: ['page'] });
export const alertEventsQuerySchema = z
  .object(pagination)
  .strict()
  .refine(safeOffset, { message: 'Invalid page offset', path: ['page'] });
export const alertAcknowledgeSchema = z.object({}).strict().optional();
export const alertCommentSchema = z
  .object({
    message: z
      .string()
      .trim()
      .min(1)
      .refine(
        (value) => !value.includes('\u0000') && !/[\uD800-\uDFFF]/u.test(value),
        'Invalid Unicode text',
      )
      .refine(
        (value) =>
          Array.from(value).length <= 4000 &&
          Buffer.byteLength(value, 'utf8') <= 16 * 1024,
        'Comment too long',
      ),
  })
  .strict();

export type AlertListQuery = z.infer<typeof alertListQuerySchema>;
export type AlertEventsQuery = z.infer<typeof alertEventsQuerySchema>;
export type AlertCommentInput = z.infer<typeof alertCommentSchema>;
