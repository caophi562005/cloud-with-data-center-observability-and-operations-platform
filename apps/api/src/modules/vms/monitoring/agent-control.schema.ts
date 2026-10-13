import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { AgentApplyReport, NativeHeartbeatInput } from './monitoring.types.js';

const MAX_CONTROL_BODY_BYTES = 16 * 1024;
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const boundedString = (bytes: number) => z.string().max(bytes).refine((value) =>
  Buffer.byteLength(value, 'utf8') <= bytes && !/[\x00-\x1f\x7f]/.test(value),
);

export const agentApplyReportSchema = z.object({
  version: z.number().int().min(1).max(2_147_483_647),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  result: z.enum(['applied', 'rejected']),
  errorCode: boundedString(128).optional(),
  // Accepted only as bounded input, never persisted, echoed or logged.
  errorMessage: z.string().max(1024).refine((value) => Buffer.byteLength(value, 'utf8') <= 1024).optional(),
}).strict();

export const nativeHeartbeatSchema = z.object({
  id: z.uuid().transform((value) => value.toLowerCase()),
  version: boundedString(128).refine((value) => value.trim().length > 0),
  schema: z.literal(1),
  // Pinned native output uses Unix seconds, not milliseconds/nanoseconds.
  last: safeInteger.optional(),
  statistics: z.object({ errors: safeInteger, warnings: safeInteger, metrics: safeInteger }).strict().optional(),
  status: z.enum(['OK', 'WARN', 'FAIL', 'UNDEFINED']).optional(),
}).strict();

function parseControlBody<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    const json = JSON.stringify(input);
    if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_CONTROL_BODY_BYTES) throw new Error();
    return schema.parse(input);
  } catch {
    // No raw client strings or attacker-controlled schema issue paths in errors.
    throw new BadRequestException('Invalid agent control payload');
  }
}

export function validateAgentApplyReport(input: unknown): AgentApplyReport {
  return parseControlBody(agentApplyReportSchema, input);
}

export function validateNativeHeartbeat(input: unknown): NativeHeartbeatInput {
  return parseControlBody(nativeHeartbeatSchema, input);
}
