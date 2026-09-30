import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { PxlKitSurfaceProvider, useDarkMode } from "@pxlkit/ui-kit";
import { ApiError } from "../../lib/api/api-error";
import { useMe } from "../../features/auth/hooks/use-auth";
import { QueryProvider } from "./query-provider";
import type { Organization } from "../../types/domain";

interface TenantContextValue {
  organizations: Organization[];
  currentOrganization: Organization | null;
  selectedOrganizationId: string | null;
  selectOrganization: (organizationId: string) => void;
  isLoading: boolean;
  isError: boolean;
  error: ApiError | null;
}

interface ThemeContextValue {
  resolved: "light" | "dark";
  toggle: () => void;
}

const TenantContext = createContext<TenantContextValue | undefined>(undefined);
const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function ThemeProvider({ children }: { children: ReactNode }) {
  const { resolved, setMode } = useDarkMode();
  const toggle = useCallback(() => {
    setMode(resolved === "dark" ? "light" : "dark");
  }, [resolved, setMode]);
  const value = useMemo(() => ({ resolved, toggle }), [resolved, toggle]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function TenantProvider({ children }: { children: ReactNode }) {
  const meQuery = useMe();
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string | null>(
    null,
  );
  const organizations = useMemo<Organization[]>(
    () =>
      meQuery.data?.organizations.map((organization) => ({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        role: organization.role,
      })) ?? [],
    [meQuery.data?.organizations],
  );

  const currentOrganization =
    organizations.find((organization) => organization.id === selectedOrganizationId) ??
    organizations[0] ??
    null;
  const effectiveSelectedOrganizationId = currentOrganization?.id ?? null;

  const selectOrganization = useCallback(
    (organizationId: string) => {
      if (organizations.some((organization) => organization.id === organizationId)) {
        setSelectedOrganizationId(organizationId);
      }
    },
    [organizations],
  );

  const value = useMemo<TenantContextValue>(
    () => ({
      organizations,
      currentOrganization,
      selectedOrganizationId: effectiveSelectedOrganizationId,
      selectOrganization,
      isLoading: meQuery.isPending,
      isError: meQuery.isError,
      error: meQuery.error ?? null,
    }),
    [
      currentOrganization,
      meQuery.error,
      meQuery.isError,
      meQuery.isPending,
      effectiveSelectedOrganizationId,
      organizations,
      selectOrganization,
    ],
  );

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

// Hooks are intentionally exported beside their providers for the app surface.
// eslint-disable-next-line react-refresh/only-export-components
export function useTenant(): TenantContextValue {
  const context = useContext(TenantContext);

  if (!context) {
    throw new Error("useTenant must be used within AppProviders");
  }

  return context;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error("useTheme must be used within AppProviders");
  }

  return context;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <PxlKitSurfaceProvider surface="pixel">
      <QueryProvider>
        <ThemeProvider>
          <TenantProvider>{children}</TenantProvider>
        </ThemeProvider>
      </QueryProvider>
    </PxlKitSurfaceProvider>
  );
}
