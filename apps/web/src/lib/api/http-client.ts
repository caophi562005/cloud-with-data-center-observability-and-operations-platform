import { resolveApiOrigin } from "../../../config/api-origin";
import { ApiError } from "./api-error";

const API_ORIGIN = resolveApiOrigin(
  import.meta.env.VITE_API_URL,
  import.meta.env.PROD,
);
const API_PREFIX = "/api/v1";
const AUTH_PREFIX = `${API_PREFIX}/auth/`;
const REFRESH_PATH = `${API_PREFIX}/auth/refresh`;

const REFRESH_TIMEOUT_MS = 15_000;

let refreshPromise: Promise<void> | null = null;
let refreshController: AbortController | null = null;
let sessionVersion = 0;
let identityVersion = 0;
let protectedRequestsAllowed = true;

export function resumeSessionRequests(): void {
  protectedRequestsAllowed = true;
}
const confirmedExpiries = new WeakMap<ApiError, number>();

export function isCurrentSessionExpiry(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    confirmedExpiries.get(error) === identityVersion
  );
}

function responseError(
  response: Response,
  payload: unknown,
  version: number,
): ApiError {
  const error = ApiError.fromResponse(response, payload);
  if (response.status === 401) confirmedExpiries.set(error, version);
  return error;
}

export function invalidateSessionRequests(): void {
  protectedRequestsAllowed = false;
  identityVersion += 1;
  refreshController?.abort();
  refreshController = null;
  refreshPromise = null;
}

function assertCurrentIdentity(
  version: number,
  signal?: AbortSignal | null,
): void {
  if (version !== identityVersion || signal?.aborted) {
    throw new DOMException("Session request cancelled", "AbortError");
  }
}

function toApiPath(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  if (
    normalizedPath === API_PREFIX ||
    normalizedPath.startsWith(`${API_PREFIX}/`)
  ) {
    return normalizedPath;
  }

  return `${API_PREFIX}${normalizedPath}`;
}

function toRequestUrl(apiPath: string): string {
  return `${API_ORIGIN}${apiPath}`;
}

function isAuthRequest(path: string): boolean {
  const pathWithoutQuery = path.split(/[?#]/, 1)[0];
  return (
    pathWithoutQuery === `${API_PREFIX}/auth` ||
    pathWithoutQuery.startsWith(AUTH_PREFIX)
  );
}

function withCredentials(init?: RequestInit): RequestInit {
  return {
    ...init,
    credentials: "include",
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (!text) return undefined;

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  } catch {
    try {
      return (await response.json()) as unknown;
    } catch {
      return undefined;
    }
  }
}

async function refreshSession(): Promise<void> {
  const version = identityVersion;
  const controller = new AbortController();
  refreshController = controller;
  try {
    let response: Response;
    try {
      response = await fetch(toRequestUrl(REFRESH_PATH), {
        method: "POST",
        credentials: "include",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        ]),
      });
    } catch {
      assertCurrentIdentity(version);
      throw ApiError.generic();
    }
    assertCurrentIdentity(version);
    if (!response.ok) {
      const payload = await readResponseBody(response);
      assertCurrentIdentity(version);
      throw responseError(response, payload, version);
    }
    sessionVersion += 1;
  } finally {
    if (refreshController === controller) refreshController = null;
  }
}

function refreshOnce(): Promise<void> {
  if (!refreshPromise) {
    const pending = refreshSession().finally(() => {
      if (refreshPromise === pending) refreshPromise = null;
    });
    refreshPromise = pending;
  }
  return refreshPromise;
}

async function fetchWithCredentials(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(toRequestUrl(path), withCredentials(init));
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const apiPath = toApiPath(path);
  const authPath = apiPath.split(/[?#]/, 1)[0];
  const explicitAuthAction =
    isAuthRequest(apiPath) &&
    authPath !== `${API_PREFIX}/auth/me` &&
    authPath !== REFRESH_PATH;
  if (!protectedRequestsAllowed && !explicitAuthAction) {
    throw new ApiError(401, "AUTH_UNAUTHORIZED", "Authentication required");
  }
  const requestSessionVersion = sessionVersion;
  const requestIdentityVersion = identityVersion;
  assertCurrentIdentity(requestIdentityVersion, init?.signal);
  let response: Response;

  try {
    response = await fetchWithCredentials(apiPath, init);
  } catch {
    assertCurrentIdentity(requestIdentityVersion, init?.signal);
    throw ApiError.generic();
  }
  assertCurrentIdentity(requestIdentityVersion, init?.signal);

  if (response.status === 401 && !isAuthRequest(apiPath)) {
    // A late 401 may belong to a request sent before another request renewed
    // the cookie. Reuse that renewal instead of starting a second refresh.
    if (requestSessionVersion === sessionVersion) {
      await refreshOnce();
    }
    assertCurrentIdentity(requestIdentityVersion, init?.signal);
    try {
      response = await fetchWithCredentials(apiPath, init);
    } catch {
      assertCurrentIdentity(requestIdentityVersion, init?.signal);
      throw ApiError.generic();
    }
    assertCurrentIdentity(requestIdentityVersion, init?.signal);
  }

  if (!response.ok) {
    const payload = await readResponseBody(response);
    assertCurrentIdentity(requestIdentityVersion, init?.signal);
    throw responseError(response, payload, requestIdentityVersion);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = await readResponseBody(response);
  assertCurrentIdentity(requestIdentityVersion, init?.signal);
  return payload as T;
}
