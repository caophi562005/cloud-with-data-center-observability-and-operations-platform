import type { JSX } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { isApiError } from "../../lib/api/api-error";
import { useMe } from "../../features/auth/hooks/use-auth";

function isAuthenticationFailure(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.statusCode === 401 || error.code === "AUTH_UNAUTHORIZED")
  );
}

function SessionLoading(): JSX.Element {
  return (
    <main className="grid min-h-screen place-items-center bg-retro-bg p-6 text-retro-text">
      <p role="status" aria-live="polite">
        Checking your session...
      </p>
    </main>
  );
}

function SessionError({ error }: { error: unknown }): JSX.Element {
  const message = isApiError(error)
    ? error.message
    : "We could not verify your session. Please try again.";

  return (
    <main className="grid min-h-screen place-items-center bg-retro-bg p-6 text-retro-text">
      <p role="alert" className="max-w-md text-center text-retro-red">
        {message}
      </p>
    </main>
  );
}

export function ProtectedRoute(): JSX.Element {
  const meQuery = useMe();

  if (meQuery.isPending) {
    return <SessionLoading />;
  }

  if (meQuery.isError) {
    if (isAuthenticationFailure(meQuery.error)) {
      return <Navigate to="/login" replace />;
    }

    return <SessionError error={meQuery.error} />;
  }

  if (!meQuery.data) {
    return <SessionError error={undefined} />;
  }

  return <Outlet />;
}
