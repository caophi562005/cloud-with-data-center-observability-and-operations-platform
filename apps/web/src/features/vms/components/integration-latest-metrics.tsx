import { useState } from "react";
import { getBrowserTimeZone } from "../../../lib/date-time";
import type { IntegrationMetricsCurrent } from "../integration-metrics.types";
import { integrationMetricValue, integrationSampleTime, INTEGRATION_STATE_LABELS } from "../lib/integration-metric-format";

export function IntegrationLatestMetrics({ current, selectedMetric, selectedEntity, onSelect }: {
  current: IntegrationMetricsCurrent; selectedMetric: string | null; selectedEntity: string | null;
  onSelect: (metric: string, entity: string | null) => void;
}) {
  const [search, setSearch] = useState(""); const [group, setGroup] = useState(""); const [state, setState] = useState(""); const [entity, setEntity] = useState("");
  const groups = [...new Set(current.definitions.map((metric) => metric.group))];
  const rows = current.definitions.flatMap((definition) => {
    const readings = current.readings.filter((reading) => reading.key === definition.key);
    // A missing reading is explicitly unknown, not a synthetic fresh zero.
    return (readings.length ? readings : [{ key: definition.key, entityKey: null, value: null, lastSampleAt: null, state: "no-data" as const, reason: "No reading reported" }]).map((reading) => ({ definition, reading }));
  }).filter(({ definition, reading }) => (!group || definition.group === group) && (!state || (current.dataState === "disabled" ? "disabled" : reading.state) === state)
    && (!entity || reading.entityKey === entity) && `${definition.label} ${definition.key} ${definition.group} ${current.entities.find((item) => item.key === reading.entityKey)?.label ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="integration-stack" aria-labelledby="integration-latest-heading">
    <div><h2 id="integration-latest-heading">Latest metrics</h2><p className="integration-muted">Reported source values · {getBrowserTimeZone()} · Select a metric for an inline history chart.</p></div>
    <div className="integration-filters">
      <label>Search metrics<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Label, metric or entity" /></label>
      <label>Group<select value={group} onChange={(event) => setGroup(event.target.value)}><option value="">All groups</option>{groups.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>Data state<select value={state} onChange={(event) => setState(event.target.value)}><option value="">All states</option>{Object.entries(INTEGRATION_STATE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label>Entity filter<select value={entity} onChange={(event) => setEntity(event.target.value)}><option value="">All reported entities / global</option>{current.entities.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
    </div>
    <p className="integration-muted" role="status">{rows.length} metric readings match{current.entitiesTruncated ? " · Entity results truncated by the server; this is not a complete inventory." : ""}</p>
    <div className="integration-table-scroll" role="region" aria-label="Latest metric readings" tabIndex={0}><table>
      <caption>Latest reported metrics. Missing values are not zero; sample presence is not service health.</caption>
      <thead><tr><th scope="col">Metric / entity</th><th scope="col">Value</th><th scope="col">Unit</th><th scope="col">Source sample ({getBrowserTimeZone()})</th><th scope="col">State / reason</th></tr></thead>
      <tbody>{rows.map(({ definition, reading }) => <tr key={`${definition.key}:${reading.entityKey ?? "global"}`}>
        <th scope="row"><button type="button" className="integration-metric-link" disabled={!definition.chart} aria-pressed={selectedMetric === definition.key && selectedEntity === reading.entityKey} onClick={() => onSelect(definition.key, reading.entityKey)}>{definition.label}</button><span className="integration-muted integration-entity-label">{reading.entityKey ? current.entities.find((item) => item.key === reading.entityKey)?.label ?? "Reported entity" : "Global / no entity"} · {definition.group}</span><details><summary>Metric details</summary><p>{definition.description}</p><code>{definition.key}</code><p>{definition.semanticType}</p></details></th>
        <td className="integration-number">{integrationMetricValue(reading.value)}</td><td>{definition.unit}</td><td>{integrationSampleTime(reading.lastSampleAt)}</td><td>{current.dataState === "disabled" ? "Disabled" : INTEGRATION_STATE_LABELS[reading.state]}{reading.reason ? <span className="integration-muted integration-entity-label">{reading.reason}</span> : null}</td>
      </tr>)}</tbody>
    </table>{!rows.length ? <p role="status" className="integration-card">No metrics match these filters.</p> : null}</div>
  </section>;
}
