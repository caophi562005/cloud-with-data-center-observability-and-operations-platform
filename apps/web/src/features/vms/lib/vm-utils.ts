import type { Vm, VmFilters, VmGroupBy, VmHostState } from "../vm.types";
import { formatLocalDateTime } from "../../../lib/date-time";

export const STATUS_LABELS: Record<VmHostState, string> = {
  HEALTHY: "Healthy",
  WARNING: "Warning",
  CRITICAL: "Critical",
  DISCONNECTED: "Disconnected",
  unknown: "Unknown host state",
  unsupported: "Unsupported host state",
};

export const STATUS_TONES: Record<VmHostState, "cyan" | "green" | "gold" | "red" | "neutral"> = {
  HEALTHY: "green",
  WARNING: "gold",
  CRITICAL: "red",
  DISCONNECTED: "neutral",
  unknown: "neutral",
  unsupported: "neutral",
};

export function tagToString(key: string, value: string): string {
  return `${key}:${value}`;
}

export function tagsToOptions(vms: Vm[]): string[] {
  return Array.from(
    new Set(vms.flatMap((vm) => Object.entries(vm.tags).map(([key, value]) => tagToString(key, value)))),
  ).sort((a, b) => a.localeCompare(b));
}

export function tagKeys(vms: Vm[]): string[] {
  return Array.from(new Set(vms.flatMap((vm) => Object.keys(vm.tags)))).sort((a, b) => a.localeCompare(b));
}

export function filterVms(vms: Vm[], filters: VmFilters): Vm[] {
  const query = filters.query.trim().toLocaleLowerCase();

  return vms.filter((vm) => {
    const matchesQuery = query.length === 0 || vm.hostname.toLocaleLowerCase().includes(query);
    const matchesStatus = filters.status === "ALL" || (vm.hostState ?? "unknown") === filters.status;
    const matchesTags = filters.tags.every((selectedTag) => {
      const [key, ...valueParts] = selectedTag.split(":");
      const value = valueParts.join(":");
      return Boolean(key && value && vm.tags[key] === value);
    });

    return matchesQuery && matchesStatus && matchesTags;
  });
}

export function groupVms(vms: Vm[], groupBy: VmGroupBy): Array<{ label: string; vms: Vm[] }> {
  if (groupBy === "none") return [{ label: "All virtual machines", vms }];

  const groups = new Map<string, Vm[]>();
  const getKey = (vm: Vm): string => {
    if (groupBy === "os") return vm.osType;
    if (groupBy === "status") return STATUS_LABELS[vm.hostState ?? "unknown"];
    if (groupBy === "untagged") return Object.keys(vm.tags).length === 0 ? "Untagged" : "Tagged";
    const key = groupBy.slice(4);
    return vm.tags[key] ? `${key}: ${vm.tags[key]}` : `No ${key} tag`;
  };

  vms.forEach((vm) => {
    const key = getKey(vm);
    groups.set(key, [...(groups.get(key) ?? []), vm]);
  });

  return Array.from(groups.entries()).map(([label, groupedVms]) => ({ label, vms: groupedVms }));
}

export function formatMetric(value: number | null | undefined, suffix = "%"): string {
  return value === null || value === undefined ? "—" : `${value.toFixed(1)}${suffix}`;
}

export function formatLoad(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toFixed(2);
}

export function formatUptime(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return "—";
  const days = Math.floor(hours / 24);
  const remainingHours = Math.floor(hours % 24);
  return days > 0 ? `${days}d ${remainingHours}h` : `${remainingHours}h`;
}

export function formatLastSeen(lastSeenAt: string | null): string {
  if (!lastSeenAt) return "Not recorded";
  return formatLocalDateTime(lastSeenAt);
}

export function parseTagsInput(input: string): { tags: Record<string, string>; error?: string } {
  if (!input.trim()) return { tags: {} };
  const tags: Record<string, string> = {};
  const chunks = input.split(",").map((chunk) => chunk.trim()).filter(Boolean);

  for (const chunk of chunks) {
    const separatorIndex = chunk.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === chunk.length - 1) {
      return { tags: {}, error: `Use key:value format for “${chunk}”.` };
    }
    const key = chunk.slice(0, separatorIndex).trim();
    const value = chunk.slice(separatorIndex + 1).trim();
    if (!key || !value || key.includes(" ")) {
      return { tags: {}, error: `Use a non-empty key and value for “${chunk}”.` };
    }
    if (Object.prototype.hasOwnProperty.call(tags, key)) {
      return { tags: {}, error: `The ${key} tag is listed more than once.` };
    }
    tags[key] = value;
  }

  return { tags };
}

export function validateTagInput(key: string, value: string): string | undefined {
  const normalizedKey = key.trim();
  const normalizedValue = value.trim();
  if (!normalizedKey) return "Tag key is required.";
  if (!normalizedValue) return "Tag value is required.";
  if (normalizedKey.includes(":")) return "Tag keys cannot contain a colon.";
  if (normalizedKey.includes(" ")) return "Tag keys cannot contain spaces.";
  if (normalizedValue.includes("\n")) return "Tag values must be one line.";
  return undefined;
}

export function visibleTags(tags: Record<string, string>, limit = 2): {
  visible: string[];
  hiddenCount: number;
} {
  const values = Object.entries(tags).map(([key, value]) => tagToString(key, value));
  return { visible: values.slice(0, limit), hiddenCount: Math.max(0, values.length - limit) };
}
