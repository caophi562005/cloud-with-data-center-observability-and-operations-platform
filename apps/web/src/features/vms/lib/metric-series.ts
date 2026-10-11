import type { VmMetricPoint } from "../vm.types";
export interface MetricPlotPoint { x: number; value: number }

/** Split at missing samples or unreported intervals; never bridge telemetry gaps. */
export function metricSegments(points: VmMetricPoint[], from: string, to: string, step: number): MetricPlotPoint[][] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const segments: MetricPlotPoint[][] = [];
  let segment: MetricPlotPoint[] = [];
  let previous: number | undefined;
  for (const point of points) {
    const timestamp = Date.parse(point.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end || point.value === null || !Number.isFinite(point.value)) {
      segment = []; previous = undefined; continue;
    }
    if (previous !== undefined && (timestamp <= previous || timestamp - previous > step * 1000 * 1.5)) segment = [];
    if (!segment.length) { segment = []; segments.push(segment); }
    segment.push({ x: (timestamp - start) / (end - start), value: point.value });
    previous = timestamp;
  }
  return segments;
}
