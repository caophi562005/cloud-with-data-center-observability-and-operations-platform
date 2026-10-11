// @vitest-environment jsdom
import { act } from "react";
import {
  MutationObserver,
  QueryObserver,
  onlineManager,
} from "@tanstack/react-query";
import { acknowledgeAlertMutationOptions } from "../src/features/alerts/hooks/use-alerts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLogin, useLogout } from "../src/features/auth/hooks/use-auth";
import { useTenant } from "../src/app/providers/app-providers";
import { apiFetch, resumeSessionRequests } from "../src/lib/api/http-client";
import { queryClient } from "../src/lib/query/query-client";
import { queryKeys } from "../src/lib/query/query-keys";
import { orgA, orgB, alertId } from "./support/alert-fixtures";
import { click, meFixture, mountAlertUi } from "./support/alert-ui-test-utils";

const privateKeys = [
  queryKeys.vms(orgA),
  queryKeys.vm(orgA, alertId),
  queryKeys.vmCurrentMetrics(orgA, alertId),
  queryKeys.vmMetricsRange(orgA, alertId, "7d"),
  queryKeys.members(orgA),
  queryKeys.organization(orgA),
  queryKeys.alert(orgA, alertId),
  queryKeys.alertEvents(orgA, alertId, 2, 50),
  queryKeys.alertRules(orgA),
  queryKeys.alertWriteCooldown("actor-id", orgA, alertId),
];
const privateValue = { secret: "prior-session-private-data" };
const unauthorized = () =>
  json({ code: "AUTH_UNAUTHORIZED", message: "Authentication required" }, 401);
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let operation: Promise<unknown> | undefined;
function Controls() {
  const login = useLogin();
  const logout = useLogout();
  const tenant = useTenant();
  return (
    <>
      <output data-tenant>{tenant.currentOrganization?.id ?? "none"}</output>
      <button onClick={() => tenant.selectOrganization(orgB)}>
        Select second
      </button>
      <button
        onClick={() => {
          operation = logout.mutateAsync();
          void operation.catch(() => undefined);
        }}
      >
        Logout
      </button>
      <button
        onClick={() => {
          operation = login.mutateAsync({
            email: "fixture@example.test",
            password: "fixture-password",
          });
          void operation.catch(() => undefined);
        }}
      >
        Login
      </button>
    </>
  );
}
let mounted: Awaited<ReturnType<typeof mountAlertUi>> | undefined;
async function setup() {
  mounted = await mountAlertUi(<Controls />);
  for (const key of privateKeys) queryClient.setQueryData(key, privateValue);
}
async function invoke(name: string) {
  await click(
    [...(mounted?.container.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === name,
    ) ?? null,
  );
  await act(async () => {
    await operation?.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
function expectCleared() {
  for (const key of privateKeys)
    expect(queryClient.getQueryData(key)).toBeUndefined();
}
beforeEach(() => {
  resumeSessionRequests();
  onlineManager.setOnline(true);
});
afterEach(async () => {
  resumeSessionRequests();
  onlineManager.setOnline(true);
  await mounted?.unmount();
  mounted = undefined;
  operation = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("client-owned authentication cache boundaries", () => {
  it.each([200, 503])(
    "clears all tenant caches and active observer data when logout returns HTTP%s",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => json({}, status)),
      );
      await setup();
      const observer = new QueryObserver(queryClient, {
        queryKey: privateKeys[0],
        queryFn: async () => privateValue,
        staleTime: Infinity,
      });
      const unsubscribe = observer.subscribe(() => undefined);
      try {
        await invoke("Logout");
        expectCleared();
        expect(observer.getCurrentResult().data).toBeUndefined();
        expect(queryClient.getQueryData(queryKeys.me)).toBeUndefined();
        expect(
          mounted?.container.querySelector("[data-tenant]")?.textContent,
        ).toBe("none");
      } finally {
        unsubscribe();
        observer.destroy();
      }
    },
  );
  it("prevents a still-mounted observer from refetching private data after failed logout", async () => {
    const fetch = vi.fn(async (path) =>
      String(path).endsWith("/auth/logout")
        ? json({}, 503)
        : json(privateValue),
    );
    vi.stubGlobal("fetch", fetch);
    await setup();
    const observer = new QueryObserver(queryClient, {
      queryKey: privateKeys[0],
      queryFn: () => apiFetch("/vms"),
      staleTime: Infinity,
      retry: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await invoke("Logout");
      await act(async () => {
        await observer.refetch();
      });
      expect(observer.getCurrentResult().data).toBeUndefined();
      expect(queryClient.getQueryData(privateKeys[0])).toBeUndefined();
      expect(
        fetch.mock.calls.some(([path]) => String(path).endsWith("/vms")),
      ).toBe(false);
    } finally {
      unsubscribe();
      observer.destroy();
    }
  });
  it.each(["Login", "Logout"])(
    "clears local data for offline %s initiation",
    async (action) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => json({}, 503)),
      );
      await setup();
      onlineManager.setOnline(false);
      await invoke(action);
      expectCleared();
      expect(queryClient.getQueryData(queryKeys.me)).toBeUndefined();
    },
  );
  it("does not reopen a terminal session from an accepted login callback superseded by logout", async () => {
    const waiting = deferred<void>();
    const reached = deferred<void>();
    const cache = queryClient.getMutationCache();
    const previous = cache.config.onSuccess;
    cache.config.onSuccess = async (_data, variables) => {
      if (variables) {
        reached.resolve();
        await waiting.promise;
      }
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path) =>
        String(path).endsWith("/auth/login")
          ? json({ user: meFixture().user }, 201)
          : json({}),
      ),
    );
    await setup();
    try {
      await click(
        [...mounted!.container.querySelectorAll("button")].find(
          (button) => button.textContent === "Login",
        )!,
      );
      const first = operation!;
      await reached.promise;
      await invoke("Logout");
      await act(async () => {
        waiting.resolve();
        await first;
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expectCleared();
      expect(queryClient.getQueryData(queryKeys.me)).toBeUndefined();
      await expect(apiFetch("/vms")).rejects.toMatchObject({ statusCode: 401 });
    } finally {
      waiting.resolve();
      cache.config.onSuccess = previous;
    }
  });
  it("clears previous data on failed login rather than retaining another actor cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => unauthorized()),
    );
    await setup();
    await invoke("Login");
    expectCleared();
    expect(queryClient.getQueryData(queryKeys.me)).toBeUndefined();
  });
  it("starts a fresh selection even when the same actor signs in again", async () => {
    const next = meFixture("VIEWER");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path) =>
        String(path).endsWith("/auth/login")
          ? json({ user: next.user }, 201)
          : json(next),
      ),
    );
    await setup();
    await click(
      [...(mounted?.container.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent === "Select second",
      ) ?? null,
    );
    expect(mounted?.container.querySelector("[data-tenant]")?.textContent).toBe(
      orgB,
    );
    await invoke("Login");
    expectCleared();
    expect(queryClient.getQueryData(queryKeys.me)).toEqual(next);
    expect(mounted?.container.querySelector("[data-tenant]")?.textContent).toBe(
      orgA,
    );
  });
  it("clears cached tenant data after confirmed refresh expiry, not merely the me entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => unauthorized()),
    );
    await setup();
    await act(async () => {
      await queryClient
        .fetchQuery({
          queryKey: queryKeys.me,
          queryFn: () => apiFetch("/me"),
          staleTime: 0,
          retry: false,
        })
        .catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expectCleared();
    expect(queryClient.getQueryData(queryKeys.me)).toBeUndefined();
    expect(mounted?.container.querySelector("[data-tenant]")?.textContent).toBe(
      "none",
    );
  });
  it.each([403, 429, 503])(
    "retains cache for an unconfirmed refresh failure HTTP%s",
    async (status) => {
      const fetch = vi.fn(async (path) =>
        String(path).endsWith("/auth/refresh")
          ? json(
              { code: "AUTH_REFRESH_UNAVAILABLE", message: "Try again" },
              status,
            )
          : unauthorized(),
      );
      vi.stubGlobal("fetch", fetch);
      await setup();
      await act(async () => {
        await queryClient
          .fetchQuery({
            queryKey: queryKeys.me,
            queryFn: () => apiFetch("/me"),
            staleTime: 0,
            retry: false,
          })
          .catch(() => undefined);
      });
      for (const key of privateKeys)
        expect(queryClient.getQueryData(key)).toEqual(privateValue);
    },
  );
  it("does not purge tenant cache during an ordinary successful cookie renewal", async () => {
    let requests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path) =>
        String(path).endsWith("/auth/refresh")
          ? json({})
          : ++requests === 1
            ? unauthorized()
            : json({ ok: true }),
      ),
    );
    await setup();
    await expect(apiFetch("/current-fixture")).resolves.toEqual({ ok: true });
    for (const key of privateKeys)
      expect(queryClient.getQueryData(key)).toEqual(privateValue);
  });
  it("rejects old alert mutation options after same-actor sign-in without expiring the new session", async () => {
    const next = meFixture();
    const fetch = vi.fn(async (path) =>
      String(path).endsWith("/auth/login")
        ? json({ user: next.user }, 201)
        : json(next),
    );
    vi.stubGlobal("fetch", fetch);
    await setup();
    const old = new MutationObserver(
      queryClient,
      acknowledgeAlertMutationOptions(queryClient, orgA, alertId),
    );
    await invoke("Login");
    await expect(old.mutate()).rejects.toMatchObject({ statusCode: 401 });
    expect(queryClient.getQueryData(queryKeys.me)).toEqual(next);
    expect(
      fetch.mock.calls.some(([path]) => String(path).includes("/acknowledge")),
    ).toBe(false);
  });
  it("discards a successful response that completes after logout", async () => {
    const old = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path) =>
        String(path).endsWith("/auth/logout") ? json({}) : old.promise,
      ),
    );
    await setup();
    const pending = apiFetch("/old-success");
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await invoke("Logout");
    old.resolve(json(privateValue));
    await assertion;
    expectCleared();
  });
  it("rejects a late old-session response without starting refresh or replay after logout", async () => {
    const old = deferred<Response>();
    let privateRequests = 0;
    const fetch = vi.fn(async (path) =>
      String(path).endsWith("/auth/logout")
        ? json({})
        : String(path).endsWith("/auth/refresh")
          ? json({})
          : ++privateRequests === 1
            ? old.promise
            : json(privateValue),
    );
    vi.stubGlobal("fetch", fetch);
    await setup();
    const pending = apiFetch("/old-fixture");
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await invoke("Logout");
    old.resolve(unauthorized());
    await assertion;
    expect(
      fetch.mock.calls.filter(([path]) =>
        String(path).endsWith("/auth/refresh"),
      ),
    ).toHaveLength(0);
    expect(privateRequests).toBe(1);
    expectCleared();
  });
  it("aborts a pending refresh at the identity boundary and rejects its eventual stale response", async () => {
    const renewal = deferred<Response>();
    const started = deferred<AbortSignal | null | undefined>();
    let privateRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path, init) => {
        if (String(path).endsWith("/auth/refresh")) {
          started.resolve(init?.signal);
          return renewal.promise;
        }
        if (String(path).endsWith("/auth/logout")) return json({});
        return ++privateRequests === 1 ? unauthorized() : json(privateValue);
      }),
    );
    await setup();
    const pending = apiFetch("/old-fixture");
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    const signal = await started.promise;
    await invoke("Logout");
    const aborted = signal?.aborted;
    renewal.resolve(json({}));
    await assertion;
    expect(aborted).toBe(true);
    expect(privateRequests).toBe(1);
    expectCleared();
  });
});
