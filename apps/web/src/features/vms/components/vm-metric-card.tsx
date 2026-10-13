import type { ReactNode } from "react";

export function VmMetricCard({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail?: string;
  icon?: ReactNode;
}) {
  return (
    <section className="min-w-0 border border-retro-border bg-retro-surface p-3" aria-label={`${label} metric`}>
      <div className="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-retro-muted">
        <span>{label}</span>
        {icon ? <span aria-hidden="true" className="text-retro-cyan">{icon}</span> : null}
      </div>
      <p className="mt-2 break-words text-2xl font-semibold tabular-nums text-retro-text">{value}</p>
      {detail ? <p className="mt-1 text-xs text-retro-muted">{detail}</p> : null}
    </section>
  );
}
