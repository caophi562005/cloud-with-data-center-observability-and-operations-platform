import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function unauthorized(): Response {
  return json(
    { code: "AUTH_UNAUTHORIZED", message: "Authentication required" },
    401,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_API_URL", "");
  vi.stubEnv("PROD", false);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("credentialed session recovery", () => {
  it("renews then replays an expired-access request exactly once with credentials", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(json({ user: { id: "user-1" } }))
      .mockResolvedValueOnce(json({ items: ["vm-1"] }));
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/lib/api/http-client");
    const init = {
      method: "POST",
      body: JSON.stringify({ hostname: "host-1" }),
      headers: { "Content-Type": "application/json" },
    };

    await expect(apiFetch("/vms", init)).resolves.toEqual({ items: ["vm-1"] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/vms", {
      ...init,
      credentials: "include",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/auth/refresh",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/v1/vms", {
      ...init,
      credentials: "include",
    });
  });

  it.each([401, 403, 429, 503])(
    "propagates refresh HTTP %s without replaying the denied request",
    async (status) => {
      const code =
        status === 401 ? "AUTH_UNAUTHORIZED" : "AUTH_REFRESH_UNAVAILABLE";
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(unauthorized())
        .mockResolvedValueOnce(
          json(
            {
              code,
              message: "We could not renew your session. Please try again.",
              requestId: "refresh-request-1",
            },
            status,
          ),
        )
        .mockResolvedValue(unauthorized());
      vi.stubGlobal("fetch", fetchMock);
      const { apiFetch } = await import("../src/lib/api/http-client");

      await expect(apiFetch("/me")).rejects.toMatchObject({
        statusCode: status,
        code,
        requestId: "refresh-request-1",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("reports a refresh network failure as unavailable instead of a session-ending 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unauthorized())
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValue(unauthorized());
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/lib/api/http-client");

    await expect(apiFetch("/me")).rejects.toMatchObject({ statusCode: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds the shared refresh request with an abort signal", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ user: { id: "user-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/lib/api/http-client");

    await apiFetch("/me");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      signal: expect.any(AbortSignal),
    });
  });

  it("shares one in-flight refresh across concurrent 401 responses", async () => {
    const refresh = deferred<Response>();
    let renewed = false;
    const fetchMock = vi.fn((path: string) => {
      if (path.endsWith("/auth/refresh")) return refresh.promise;
      return Promise.resolve(renewed ? json({ path }) : unauthorized());
    });
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/lib/api/http-client");
    const first = apiFetch("/me");
    const second = apiFetch("/organizations");
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([path]) => path.endsWith("/auth/refresh")),
      ).toHaveLength(1),
    );
    renewed = true;
    refresh.resolve(json({}));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { path: "/api/v1/me" },
      { path: "/api/v1/organizations" },
    ]);
    expect(
      fetchMock.mock.calls.filter(([path]) => path.endsWith("/auth/refresh")),
    ).toHaveLength(1);
  });

  it("replays a delayed stale 401 using the completed refresh instead of refreshing again", async () => {
    const delayed = deferred<Response>();
    let meCalls = 0;
    const fetchMock = vi.fn((path: string) => {
      if (path.endsWith("/auth/refresh")) return Promise.resolve(json({}));
      if (path.endsWith("/me"))
        return Promise.resolve(
          ++meCalls === 1 ? unauthorized() : json({ user: { id: "user-1" } }),
        );
      if (
        fetchMock.mock.calls.filter(([called]) => called.endsWith("/vms"))
          .length === 1
      )
        return delayed.promise;
      return Promise.resolve(json({ items: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/lib/api/http-client");
    const vms = apiFetch("/vms");
    await apiFetch("/me");
    delayed.resolve(unauthorized());

    await expect(vms).resolves.toEqual({ items: [] });
    expect(
      fetchMock.mock.calls.filter(([path]) => path.endsWith("/auth/refresh")),
    ).toHaveLength(1);
  });

  it("allows recovery after a failed refresh rather than retaining a rejected promise", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(
        json({ code: "AUTH_REFRESH_UNAVAILABLE", message: "Try again." }, 503),
      )
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ user: { id: "user-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/lib/api/http-client");

    await expect(apiFetch("/me")).rejects.toMatchObject({ statusCode: 503 });
    await expect(apiFetch("/me")).resolves.toEqual({ user: { id: "user-1" } });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("does not loop if the replay is still unauthorized", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(unauthorized());
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/lib/api/http-client");

    await expect(apiFetch("/me")).rejects.toMatchObject({ statusCode: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(["/auth/login", "/auth/refresh", "/auth/logout?from=menu"])(
    "never refreshes recursively for %s",
    async (path) => {
      const fetchMock = vi.fn().mockResolvedValue(unauthorized());
      vi.stubGlobal("fetch", fetchMock);
      const { apiFetch } = await import("../src/lib/api/http-client");

      await expect(apiFetch(path)).rejects.toMatchObject({ statusCode: 401 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );
});

describe("configured public API origin", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_API_URL", "https://api.opsgrid.hacmieu.com/");
    vi.stubEnv("PROD", true);
  });

  it("uses the public origin for the original request, refresh and replay", async () => {
    const controller = new AbortController();
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "host-1" }),
      signal: controller.signal,
      credentials: "omit" as const,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ items: ["vm-1"] }));
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/lib/api/http-client");

    await expect(apiFetch("/vms?limit=2", init)).resolves.toEqual({
      items: ["vm-1"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.opsgrid.hacmieu.com/api/v1/vms?limit=2",
      { ...init, credentials: "include" },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.opsgrid.hacmieu.com/api/v1/auth/refresh",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.opsgrid.hacmieu.com/api/v1/vms?limit=2",
      { ...init, credentials: "include" },
    );
  });

  it("does not double-prefix an existing API path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/lib/api/http-client");

    await expect(apiFetch("/api/v1/organizations?limit=1")).resolves.toEqual({
      items: [],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.opsgrid.hacmieu.com/api/v1/organizations?limit=1",
      { credentials: "include" },
    );
  });

  it.each(["/auth/login", "/auth/refresh", "/auth/logout?from=menu"])(
    "keeps auth-path refresh exclusion after URL composition (%s)",
    async (path) => {
      const fetchMock = vi.fn().mockResolvedValue(unauthorized());
      vi.stubGlobal("fetch", fetchMock);
      const { apiFetch } = await import("../src/lib/api/http-client");

      await expect(apiFetch(path)).rejects.toMatchObject({ statusCode: 401 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        `https://api.opsgrid.hacmieu.com/api/v1${path}`,
        { credentials: "include" },
      );
    },
  );

  it("shares one absolute refresh for concurrent protected requests", async () => {
    const refresh = deferred<Response>();
    let renewed = false;
    const fetchMock = vi.fn((path: string) => {
      if (path.endsWith("/auth/refresh")) return refresh.promise;
      return Promise.resolve(renewed ? json({ path }) : unauthorized());
    });
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("../src/lib/api/http-client");
    const first = apiFetch("/me");
    const second = apiFetch("/organizations");
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([path]) =>
          path.endsWith("/auth/refresh"),
        ),
      ).toHaveLength(1),
    );
    renewed = true;
    refresh.resolve(json({}));

    await expect(Promise.all([first, second])).resolves.toEqual([
      { path: "https://api.opsgrid.hacmieu.com/api/v1/me" },
      { path: "https://api.opsgrid.hacmieu.com/api/v1/organizations" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.opsgrid.hacmieu.com/api/v1/auth/refresh",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("fails missing production origin before any fetch", async () => {
    vi.stubEnv("VITE_API_URL", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(import("../src/lib/api/http-client")).rejects.toThrow(
      /^VITE_API_URL must be an HTTPS origin$/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
