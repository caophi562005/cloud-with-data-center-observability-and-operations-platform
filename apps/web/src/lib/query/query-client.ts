import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { expireClientSession } from "./session-cache";
import { isApiError } from "../api/api-error";

const QUERY_STALE_TIME = 30_000;
const QUERY_GC_TIME = 5 * 60_000;
const MAX_QUERY_RETRIES = 2;

function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.statusCode >= 400 && error.statusCode < 500) {
    return false;
  }

  return failureCount < MAX_QUERY_RETRIES;
}

function retryDelay(attemptIndex: number): number {
  return Math.min(1_000 * 2 ** attemptIndex, 30_000);
}

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => expireClientSession(client, error),
    }),
    mutationCache: new MutationCache({
      onError: (error) => expireClientSession(client, error),
    }),
    defaultOptions: {
      queries: {
        staleTime: QUERY_STALE_TIME,
        gcTime: QUERY_GC_TIME,
        retry: shouldRetryQuery,
        retryDelay,
      },
      mutations: {
        retry: false,
      },
    },
  });
  return client;
}

export const queryClient = createQueryClient();
