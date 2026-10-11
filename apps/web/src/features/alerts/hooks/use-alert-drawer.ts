import { createContext, useContext } from "react";
import type { AlertSelection } from "../alert.types";
export interface AlertDrawerContextValue {
  selection: AlertSelection | null; listReady: boolean; unavailable: boolean;
  openAlert(selection: AlertSelection, opener?: HTMLElement): void; closeAlert(): void;
}
export const AlertDrawerContext = createContext<AlertDrawerContextValue | null>(null);
export function useAlertDrawer(): AlertDrawerContextValue {
  const value = useContext(AlertDrawerContext);
  if (!value) throw new Error("Alert drawer requires its feature provider");
  return value;
}
