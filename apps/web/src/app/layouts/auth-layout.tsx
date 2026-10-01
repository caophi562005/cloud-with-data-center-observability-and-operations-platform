import type { JSX } from "react";
import type * as React from "react";
import { ThemeToggle } from "../../components/shell/theme-toggle";

export function AuthLayout({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <main className="relative grid min-h-screen grid-cols-[minmax(20rem,40vw)_minmax(28rem,1fr)] overflow-x-hidden bg-[var(--cloudops-page)] text-[var(--cloudops-text)] max-[901px]:grid-cols-1">
      <div className="absolute right-4 top-4 z-10 sm:right-8 sm:top-8 lg:right-10 lg:top-8">
        <ThemeToggle />
      </div>
      {children}
    </main>
  );
}
