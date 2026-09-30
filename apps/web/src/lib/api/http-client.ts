import { ApiError } from "./api-error";

const API_PREFIX = "/api/v1";
const AUTH_PREFIX = `${API_PREFIX}/auth/`;
const REFRESH_PATH = `${API_PREFIX}/auth/refresh`;

let refreshPromise: Promise<boolean> | null = null;

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

async function refreshSession(): Promise<boolean> {
  try {
    const response = await fetch(REFRESH_PATH, {
      method: "POST",
      credentials: "include",
    });

    return response.ok;
  } catch {
    return false;
  }
}

function refreshOnce(): Promise<boolean> {
  refreshPromise ??= refreshSession().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

async function fetchWithCredentials(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(path, withCredentials(init));
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const apiPath = toApiPath(path);
  let response: Response;

  try {
    response = await fetchWithCredentials(apiPath, init);
  } catch {
    throw ApiError.generic();
  }

  if (response.status === 401 && !isAuthRequest(apiPath)) {
    await refreshOnce();

    try {
      response = await fetchWithCredentials(apiPath, init);
    } catch {
      throw ApiError.generic();
    }
  }

  if (!response.ok) {
    const payload = await readResponseBody(response);
    throw ApiError.fromResponse(response, payload);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await readResponseBody(response)) as T;
}
