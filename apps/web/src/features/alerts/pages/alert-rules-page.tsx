import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  PixelAccordion,
  PixelBadge,
  PixelButton,
  PixelEmptyState,
} from "@pxlkit/ui-kit";
import { useTenant } from "../../../app/providers/app-providers";
import { useAlertRules, useAlertCooldown } from "../hooks/use-alerts";
const title = (value: string) =>
  value[0].toUpperCase() + value.slice(1).toLowerCase();
const duration = (seconds: number) =>
  seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} sec`;
export function AlertRulesPage(): JSX.Element {
  const tenant = useTenant();
  const org = tenant.isLoading
    ? null
    : (tenant.currentOrganization?.id ?? null);
  const rules = useAlertRules(org);
  const cooldown = useAlertCooldown(rules.error);
  if (tenant.isLoading) return <p role="status">Loading organization…</p>;
  if (!org)
    return (
      <PixelEmptyState
        title="No organization available"
        description="Select an authorized organization to view shared VM rules."
      />
    );
  const terminal = Boolean(
    rules.error && [401, 403, 404].includes(rules.error.statusCode),
  );
  const errorText =
    rules.error?.statusCode === 403
      ? "You do not have permission to view rules."
      : rules.error?.statusCode === 401
        ? "Your session is unavailable. Sign in again."
        : rules.error?.statusCode === 404
          ? "Rules are not available for this organization."
          : rules.error?.statusCode === 429
            ? "Rules refresh is rate limited. Wait before retrying."
            : "Rules are temporarily unavailable.";
  return (
    <section
      className="mx-auto max-w-5xl space-y-6"
      aria-labelledby="alert-rules-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 id="alert-rules-heading" className="text-2xl font-semibold">
            Alert rules
          </h1>
          <p className="mt-2 text-sm text-retro-muted">
            {tenant.currentOrganization?.name} · Read-only shared VM
            configuration
          </p>
        </div>
        <PixelBadge tone="cyan">Managed by Terraform / AWS AMP</PixelBadge>
      </div>
      <p className="max-w-prose text-sm leading-relaxed text-retro-muted">
        Definitions are shared VM rules. Firing and pending state and active
        counts show only this organization. Editing, routing and silence
        controls are not available.
      </p>
      <div className="flex items-center justify-between gap-3">
        <p
          role="status"
          aria-live="polite"
          className="text-xs text-retro-muted"
        >
          {rules.isFetching
            ? rules.data
              ? "Refreshing rules…"
              : "Loading rules…"
            : rules.data && !terminal
              ? `${rules.data.items.length} shared VM rules`
              : ""}
        </p>
        <PixelButton
          type="button"
          variant="ghost"
          disabled={rules.isFetching || cooldown}
          onClick={() => {
            if (!cooldown) void rules.refetch();
          }}
        >
          Refresh
        </PixelButton>
      </div>
      {rules.isError ? (
        <div role="alert" className="border-2 border-retro-amber p-4">
          <p>{errorText}</p>
          {rules.data && !terminal ? (
            <p className="mt-2 text-xs">
              Previously fetched configuration is shown below; evaluation may be
              stale.
            </p>
          ) : null}
          <PixelButton
            type="button"
            variant="ghost"
            disabled={cooldown || rules.isFetching}
            onClick={() => {
              if (!cooldown) void rules.refetch();
            }}
          >
            Retry
          </PixelButton>
        </div>
      ) : null}
      {rules.data && !terminal ? (
        rules.data.items.length ? (
          <PixelAccordion
            key={org}
            collapsedByDefault
            allowMultiple
            items={rules.data.items.map((rule) => ({
              id: rule.name,
              title: `${rule.name} · ${title(rule.severity)} · ${title(rule.state)}`,
              content: (
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    <PixelBadge
                      tone={rule.severity === "CRITICAL" ? "red" : "gold"}
                    >
                      {title(rule.severity)}
                    </PixelBadge>
                    <PixelBadge
                      tone={
                        rule.state === "firing"
                          ? "red"
                          : rule.state === "pending" || rule.state === "unknown"
                            ? "gold"
                            : "cyan"
                      }
                    >
                      {title(rule.state)}
                    </PixelBadge>
                    <span>{rule.activeAlerts} active in this organization</span>
                  </div>
                  <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-retro-muted">Hold duration</dt>
                      <dd>{duration(rule.forSeconds)}</dd>
                    </div>
                    <div>
                      <dt className="text-retro-muted">Evaluation interval</dt>
                      <dd>{duration(rule.intervalSeconds)}</dd>
                    </div>
                    <div>
                      <dt className="text-retro-muted">Namespace</dt>
                      <dd className="break-all">{rule.namespace}</dd>
                    </div>
                    <div>
                      <dt className="text-retro-muted">Group</dt>
                      <dd className="break-all">{rule.group}</dd>
                    </div>
                    <div>
                      <dt className="text-retro-muted">Evaluation health</dt>
                      <dd>
                        {rule.health === "ok" ? "OK" : "Not healthy / unknown"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-retro-muted">Last evaluation</dt>
                      <dd>
                        {rule.lastEvaluation ? (
                          <time
                            dateTime={rule.lastEvaluation}
                            title={rule.lastEvaluation}
                          >
                            {new Date(rule.lastEvaluation).toLocaleString()}
                          </time>
                        ) : (
                          "Unavailable"
                        )}
                      </dd>
                    </div>
                  </dl>
                  <div>
                    <h2 className="mb-2 font-semibold text-retro-text">
                      PromQL
                    </h2>
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all border-2 border-retro-border bg-retro-surface p-3 font-mono text-xs text-retro-text">
                      {rule.promql}
                    </pre>
                  </div>
                  <div className="space-y-2 break-words">
                    <h2 className="font-semibold text-retro-text">
                      Annotations
                    </h2>
                    {Object.entries(rule.annotations).map(([key, value]) => (
                      <p key={key}>
                        <span className="font-medium">{key}: </span>
                        {value}
                      </p>
                    ))}
                  </div>
                  <div className="break-words text-xs">
                    <span className="font-medium">Labels: </span>
                    {Object.entries(rule.labels)
                      .map(([key, value]) => `${key}=${value}`)
                      .join(", ") || "None"}
                  </div>
                </div>
              ),
            }))}
          />
        ) : (
          <PixelEmptyState
            title="No shared VM rules"
            description="The current metrics backend returned no supported shared VM rules. No configuration is fabricated."
          />
        )
      ) : null}
      <Link
        to="/alerts"
        className="inline-block text-sm text-retro-cyan underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-retro-cyan"
      >
        View alerts
      </Link>
    </section>
  );
}
