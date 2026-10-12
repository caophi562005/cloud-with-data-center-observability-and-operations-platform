import { z } from 'zod';
const seconds = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^\d+(?:\.\d+)?$/)
      .transform(Number),
    z.iso.datetime({ offset: true }).transform((s) => Date.parse(s) / 1000),
  ])
  .pipe(z.number().finite().nonnegative().max(253402300799));
const step = z
  .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().positive().max(604800));
export const vmMetricsQuerySchema = z.union([
  z.object({ range: z.enum(['1h', '6h', '24h', '7d']) }).strict(),
  z
    .object({ from: seconds, to: seconds, step })
    .strict()
    .refine(
      (q) =>
        q.to > q.from &&
        q.to - q.from <= 604800 &&
        Math.floor((q.to - q.from) / q.step) + 1 <= 1000,
      { message: 'Invalid metrics window' },
    ),
]);
export type VmMetricsQuery = z.infer<typeof vmMetricsQuerySchema>;
export interface MetricsWindow {
  from: number;
  to: number;
  step: number;
}
const presets = {
  '1h': { span: 3600, step: 60 },
  '6h': { span: 21600, step: 60 },
  '24h': { span: 86400, step: 300 },
  '7d': { span: 604800, step: 1800 },
} as const;
export function resolveMetricsWindow(
  query: VmMetricsQuery,
  now: number,
): MetricsWindow {
  if (!('range' in query)) return query;
  const preset = presets[query.range];
  const to = Math.floor(now / preset.step) * preset.step;
  return { from: to - preset.span, to, step: preset.step };
}
