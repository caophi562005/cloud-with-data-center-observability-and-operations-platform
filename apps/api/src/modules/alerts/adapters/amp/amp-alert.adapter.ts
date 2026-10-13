import { z } from 'zod';
import { normalizeAlertTime, compareAlertTimes } from '../../alert-time.js';
import { occurrenceKey } from '../../alert-lifecycle.js';
import {
  alertNames,
  AlertInputError,
  type CanonicalAlertEvent,
} from '../../alert.types.js';

const encoded = z.string().max(256 * 1024);
const groupSchema = z
  .object({ organization_id: encoded, vm_id: encoded, alertname: encoded })
  .strict();
const labelSchema = groupSchema.extend({ severity: encoded });
const payloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    stringEncoding: z.literal('urlquery'),
    receiver: encoded,
    status: encoded,
    groupLabels: groupSchema,
    alerts: z
      .array(
        z
          .object({
            status: encoded,
            labels: labelSchema,
            fingerprint: encoded,
            startsAt: encoded,
            endsAt: encoded,
            annotations: z
              .object({
                summary: encoded.optional(),
                description: encoded.optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
const uuid = z.uuid();
function decode(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, ' '));
}

export function adaptAmpAlertMessage(
  message: string,
): readonly CanonicalAlertEvent[] {
  try {
    if (Buffer.byteLength(message, 'utf8') > 256 * 1024)
      throw new AlertInputError();
    const payload = payloadSchema.parse(JSON.parse(message));
    if (!['firing', 'resolved'].includes(decode(payload.status)))
      throw new AlertInputError();
    const group = Object.fromEntries(
      Object.entries(payload.groupLabels).map(([key, value]) => [
        key,
        decode(value),
      ]),
    );
    const events = new Map<string, CanonicalAlertEvent>();
    for (const alert of payload.alerts) {
      const labels = {
        organization_id: decode(alert.labels.organization_id),
        vm_id: decode(alert.labels.vm_id),
        alertname: decode(alert.labels.alertname),
        severity: decode(alert.labels.severity),
      };
      if (
        Object.entries(group).some(
          ([key, value]) => labels[key as keyof typeof labels] !== value,
        )
      )
        throw new AlertInputError();
      const organizationId = uuid.parse(labels.organization_id).toLowerCase(),
        vmId = uuid.parse(labels.vm_id).toLowerCase();
      const alertName = z.enum(alertNames).parse(labels.alertname);
      const severity =
        z.enum(['warning', 'critical']).parse(labels.severity) === 'warning'
          ? 'WARNING'
          : 'CRITICAL';
      const status =
        z.enum(['firing', 'resolved']).parse(decode(alert.status)) === 'firing'
          ? 'FIRING'
          : 'RESOLVED';
      const fingerprint = decode(alert.fingerprint);
      if (
        fingerprint.length < 1 ||
        fingerprint.length > 128 ||
        // eslint-disable-next-line no-control-regex -- Intentionally reject ASCII controls in the external fingerprint.
        /[\u0000-\u001f\u007f]/.test(fingerprint)
      )
        throw new AlertInputError();
      const startsAt = normalizeAlertTime(decode(alert.startsAt));
      const endsAt =
        status === 'RESOLVED' ? normalizeAlertTime(decode(alert.endsAt)) : null;
      if (endsAt && compareAlertTimes(endsAt, startsAt) < 0)
        throw new AlertInputError();
      const annotations: Partial<Record<'summary' | 'description', string>> =
        {};
      for (const key of ['summary', 'description'] as const) {
        const value = alert.annotations?.[key];
        if (value !== undefined) {
          annotations[key] = decode(value);
          if (Buffer.byteLength(annotations[key], 'utf8') > 4096)
            throw new AlertInputError();
        }
      }
      const event: CanonicalAlertEvent = {
        source: 'metrics-primary',
        fingerprint,
        organizationId,
        vmId,
        alertName,
        severity,
        status,
        startsAt,
        endsAt,
        labels,
        annotations,
      };
      const key = occurrenceKey(event),
        previous = events.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(event))
        throw new AlertInputError();
      events.set(key, event);
    }
    return [...events.values()];
  } catch {
    throw new AlertInputError();
  }
}
