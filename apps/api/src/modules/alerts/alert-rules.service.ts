import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  MetricsQueryClient,
  metricsUnavailable,
} from '../../infrastructure/metrics/metrics-query.client.js';
const names = new Set([
  'VMHighCPU',
  'VMHighMemory',
  'VMDiskUsageHigh',
  'VMDisconnected',
]);
const labelsSchema = z.record(z.string().max(256), z.string().max(4096));
const ruleSchema = z.object({
  name: z.string(),
  type: z.literal('alerting'),
  query: z.string().min(1).max(65_536),
  duration: z.number().finite().nonnegative().max(31_536_000),
  labels: labelsSchema.refine((value) =>
    ['warning', 'critical'].includes(value.severity),
  ),
  annotations: labelsSchema,
  health: z.string().min(1).max(32),
  lastEvaluation: z.iso.datetime({ offset: true }).nullable().optional(),
  alerts: z
    .array(
      z.object({ labels: labelsSchema, state: z.enum(['pending', 'firing']) }),
    )
    .max(1000),
});
const groupSchema = z.object({
  name: z.literal('opsgrid-vm-health'),
  file: z.literal('opsgrid-dev-vm-alerts'),
  interval: z.number().finite().positive().max(86400),
  rules: z.array(z.unknown()).max(1000),
});
export interface AlertRule {
  name: string;
  severity: 'WARNING' | 'CRITICAL';
  promql: string;
  forSeconds: number;
  intervalSeconds: number;
  namespace: string;
  group: string;
  health: string;
  state: 'inactive' | 'pending' | 'firing' | 'unknown';
  activeAlerts: number;
  lastEvaluation: string | null;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}
export interface AlertRulesResponse {
  scope: 'SHARED_VM_RULES';
  managedBy: 'Terraform / AWS AMP';
  fetchedAt: string;
  items: AlertRule[];
}
@Injectable()
export class AlertRulesService {
  constructor(private readonly metrics: MetricsQueryClient) {}
  async list(organizationId: string): Promise<AlertRulesResponse> {
    const items: AlertRule[] = [];
    const seen = new Set<string>();
    for (const raw of await this.metrics.listRuleGroups()) {
      const header = z
        .object({ name: z.string(), file: z.string() })
        .safeParse(raw);
      if (!header.success) throw metricsUnavailable();
      if (
        header.data.name !== 'opsgrid-vm-health' ||
        header.data.file !== 'opsgrid-dev-vm-alerts'
      )
        continue;
      const group = groupSchema.safeParse(raw);
      if (!group.success) throw metricsUnavailable();
      for (const candidate of group.data.rules) {
        const identity = z.object({ name: z.string() }).safeParse(candidate);
        if (!identity.success) throw metricsUnavailable();
        if (!names.has(identity.data.name)) continue;
        const parsed = ruleSchema.safeParse(candidate);
        if (!parsed.success || seen.has(identity.data.name))
          throw metricsUnavailable();
        const rule = parsed.data;
        seen.add(rule.name);
        const own = rule.alerts.filter(
          (alert) => alert.labels.organization_id === organizationId,
        );
        const state =
          rule.health !== 'ok'
            ? 'unknown'
            : own.some((alert) => alert.state === 'firing')
              ? 'firing'
              : own.length
                ? 'pending'
                : 'inactive';
        items.push({
          name: rule.name,
          severity:
            rule.labels.severity === 'critical' ? 'CRITICAL' : 'WARNING',
          promql: rule.query,
          forSeconds: rule.duration,
          intervalSeconds: group.data.interval,
          namespace: group.data.file,
          group: group.data.name,
          health: rule.health,
          state,
          activeAlerts: own.length,
          lastEvaluation: rule.lastEvaluation ?? null,
          labels: { severity: rule.labels.severity },
          annotations: {
            ...(rule.annotations.summary !== undefined
              ? { summary: rule.annotations.summary }
              : {}),
            ...(rule.annotations.description !== undefined
              ? { description: rule.annotations.description }
              : {}),
          },
        });
      }
    }
    items.sort(
      (a, b) =>
        Number(b.severity === 'CRITICAL') - Number(a.severity === 'CRITICAL') ||
        a.name.localeCompare(b.name),
    );
    return {
      scope: 'SHARED_VM_RULES',
      managedBy: 'Terraform / AWS AMP',
      fetchedAt: new Date().toISOString(),
      items,
    };
  }
}
