import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { PxlKitSurfaceProvider, PxlKitToastProvider } from "@pxlkit/ui-kit";
import { ProtectedRoute } from "../src/app/router/protected-route";
import { LoginForm } from "../src/features/auth/components/login-form";
import { RegisterForm } from "../src/features/auth/components/register-form";
import { ApiError } from "../src/lib/api/api-error";
import { queryKeys } from "../src/lib/query/query-keys";
import { createQueryClient } from "../src/lib/query/query-client";

function render(client: QueryClient): string {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        MemoryRouter,
        null,
        createElement(
          Routes,
          null,
          createElement(
            Route,
            { element: createElement(ProtectedRoute) },
            createElement(Route, {
              path: "/",
              element: createElement("p", null, "Private dashboard"),
            }),
          ),
          createElement(Route, {
            path: "/login",
            element: createElement("p", null, "Login form"),
          }),
        ),
      ),
    ),
  );
}

async function failedSession(error: ApiError): Promise<QueryClient> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  await client
    .fetchQuery({
      queryKey: queryKeys.me,
      queryFn: () => Promise.reject(error),
    })
    .catch(() => undefined);
  return client;
}

describe("supported authentication", () => {
  it.each([
    ["login", LoginForm, "current-password"],
    ["registration", RegisterForm, "new-password"],
  ] as const)(
    "%s offers password authentication, not unsupported Google success",
    (_name, Form, autocomplete) => {
      const client = new QueryClient();
      try {
        const markup = renderToStaticMarkup(
          <QueryClientProvider client={client}>
            <PxlKitSurfaceProvider surface="pixel">
              <PxlKitToastProvider>
                <MemoryRouter>
                  <Form />
                </MemoryRouter>
              </PxlKitToastProvider>
            </PxlKitSurfaceProvider>
          </QueryClientProvider>,
        );
        expect(markup).toContain('type="email"');
        expect(markup).toContain(`autoComplete="${autocomplete}"`);
        expect(markup).toContain('type="submit"');
        expect(markup).not.toMatch(/<button[^>]*>[\s\S]*?Continue with Google/);
      } finally {
        client.clear();
      }
    },
  );
});

describe("protected session recovery", () => {
  it.each([0, 403, 429, 503])(
    "keeps an HTTP %s session check on a recoverable alert rather than login",
    async (status) => {
      const client = await failedSession(
        new ApiError(
          status,
          "AUTH_REFRESH_UNAVAILABLE",
          "We could not renew your session. Please try again.",
        ),
      );
      try {
        const markup = render(client);
        expect(markup).toContain('role="alert"');
        expect(markup).toContain("We could not renew your session.");
        expect(markup).toContain(">Try again</button>");
        expect(markup).not.toContain("Private dashboard");
        expect(markup).not.toContain("Login form");
      } finally {
        client.clear();
      }
    },
  );

  it("does not treat an authentication-looking code on a 503 as confirmed session expiry", async () => {
    const client = await failedSession(
      new ApiError(503, "AUTH_UNAUTHORIZED", "Session check unavailable."),
    );
    try {
      expect(render(client)).toContain("Session check unavailable.");
    } finally {
      client.clear();
    }
  });

  it("does not expose the protected outlet for a confirmed 401", async () => {
    const client = await failedSession(
      new ApiError(401, "AUTH_UNAUTHORIZED", "Authentication required"),
    );
    try {
      const markup = render(client);
      expect(markup).not.toContain("Private dashboard");
      expect(markup).not.toContain('role="alert"');
    } finally {
      client.clear();
    }
  });

  it("renders the protected outlet after a verified session", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.me, {
      user: { id: "user-1", email: "user@example.com", displayName: "User" },
      organizations: [],
    });
    try {
      expect(render(client)).toContain("Private dashboard");
    } finally {
      client.clear();
    }
  });

  it("automatically retries a transient check but never retries a confirmed 401", async () => {
    const client = createQueryClient();
    client.setDefaultOptions({
      queries: { ...client.getDefaultOptions().queries, retryDelay: 0 },
    });
    try {
      let attempts = 0;
      await expect(
        client.fetchQuery({
          queryKey: queryKeys.me,
          queryFn: () => {
            attempts += 1;
            if (attempts < 3)
              throw new ApiError(503, "AUTH_REFRESH_UNAVAILABLE", "Try again.");
            return { user: { id: "user-1" } };
          },
        }),
      ).resolves.toEqual({ user: { id: "user-1" } });
      expect(attempts).toBe(3);
      let expiredAttempts = 0;
      await expect(
        client.fetchQuery({
          queryKey: ["expired-session"],
          queryFn: () => {
            expiredAttempts += 1;
            throw new ApiError(
              401,
              "AUTH_UNAUTHORIZED",
              "Authentication required",
            );
          },
        }),
      ).rejects.toMatchObject({ statusCode: 401 });
      expect(expiredAttempts).toBe(1);
    } finally {
      client.clear();
    }
  });
});
