import type { MetricName, VmMetricsCapabilities } from "../vm.types";

/** Missing wire metadata keeps the legacy presentation; values and OS labels are not evidence of support. */
export function isMetricSupported(capabilities: VmMetricsCapabilities | undefined, name: MetricName): boolean {
  return capabilities === undefined || capabilities.supported.includes(name);
}

export function unsupportedMetricReason(capabilities: VmMetricsCapabilities | undefined, name: MetricName): string | undefined {
  if (isMetricSupported(capabilities, name)) return undefined;
  if (capabilities?.platform === "windows") return "Unsupported on Windows";
  if (capabilities?.platform === "unknown") return "Unsupported platform";
  return "Unsupported metric";
}
