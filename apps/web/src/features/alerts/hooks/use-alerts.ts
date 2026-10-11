import { queryOptions, useQuery, useMutation, useQueryClient, type QueryClient, type UseMutationOptions } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { ApiError } from "../../../lib/api/api-error";
import { queryKeys } from "../../../lib/query/query-keys";
import { getAlerts, getAlert, getAlertEvents, acknowledgeAlert, addAlertComment, getAlertRules } from "../api/alerts.api";
import type { AlertDetail, AlertEvent, AlertListQuery, AlertPage, AlertSummary, AlertRulesResponse } from "../alert.types";
export function isAlertId(value: string | null | undefined): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? "");
}
function visible(): boolean { return typeof document === "undefined" || document.visibilityState !== "hidden"; }
function subscribeVisibility(callback: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", callback); return () => document.removeEventListener("visibilitychange", callback);
}
export function useAlertPageVisible(): boolean { return useSyncExternalStore(subscribeVisibility, visible, () => true); }
export function alertCooldownRemaining(error: unknown): number {
  return error instanceof ApiError && error.statusCode === 429 ? Math.max(0, error.receivedAt + (error.retryAfterMs ?? 30_000) - Date.now()) : 0;
}
export function useAlertCooldown(error: unknown): boolean {
  const subscribe = useCallback((notify: () => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => { const remaining = alertCooldownRemaining(error); if (remaining > 0) timer = setTimeout(check, Math.min(remaining, 2_147_483_647)); else notify(); };
    if (alertCooldownRemaining(error) > 0) check();
    return () => { if (timer !== undefined) clearTimeout(timer); };
  }, [error]);
  const snapshot = useCallback(() => alertCooldownRemaining(error) > 0, [error]);
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
function terminalRead(error: unknown): error is ApiError { return error instanceof ApiError && [401,403,404].includes(error.statusCode); }
// Query fetch-start clears its error field. Keep only the rate-limit error in a
// weak per-query latch so enabling/refetching cannot bypass the original deadline.
const rateLimitedReads = new WeakMap<object, ApiError>();
async function readAlertData<T>(client: QueryClient, key: readonly unknown[], read: () => Promise<T>): Promise<T> {
  const cached = client.getQueryCache().find({ queryKey: key, exact: true });
  const error = cached ? rateLimitedReads.get(cached) ?? cached.state.error : undefined;
  if (alertCooldownRemaining(error) > 0) throw error;
  try { const result = await read(); if (cached) rateLimitedReads.delete(cached); return result; } catch (failure) {
    if (failure instanceof ApiError && failure.statusCode === 429 && cached) rateLimitedReads.set(cached, failure);
    if (terminalRead(failure)) {
      const related = key[2] === 'detail' || key[2] === 'events' ? client.getQueryCache().findAll({ predicate: candidate => candidate.queryKey[0] === key[0] && candidate.queryKey[1] === key[1] && candidate.queryKey[3] === key[3] && (candidate.queryKey[2] === 'events' || key[2] === 'detail' && candidate.queryKey[2] === 'detail') }) : cached ? [cached] : [];
      await client.cancelQueries({ predicate: candidate => candidate !== cached && related.includes(candidate) });
      for (const affected of related) affected.setState({ data: undefined, dataUpdatedAt: 0, error: failure, status: 'error', fetchStatus: 'idle' });
    }
    throw failure;
  }
}
export function alertRetry(failureCount: number, error: ApiError): boolean {
  return failureCount < 2 && ![401, 403, 404, 429].includes(error.statusCode) && (error.statusCode === 0 || error.statusCode >= 500);
}
export function alertPollInterval(query: { state: { error: unknown; errorUpdatedAt: number } }): number | false {
  if (!visible()) return false;
  const error = query.state.error;
  if (error instanceof ApiError && [401, 403, 404].includes(error.statusCode)) return false;
  if (error instanceof ApiError && error.statusCode === 429) return Math.max(30_000, alertCooldownRemaining(error));
  return 30_000;
}
const policy = { retry: alertRetry, retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 5000), refetchInterval: alertPollInterval,
  refetchOnWindowFocus: false as const, refetchOnReconnect: false as const, refetchOnMount: false as const, retryOnMount: false as const, staleTime: 30_000 };
export function alertRulesQueryOptions(organizationId: string | null, active = true) {
  return queryOptions<AlertRulesResponse, ApiError>({ ...policy, queryKey: queryKeys.alertRules(organizationId ?? ''), queryFn: ({signal,client,queryKey}) => readAlertData(client,queryKey,() => getAlertRules(organizationId ?? '', signal)), enabled: cached => isAlertId(organizationId) && active && visible() && !terminalRead(cached.state.error) });
}
export function useAlertRules(organizationId: string | null) {
  const visibility = useAlertPageVisible(); return useQuery(alertRulesQueryOptions(organizationId, visibility));
}
export function alertsQueryOptions(organizationId: string | null, query: AlertListQuery, active = true) {
  return queryOptions<AlertPage<AlertSummary>, ApiError>({ ...policy, queryKey: queryKeys.alertList(organizationId ?? "", query),
    queryFn: ({ signal, client, queryKey }) => readAlertData(client, queryKey, () => getAlerts(organizationId ?? "", query, signal)), enabled: (cached) => isAlertId(organizationId) && active && visible() && !terminalRead(cached.state.error) });
}
export function alertQueryOptions(organizationId: string | null, alertId: string | null, active = true) {
  return queryOptions<AlertDetail, ApiError>({ ...policy, queryKey: queryKeys.alert(organizationId ?? "", alertId ?? ""),
    queryFn: ({ signal, client, queryKey }) => readAlertData(client, queryKey, () => getAlert(organizationId ?? "", alertId ?? "", signal)), enabled: (cached) => isAlertId(organizationId) && isAlertId(alertId) && active && visible() && !terminalRead(cached.state.error) });
}
export function alertEventsQueryOptions(organizationId: string | null, alertId: string | null, page: number, pageSize = 50, active = true) {
  return queryOptions<AlertPage<AlertEvent>, ApiError>({ ...policy, queryKey: queryKeys.alertEvents(organizationId ?? "", alertId ?? "", page, pageSize),
    queryFn: ({ signal, client, queryKey }) => readAlertData(client, queryKey, () => getAlertEvents(organizationId ?? "", alertId ?? "", page, pageSize, signal)), enabled: (cached) => isAlertId(organizationId) && isAlertId(alertId) && active && visible() && !terminalRead(cached.state.error) });
}
export function useAlerts(organizationId: string | null, query: AlertListQuery, active = true) {
  const visibility = useAlertPageVisible(); return useQuery(alertsQueryOptions(organizationId, query, active && visibility));
}
export function useAlert(organizationId: string | null, alertId: string | null) {
  const visibility = useAlertPageVisible(); return useQuery(alertQueryOptions(organizationId, alertId, visibility));
}
export function useAlertEvents(organizationId: string | null, alertId: string | null, page: number) {
  const visibility = useAlertPageVisible(); return useQuery(alertEventsQueryOptions(organizationId, alertId, page, 50, visibility));
}
function actorId(client: QueryClient): string | undefined { return client.getQueryData<{ user: { id: string } }>(queryKeys.me)?.user.id; }
// Deadline-only metadata lives in the existing session QueryClient, never in
// mutation variables. It survives drawer remount, but clears with the session.
function writeCooldownOptions(client: QueryClient, actor: string | undefined, org: string | null, alertId: string | null) {
  const queryKey = queryKeys.alertWriteCooldown(actor ?? '', org ?? '', alertId ?? '');
  return { queryKey, queryFn: async (): Promise<ApiError | null> => null, enabled: false, staleTime: Infinity, gcTime: Math.max(300_000, alertCooldownRemaining(client.getQueryData(queryKey)) + 1_000) };
}
export function useAlertWriteCooldown(org: string | null, alertId: string | null) {
  const client = useQueryClient(); return useQuery(writeCooldownOptions(client, actorId(client), org, alertId)).data;
}
function currentWriteSession(client: QueryClient, actor: string | undefined, session: object | undefined): boolean { return Boolean(actor) && actorId(client) === actor && client.getQueryCache().find({queryKey:queryKeys.me,exact:true}) === session; }
async function writeAlertData<T>(client: QueryClient, actor: string | undefined, session: object | undefined, org: string, alertId: string, write: () => Promise<T>): Promise<T> {
  if (!currentWriteSession(client, actor, session)) throw new ApiError(401, 'UNAUTHENTICATED', 'Refresh your session first.');
  const options = writeCooldownOptions(client, actor, org, alertId);
  const error = client.getQueryData<ApiError>(options.queryKey);
  if (alertCooldownRemaining(error) > 0) throw error;
  try { return await write(); } catch (failure) {
    if (failure instanceof ApiError && failure.statusCode === 429 && currentWriteSession(client, actor, session)) {
      const retained = { ...options, gcTime: Math.max(300_000, alertCooldownRemaining(failure) + 1_000) };
      const cache = client.getQueryCache(); const existing = cache.find({queryKey:options.queryKey,exact:true});
      // setOptions alone does not re-arm an existing GC timer. Recreate only
      // unobserved deadline metadata; active observers re-arm on unsubscribe.
      if (existing && existing.getObserversCount() === 0) cache.remove(existing);
      cache.build(client, retained).setOptions(retained);
      client.setQueryData(options.queryKey, failure);
    }
    throw failure;
  }
}
function assertMutationTarget(org: string | null, alertId: string | null): asserts org is string {
  if (!isAlertId(org) || !isAlertId(alertId)) throw new ApiError(400, "CLIENT_ERROR", "Select an alert first.");
}
export function acknowledgeAlertMutationOptions(client: QueryClient, org: string | null, alertId: string | null): UseMutationOptions<AlertDetail, ApiError, void> {
  const actor = actorId(client); const session = client.getQueryCache().find({queryKey:queryKeys.me,exact:true});
  return { retry: false, mutationFn: async () => { assertMutationTarget(org, alertId); const result = await writeAlertData(client, actor, session, org, alertId!, () => acknowledgeAlert(org, alertId!));
    if (result.organizationId !== org || result.id !== alertId) throw new ApiError(500, "CLIENT_ERROR", "Unexpected alert response."); return result; },
    onSuccess: async (result) => { if (!org || !currentWriteSession(client, actor, session)) return;
      await client.cancelQueries({ queryKey: queryKeys.alerts(org) });
      if (!currentWriteSession(client, actor, session)) return;
      client.setQueryData(queryKeys.alert(org, result.id), result);
      await client.invalidateQueries({ queryKey: queryKeys.alerts(org) }); }
  };
}
export function commentAlertMutationOptions(client: QueryClient, org: string | null, alertId: string | null): UseMutationOptions<AlertEvent, ApiError, { message: string }> {
  const actor = actorId(client); const session = client.getQueryCache().find({queryKey:queryKeys.me,exact:true});
  return { retry: false, mutationFn: async ({ message }) => { assertMutationTarget(org, alertId); return writeAlertData(client, actor, session, org, alertId!, () => addAlertComment(org, alertId!, message)); },
    onSuccess: async () => { if (!org || !currentWriteSession(client, actor, session)) return;
      await client.invalidateQueries({ queryKey: queryKeys.alerts(org) }); }
  };
}
export function useAcknowledgeAlert(org: string | null, alertId: string | null) { const client = useQueryClient(); return useMutation(acknowledgeAlertMutationOptions(client, org, alertId)); }
export function useAddAlertComment(org: string | null, alertId: string | null) { const client = useQueryClient(); return useMutation(commentAlertMutationOptions(client, org, alertId)); }
