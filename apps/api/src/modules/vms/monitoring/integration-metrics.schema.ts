import { z } from 'zod';
import { monitoringInstanceIdSchema } from './integration-catalog.js';

export const integrationMetricsParamsSchema = z.object({
  organizationId: monitoringInstanceIdSchema, vmId: monitoringInstanceIdSchema, instanceId: monitoringInstanceIdSchema,
}).strict();
export const integrationMetricsCurrentSchema = z.object({}).strict();
export const integrationMetricsRangeSchema = z.object({
  range: z.enum(['15m', '1h', '6h', '24h']),
  metric: z.string().min(1).max(96).regex(/^[a-z][a-z0-9_]*$/),
  entity: z.string().min(1).max(160).regex(/^(?:db:[A-Za-z0-9_.-]{1,128}|database:db[0-9]{1,10}|container:[0-9a-f]{12}:[A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/).optional(),
}).strict();
export type IntegrationMetricsParams = z.infer<typeof integrationMetricsParamsSchema>;
export type IntegrationMetricsRangeInput = z.infer<typeof integrationMetricsRangeSchema>;
