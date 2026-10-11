import type { QueryClient } from "@tanstack/react-query";
import { ApiError, isApiError } from "../api/api-error";
import {
  invalidateSessionRequests,
  isCurrentSessionExpiry,
} from "../api/http-client";
import { queryKeys } from "./query-keys";

const sessionEpochs = new WeakMap<QueryClient, number>();

export function sessionCacheEpoch(client: QueryClient): number {
  return sessionEpochs.get(client) ?? 0;
}

/** Drop observer data before removing entries: removal alone can leave a mounted
 * observer rendering its old result. Keep me as a terminal local boundary until
 * an explicit sign-in resets it; do not refetch a failed logout into a session. */
export function endClientSession(client: QueryClient): void {
  sessionEpochs.set(client, sessionCacheEpoch(client) + 1);
  invalidateSessionRequests();
  void client.cancelQueries();
  const cache = client.getQueryCache();
  for (const query of cache.getAll()) {
    query.setState({
      data: undefined,
      dataUpdatedAt: 0,
      error: null,
      status: "pending",
      fetchStatus: "idle",
    });
  }
  // Replace me too: alert-write guards use its Query identity as a session fence.
  client.removeQueries();
  cache.build(client, { queryKey: queryKeys.me }).setState({
    data: undefined,
    dataUpdatedAt: 0,
    error: new ApiError(401, "AUTH_UNAUTHORIZED", "Authentication required"),
    status: "error",
    fetchStatus: "idle",
  });
}

export function expireClientSession(client: QueryClient, error: unknown): void {
  if (!isCurrentSessionExpiry(error)) return;
  const me = client.getQueryState(queryKeys.me);
  // Another concurrent terminal response may already have cleared this client.
  if (
    me?.data === undefined &&
    isApiError(me?.error) &&
    me.error.statusCode === 401 &&
    client
      .getQueryCache()
      .getAll()
      .every((query) => query.queryKey[0] === queryKeys.me[0])
  )
    return;
  endClientSession(client);
}
