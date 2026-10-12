import type { JSX } from "react";
import { Navigate, Outlet } from "react-router-dom";
import { isApiError } from "../../lib/api/api-error";
import { useMe } from "../../features/auth/hooks/use-auth";

function isAuthenticationFailure(error: unknown): boolean {
  return isApiError(error) && error.statusCode === 401;
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

function SessionError({
  error,
  isRetrying,
  onRetry,
}: {
  error: unknown;
  isRetrying: boolean;
  onRetry: () => void;
}): JSX.Element {
  const message = isApiError(error)
    ? error.message
    : "We could not verify your session. Please try again.";

  return (
    <main className="grid min-h-screen place-items-center bg-retro-bg p-6 text-retro-text">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <p role="alert" className="text-retro-red">
          {message}
        </p>
        <button
          type="button"
          onClick={onRetry}
          disabled={isRetrying}
          aria-busy={isRetrying}
          className="min-h-11 cursor-pointer border-2 border-retro-border-strong bg-retro-surface px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-retro-primary disabled:cursor-wait disabled:opacity-60"
        >
          {isRetrying ? "Checking your session..." : "Try again"}
        </button>
      </div>
    </main>
  );
}

export function ProtectedRoute(): JSX.Element {
  const meQuery = useMe();
  const retrySession = () => {
    void meQuery.refetch({ throwOnError: false });
  };

  if (meQuery.isPending) {
    return <SessionLoading />;
  }

  if (meQuery.isError) {
    if (isAuthenticationFailure(meQuery.error)) {
      return <Navigate to="/login" replace />;
    }

    return (
      <SessionError
        error={meQuery.error}
        isRetrying={meQuery.isFetching}
        onRetry={retrySession}
      />
    );
  }

  return <Outlet />;
}
