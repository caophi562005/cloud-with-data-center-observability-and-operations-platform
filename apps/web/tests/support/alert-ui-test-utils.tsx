import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { AppProviders } from "../../src/app/providers/app-providers";
import { queryClient } from "../../src/lib/query/query-client";
import type { MeResponse } from "../../src/features/auth/auth.types";
import type { Role } from "../../src/types/domain";
import { orgA, orgB } from "./alert-fixtures";
export function meFixture(role: Role = "ADMIN"): MeResponse {
  return { user: { id: "actor-id", email: "actor@example.test", displayName: "Ada" }, organizations: [
    { id: orgA, name: "Organization A", slug: "org-a", role }, { id: orgB, name: "Organization B", slug: "org-b", role },
  ] };
}
export async function mountAlertUi(children: ReactNode, path = "/alerts", me = meFixture()) {
  queryClient.clear(); queryClient.setQueryData(["me"], me);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  await act(async () => { root.render(<MemoryRouter initialEntries={[path]}><AppProviders>{children}</AppProviders></MemoryRouter>); });
  return { container, root, async unmount() { await act(async () => root.unmount()); container.remove(); queryClient.clear(); } };
}
export async function click(element: Element | null) { if (!(element instanceof HTMLElement)) throw new Error("Missing interactive element"); await act(async () => element.click()); }
