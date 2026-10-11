import { describe, expect, it } from "vitest";
import { inventoryFixtures } from "./fixtures/vms";
import type { VmFilters } from "../src/features/vms/vm.types";
import { filterVms, formatLoad, formatMetric, formatUptime, groupVms, parseTagsInput, tagsToOptions, validateTagInput, visibleTags } from "../src/features/vms/lib/vm-utils";
const noFilters: VmFilters = { query: "", status: "ALL", tags: [] };

describe("VM inventory domain presentation", () => {
  it("filters hostname, status, and tags with AND semantics", () => {
    expect(filterVms(inventoryFixtures, { ...noFilters, query: "DB-PRIMARY" }).map((vm) => vm.hostname)).toEqual(["db-primary-01"]);
    expect(filterVms(inventoryFixtures, { ...noFilters, status: "WARNING" }).map((vm) => vm.hostname)).toEqual(["api-prod-01"]);
    expect(filterVms(inventoryFixtures, { ...noFilters, tags: ["site:iad-01", "env:production"] }).map((vm) => vm.hostname)).toEqual(["api-prod-01", "db-primary-01"]);
    expect(filterVms(inventoryFixtures, { ...noFilters, tags: ["site:iad-01", "role:database"] }).map((vm) => vm.hostname)).toEqual(["db-primary-01"]);
  });
  it("groups by operating system, status, derived tag key, and untagged state", () => {
    expect(groupVms(inventoryFixtures, "os").map((group) => group.label)).toEqual(["Linux", "Windows"]);
    expect(groupVms(inventoryFixtures, "status").map((group) => group.label)).toEqual(["Healthy", "Warning", "Critical", "Disconnected"]);
    expect(groupVms(inventoryFixtures, "tag:site").some((group) => group.label === "No site tag")).toBe(true);
    expect(groupVms(inventoryFixtures, "untagged").map((group) => group.label)).toEqual(["Tagged", "Untagged"]);
    expect(groupVms(inventoryFixtures, "none")[0]?.vms).toHaveLength(5);
  });
  it("summarizes compact tags and exposes all tag filter options", () => {
    expect(visibleTags({ site: "sea-01", role: "edge", env: "production" }, 2)).toEqual({ visible: ["site:sea-01", "role:edge"], hiddenCount: 1 });
    expect(tagsToOptions(inventoryFixtures)).toContain("env:production"); expect(tagsToOptions(inventoryFixtures)).toContain("site:sea-01");
  });
});
describe("VM tag input validation", () => {
  it("parses optional key:value tags and rejects malformed input", () => {
    expect(parseTagsInput("site:sea-01, role:edge")).toEqual({ tags: { site: "sea-01", role: "edge" } });
    expect(parseTagsInput("")).toEqual({ tags: {} }); expect(parseTagsInput("site").error).toContain("key:value");
    expect(parseTagsInput("site:sea-01, :missing").error).toBeDefined(); expect(parseTagsInput("site:sea-01, site:iad-01").error).toContain("more than once");
  });
  it("requires trimmed unique tag fields without spaces in keys", () => {
    expect(validateTagInput(" ", "value")).toBe("Tag key is required."); expect(validateTagInput("site", " ")).toBe("Tag value is required.");
    expect(validateTagInput("site:name", "sea")).toContain("colon"); expect(validateTagInput("site name", "sea")).toContain("spaces"); expect(validateTagInput("site", "sea-01")).toBeUndefined();
  });
});
describe("VM metric presentation", () => {
  it("uses explicit dashes for missing data and readable units for reported data", () => {
    expect(formatMetric(null)).toBe("—"); expect(formatMetric(0)).toBe("0.0%"); expect(formatMetric(34.25)).toBe("34.3%");
    expect(formatLoad(undefined)).toBe("—"); expect(formatLoad(1.236)).toBe("1.24"); expect(formatUptime(undefined)).toBe("—"); expect(formatUptime(49)).toBe("2d 1h");
  });
});
