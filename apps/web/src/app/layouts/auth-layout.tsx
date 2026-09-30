import type { JSX } from "react";
import type * as React from "react";
import { ThemeToggle } from "../../components/shell/theme-toggle";
import "../../features/auth/auth.css";

export function AuthLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <main className="auth-layout">
      <div className="auth-layout-tools">
        <ThemeToggle />
      </div>
      <div className="auth-layout-grid">{children}</div>
    </main>
  );
}
