export function collectorLabel(type: string | null, version: string | null): string {
  const name = type === "TELEGRAF" ? "Telegraf" : type === "ALLOY" ? "Alloy" : "Collector unknown";
  const concise = version?.match(/\d+\.\d+\.\d+/)?.[0];
  return concise ? `${name} ${concise}` : name;
}
