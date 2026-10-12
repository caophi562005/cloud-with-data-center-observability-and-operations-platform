import {
  AlertInputError,
  type CanonicalAlertEvent,
  type AlertTransition,
} from './alert.types.js';

export function occurrenceKeyFromIdentity(identity: {
  source: string;
  organizationId: string;
  vmId: string;
  fingerprint: string;
  startsAtKey: string;
}): string {
  return JSON.stringify([
    identity.source,
    identity.organizationId,
    identity.vmId,
    identity.fingerprint,
    identity.startsAtKey,
  ]);
}
export function occurrenceKey(event: CanonicalAlertEvent): string {
  return occurrenceKeyFromIdentity({ ...event, startsAtKey: event.startsAt });
}
export function transitionOccurrence(
  current: CanonicalAlertEvent | null,
  incoming: CanonicalAlertEvent,
): AlertTransition {
  if (!current) return { kind: 'INSERT', event: incoming };
  if (
    occurrenceKey(current) !== occurrenceKey(incoming) ||
    current.alertName !== incoming.alertName ||
    current.severity !== incoming.severity ||
    Object.entries(current.labels).some(
      ([key, value]) =>
        incoming.labels[key as keyof typeof incoming.labels] !== value,
    )
  )
    throw new AlertInputError();
  const annotations = { ...current.annotations };
  let changed = false;
  for (const key of ['summary', 'description'] as const) {
    if (!annotations[key] && incoming.annotations[key]) {
      annotations[key] = incoming.annotations[key];
      changed = true;
    }
  }
  const resolved =
    current.status === 'FIRING' && incoming.status === 'RESOLVED';
  return {
    kind: resolved || changed ? 'UPDATE' : 'NOOP',
    event: {
      ...current,
      annotations,
      status: resolved ? 'RESOLVED' : current.status,
      endsAt: resolved ? incoming.endsAt : current.endsAt,
    },
  };
}
