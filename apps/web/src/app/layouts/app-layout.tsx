import type { JSX } from "react";
import { Outlet } from "react-router-dom";
import { AppHeader } from "../../components/shell/app-header";
import { AppSidebar } from "../../components/shell/app-sidebar";

export function AppLayout(): JSX.Element {
  return (
    <div className="cloudops-shell">
      <AppSidebar />
      <div className="cloudops-main-column">
        <AppHeader />
        <main className="cloudops-main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
