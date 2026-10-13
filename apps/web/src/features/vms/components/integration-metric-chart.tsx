import { useId } from "react";
import { getBrowserTimeZone } from "../../../lib/date-time";
import type { IntegrationMetricDefinition, IntegrationMetricsHistory } from "../integration-metrics.types";
import { integrationMetricValue, integrationSampleTime, INTEGRATION_STATE_LABELS } from "../lib/integration-metric-format";
import { metricSegments } from "../lib/metric-series";

export function IntegrationMetricChart({ definition, history }: { definition: IntegrationMetricDefinition; history: IntegrationMetricsHistory }) {
  const titleId = useId();
  const segments = metricSegments(history.points, history.from, history.to, history.step);
  const values = segments.flatMap((segment) => segment.map((point) => point.value));
  const min = Math.min(0, ...values); const max = Math.max(1, ...values);
  const x = (value: number) => 56 + value * 574;
  const y = (value: number) => 160 - ((value - min) / (max - min)) * 142;
  const ticks = [0, 0.5, 1].map((fraction) => min + (max - min) * fraction);
  const zone = getBrowserTimeZone();
  const latest = history.points.at(-1);
  return <figure className="integration-card integration-chart" aria-labelledby={titleId}>
    <figcaption><h3 id={titleId}>{definition.label}</h3><p className="integration-muted">{definition.group} · {definition.unit} · {history.range} · {zone}</p></figcaption>
    <p className="integration-chart-latest">Last evaluation: <strong>{integrationMetricValue(latest?.value)}</strong> <span>{definition.unit}</span> · {integrationSampleTime(latest?.timestamp)}</p>
    <p className="integration-muted">{INTEGRATION_STATE_LABELS[history.state]}{history.reason ? ` · ${history.reason}` : ""}</p>
    {segments.length ? <div className="integration-chart-plot">
      <div className="integration-axis integration-chart-y-axis">
        {ticks.map((value, index) => <span key={index} style={{ top: y(value) }}>{new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value)}</span>)}
      </div>
      <svg viewBox="0 0 640 198" preserveAspectRatio="none" role="img" aria-label={`${definition.label} in ${definition.unit}; gaps are missing samples`} className="integration-chart-svg">
        <title>{definition.label} · {definition.unit} · {integrationSampleTime(history.from)} to {integrationSampleTime(history.to)} · {zone}. Values are not clipped at 100; missing samples remain gaps.</title>
        {ticks.map((value, index) => <line key={index} className="integration-chart-gridline" x1="56" x2="630" y1={y(value)} y2={y(value)} />)}
        {segments.map((segment, index) => segment.length === 1 ? <circle key={index} cx={x(segment[0].x)} cy={y(segment[0].value)} r="3" fill="currentColor" /> : <polyline key={index} points={segment.map((point) => `${x(point.x)},${y(point.value)}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
      </svg>
      <div className="integration-axis integration-chart-x-axis">
        <span>{integrationSampleTime(history.from)}</span><span>{integrationSampleTime(history.to)}</span>
      </div>
    </div> : <p role="status" className="integration-chart-empty">{history.state === "unsupported" ? "History is unsupported for this collector/platform." : history.state === "not-applicable" ? "This metric is not applicable to the reported inputs." : history.state === "stale" ? "No usable fresh evaluations in this range." : "No samples in this time range."}</p>}
    <p className="integration-muted">{definition.description} Missing evaluations are gaps, never zero or interpolated.</p>
    <details><summary>View {definition.label} evaluations</summary><div className="integration-table-scroll" role="region" aria-label={`${definition.label} evaluation table`} tabIndex={0}>
      <table><caption>History evaluation times ({zone}), not last source sample times</caption><thead><tr><th scope="col">Time</th><th scope="col">Value ({definition.unit})</th></tr></thead><tbody>{history.points.map((point, index) => <tr key={`${point.timestamp}-${index}`}><td>{integrationSampleTime(point.timestamp)}</td><td>{point.value == null || !Number.isFinite(point.value) ? "Missing" : integrationMetricValue(point.value)}</td></tr>)}</tbody></table>
    </div></details>
  </figure>;
}
