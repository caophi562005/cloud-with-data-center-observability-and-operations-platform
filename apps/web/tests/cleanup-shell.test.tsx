// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "../src/components/shell/app-header";
import { AlertDrawerProvider } from "../src/features/alerts/components/alert-drawer-provider";
import { click, mountAlertUi } from "./support/alert-ui-test-utils";
let mounted: Awaited<ReturnType<typeof mountAlertUi>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});
describe("truthful shell affordances", () => {
  it("disables unavailable search and account actions but keeps working sign out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ items: [], total: 0, page: 1, pageSize: 50 }),
            { headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    mounted = await mountAlertUi(
      <AlertDrawerProvider>
        <AppHeader />
      </AlertDrawerProvider>,
    );
    const search = [...mounted.container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Search"),
    );
    expect(search?.disabled).toBe(true);
    expect(search?.textContent).toContain("unavailable");
    expect(search?.querySelector("kbd")).toBeNull();
    await click(
      mounted.container.querySelector('[aria-label="Open user menu"]'),
    );
    for (const name of ["Profile", "Account settings"]) {
      const item = [
        ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      ].find((button) => button.textContent?.includes(name));
      expect(item?.disabled).toBe(true);
      expect(item?.textContent).toContain("unavailable");
    }
    const signOut = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((button) => button.textContent === "Sign out");
    expect(signOut?.disabled).toBe(false);
  });
});
