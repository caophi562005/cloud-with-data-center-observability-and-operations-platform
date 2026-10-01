import { useState, type JSX } from "react";
import { Outlet } from "react-router-dom";
import { AppHeader } from "../../components/shell/app-header";
import { AppSidebar } from "../../components/shell/app-sidebar";

export function AppLayout(): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const shellColumns = collapsed
    ? "grid-cols-[3.5rem_minmax(0,1fr)]"
    : "grid-cols-[14rem_minmax(0,1fr)]";

  return (
    <div
      className={`grid min-h-screen bg-[var(--cloudops-page)] ${shellColumns} max-[901px]:grid-cols-[minmax(0,1fr)]`}
      data-sidebar-collapsed={collapsed ? "true" : "false"}
    >
      <AppSidebar collapsed={collapsed} onCollapsedChange={setCollapsed} />
      <div className="flex h-screen min-h-screen min-w-0 flex-col overflow-x-hidden overflow-y-auto overscroll-contain bg-[var(--cloudops-page)] max-[901px]:h-auto max-[901px]:min-h-0 max-[901px]:overflow-visible">
        <AppHeader />
        <main className="mx-auto w-full max-w-[88rem] flex-[1_0_auto] px-[clamp(1rem,3vw,3rem)] pt-8 pb-12 max-[901px]:px-4 max-[901px]:pt-6 max-[901px]:pb-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
