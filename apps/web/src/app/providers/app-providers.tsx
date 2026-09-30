import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  PxlKitSurfaceProvider,
  useDarkMode,
} from "@pxlkit/ui-kit";
import { organizations } from "../../mocks/organizations";
import type { Organization } from "../../types/domain";

interface TenantContextValue {
  organizations: Organization[];
  currentOrganization: Organization;
  selectOrganization: (organizationId: string) => void;
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
  const [currentOrganization, setCurrentOrganization] = useState<Organization>(
    organizations[0],
  );
  const selectOrganization = useCallback((organizationId: string) => {
    const nextOrganization = organizations.find(
      (organization) => organization.id === organizationId,
    );

    if (nextOrganization) {
      setCurrentOrganization(nextOrganization);
    }
  }, []);
  const value = useMemo(
    () => ({ organizations, currentOrganization, selectOrganization }),
    [currentOrganization, selectOrganization],
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
      <ThemeProvider>
        <TenantProvider>{children}</TenantProvider>
      </ThemeProvider>
    </PxlKitSurfaceProvider>
  );
}
