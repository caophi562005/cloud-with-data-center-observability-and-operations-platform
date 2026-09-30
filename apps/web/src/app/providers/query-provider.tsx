import {
  QueryClientProvider,
  type QueryClientProviderProps,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { queryClient } from "../../lib/query/query-client";

interface QueryProviderProps {
  children: ReactNode;
}

export function QueryProvider({ children }: QueryProviderProps) {
  const providerProps: QueryClientProviderProps = {
    client: queryClient,
    children,
  };

  return <QueryClientProvider {...providerProps} />;
}
