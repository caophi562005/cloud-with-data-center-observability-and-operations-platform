import { useState, type JSX } from "react";
import { Outlet } from "react-router-dom";
import { AppHeader } from "../../components/shell/app-header";
import { AppSidebar } from "../../components/shell/app-sidebar";
import { AlertDrawerProvider } from "../../features/alerts/components/alert-drawer-provider";
import { AlertDetailDrawer } from "../../features/alerts/components/alert-detail-drawer";
import { useAlertDrawer } from "../../features/alerts/hooks/use-alert-drawer";

function AppShell(): JSX.Element {
  const drawer = useAlertDrawer();
  const [collapsed, setCollapsed] = useState(false);
  const shellColumns = collapsed
    ? "grid-cols-[3.5rem_minmax(0,1fr)]"
    : "grid-cols-[14rem_minmax(0,1fr)]";

  return (
    <><div
      inert={Boolean(drawer.selection)}
      className={`fixed inset-0 grid h-screen min-h-0 overflow-hidden bg-[var(--cloudops-page)] ${shellColumns} max-[901px]:static max-[901px]:inset-auto max-[901px]:h-auto max-[901px]:min-h-screen max-[901px]:overflow-visible max-[901px]:grid-cols-[minmax(0,1fr)]`}
      data-sidebar-collapsed={collapsed ? "true" : "false"}
    >
      <AppSidebar collapsed={collapsed} onCollapsedChange={setCollapsed} />
      <div className="flex h-screen min-h-0 min-w-0 flex-col overflow-x-hidden overflow-y-auto overscroll-contain bg-[var(--cloudops-page)] max-[901px]:h-auto max-[901px]:min-h-0 max-[901px]:overflow-visible">
        <AppHeader />
        <main className="mx-auto w-full max-w-[88rem] flex-[1_0_auto] px-[clamp(1rem,3vw,3rem)] pt-8 pb-12 max-[901px]:px-4 max-[901px]:pt-6 max-[901px]:pb-8">
          <Outlet />
        </main>
      </div>
    </div><AlertDetailDrawer selection={drawer.selection} onClose={drawer.closeAlert} /></>
  );
}

export function AppLayout(): JSX.Element {
  return <AlertDrawerProvider><AppShell /></AlertDrawerProvider>;
}
