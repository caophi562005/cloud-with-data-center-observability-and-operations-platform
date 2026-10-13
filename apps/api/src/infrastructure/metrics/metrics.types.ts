export interface MetricSample {
  timestamp: number;
  value: number | null;
}
export interface MetricVector extends MetricSample {
  labels: Record<string, string>;
}
export interface MetricMatrix {
  labels: Record<string, string>;
  values: MetricSample[];
}
