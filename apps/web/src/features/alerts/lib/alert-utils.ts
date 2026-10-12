import type { Member, Role } from "../../../types/domain";
import type { AlertListQuery, AlertListState } from "../alert.types";
export function alertCountBadge(total: number): string | null {
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  return total > 99 ? "99+" : String(total);
}
export function canManageAlerts(role: Role | undefined): boolean { return role === "ADMIN" || role === "OPERATOR"; }
export function validateAlertComment(value: string): { message: string } | { error: string } {
  const message = value.trim();
  if (!message || message.includes("\u0000") || /[\uD800-\uDFFF]/u.test(message)) return { error: "Enter a valid comment." };
  if ([...message].length > 4000 || new TextEncoder().encode(message).byteLength > 16384) return { error: "Comments must fit 4,000 characters and 16 KiB." };
  return { message };
}
export function alertActorLabel(actorId: string | null, members: readonly Member[]): string {
  if (actorId === null) return "System";
  const member = members.find((item) => item.userId === actorId);
  return member?.displayName?.trim() || member?.email || actorId;
}
export function toAlertListQuery(state: AlertListState): AlertListQuery {
  const q = state.q.trim();
  return { page: state.page, pageSize: state.pageSize, signalStatus: state.tab === "history" ? "RESOLVED" : "FIRING", sort: state.sort,
    ...(state.severity ? { severity: state.severity } : {}), ...(state.workflowStatus ? { workflowStatus: state.workflowStatus } : {}),
    ...(state.vmId ? { vmId: state.vmId } : {}), ...(q ? { q } : {}) };
}
