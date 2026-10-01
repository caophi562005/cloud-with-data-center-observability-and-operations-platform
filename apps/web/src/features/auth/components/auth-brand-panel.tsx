import type { JSX } from "react";
import { PixelIconFrame } from "@pxlkit/ui-kit";
import { PxlKitIcon } from "../../../components/ui/pxlkit-icon";

export function AuthBrandPanel(): JSX.Element {
  return (
    <section
      className="relative isolate flex min-h-screen flex-col justify-center overflow-hidden border-r-2 border-retro-border bg-retro-surface px-[clamp(2rem,7vw,7rem)] py-8 max-[901px]:min-h-0 max-[901px]:border-r-0 max-[901px]:border-b-2 max-[901px]:px-[clamp(1.5rem,7vw,4rem)] max-[901px]:py-8 max-[640px]:px-4 max-[640px]:pb-6 max-[640px]:pt-[4.5rem] lg:py-16"
      aria-labelledby="auth-brand-title"
    >
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 -z-10 bg-[url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E%3Cpath d='M32 0H0V32' fill='none' stroke='%2339d5df' stroke-opacity='.22' stroke-width='1'/%3E%3C/svg%3E")] bg-[length:2rem_2rem] opacity-[0.45] max-[901px]:hidden`}
      />
      <div className="relative z-10 grid w-full max-w-[34rem] gap-6 max-[901px]:grid-cols-[auto_minmax(0,1fr)] max-[901px]:items-center max-[901px]:gap-4 max-[640px]:grid-cols-[minmax(0,1fr)]">
        <div className="inline-flex items-center justify-start" aria-hidden="true">
          <PixelIconFrame
            icon={<PxlKitIcon name="cloud" size={32} />}
            tone="cyan"
            shape="square"
          />
        </div>
        <div className="grid min-w-0 gap-2">
          <h1
            id="auth-brand-title"
            className="[overflow-wrap:anywhere] font-[var(--font-pixel)] text-[clamp(1.5rem,3.8vw,3rem)] font-normal leading-[1.4] tracking-[0.05em] text-retro-cyan max-[640px]:text-[clamp(1.35rem,9vw,2rem)]"
          >
            OpsGrid
          </h1>
          <p className="max-w-[32rem] text-[clamp(0.95rem,1.5vw,1.125rem)] leading-[1.7] text-[var(--cloudops-text)]">
            Cloud &amp; Data Center Observability Platform
          </p>
          <ul
            aria-label="OpsGrid capabilities"
            className="mt-6 grid list-none gap-2 p-0 text-retro-muted max-[901px]:mt-4"
          >
            <li className="relative pl-6 leading-normal">
              <span
                aria-hidden="true"
                className="absolute left-0 top-2 size-2 border border-retro-cyan bg-[var(--cloudops-accent-soft)]"
              />
              Monitor infrastructure.
            </li>
            <li className="relative pl-6 leading-normal">
              <span
                aria-hidden="true"
                className="absolute left-0 top-2 size-2 border border-retro-cyan bg-[var(--cloudops-accent-soft)]"
              />
              Detect incidents.
            </li>
            <li className="relative pl-6 leading-normal">
              <span
                aria-hidden="true"
                className="absolute left-0 top-2 size-2 border border-retro-cyan bg-[var(--cloudops-accent-soft)]"
              />
              Operate with confidence.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
