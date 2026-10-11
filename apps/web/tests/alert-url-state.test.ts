import { describe, expect, it } from "vitest";
import { readAlertListState, patchAlertListState, readAlertSelection, patchAlertSelection } from "../src/features/alerts/lib/alert-url-state";
import { orgA, alertId } from "./support/alert-fixtures";
describe("alert URL state", () => {
  it("normalizes malformed input before it reaches a strict API", () => {
    expect(readAlertListState(new URLSearchParams("tab=invalid&q=" + "a".repeat(121) + "&page=-1&pageSize=500&vmId=wrong&severity=evil&workflowStatus=wrong&sort=wrong"))).toEqual({ tab: "firing", q: "", page: 1, pageSize: 50, sort: "severity_desc" });
  });
  it("retains all valid list filters and source sort", () => {
    expect(readAlertListState(new URLSearchParams(`tab=history&q=+CPU+&page=2&pageSize=25&vmId=${alertId}&severity=CRITICAL&workflowStatus=ACKNOWLEDGED&sort=started_at_asc`))).toEqual({ tab: "history", q: "CPU", page: 2, pageSize: 25, vmId: alertId, severity: "CRITICAL", workflowStatus: "ACKNOWLEDGED", sort: "started_at_asc" });
  });
  it("resets pagination for filter changes but preserves unrelated parameters and overlay", () => {
    const start = new URLSearchParams(`tab=firing&page=4&custom=keep&alertId=${alertId}&alertOrganizationId=${orgA}`);
    const changed = patchAlertListState(start, { q: "CPU" });
    expect(changed.get("page")).toBe("1"); expect(changed.get("q")).toBe("CPU"); expect(changed.get("custom")).toBe("keep"); expect(readAlertSelection(changed)).toEqual({ organizationId: orgA, alertId });
    expect(patchAlertListState(changed, { page: 3 }).get("page")).toBe("3"); expect(start.get("page")).toBe("4");
  });
  it("opens and closes without touching page filters or other navigation state", () => {
    const start = new URLSearchParams("tab=history&page=2&vmId=" + alertId + "&custom=keep");
    const open = patchAlertSelection(start, { organizationId: orgA, alertId });
    expect(readAlertSelection(open)).toEqual({ organizationId: orgA, alertId });
    expect(patchAlertSelection(open, null).toString()).toBe(start.toString()); expect(start.has("alertId")).toBe(false);
  });
  it("requires both well-formed selection IDs without deriving a tenant", () => {
    for (const value of [`alertId=${alertId}`, `alertOrganizationId=${orgA}`, `alertId=wrong&alertOrganizationId=${orgA}`, `alertId=${alertId}&alertOrganizationId=wrong`]) expect(readAlertSelection(new URLSearchParams(value))).toBeNull();
  });
});
