import { afterEach, describe, expect, it, vi } from "vitest";
import { getAlerts, getAlert, getAlertEvents, acknowledgeAlert, addAlertComment } from "../src/features/alerts/api/alerts.api";
import { ApiError } from "../src/lib/api/api-error";
import { alertFixture, eventFixture, alertId, orgA } from "./support/alert-fixtures";
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function json(body: unknown, status = 200, headers: HeadersInit = {}) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } }); }
describe("real alert API transport with fetch boundary replaced", () => {
  it("encodes literal search and forwards credentials and AbortSignal", async () => {
    const fixture = alertFixture(); const page = { items: [fixture], total: 1, page: 2, pageSize: 50 };
    const fetch = vi.fn().mockResolvedValue(json(page)); vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    expect(await getAlerts(orgA, { page: 2, pageSize: 50, signalStatus: "FIRING", workflowStatus: "OPEN", severity: "WARNING", vmId: fixture.vmId, sort: "severity_desc", q: "edge +_%" }, controller.signal)).toEqual(page);
    const [url, options] = fetch.mock.calls[0]; const parsed = new URL(url, "https://example.test");
    expect(parsed.pathname).toBe(`/api/v1/organizations/${orgA}/alerts`);
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ page: "2", pageSize: "50", signalStatus: "FIRING", workflowStatus: "OPEN", severity: "WARNING", vmId: fixture.vmId, sort: "severity_desc", q: "edge +_%" });
    expect(options).toMatchObject({ credentials: "include", signal: controller.signal });
  });
  it("retains exact source-time strings for detail and paginated events", async () => {
    const detail = alertFixture(); const event = eventFixture(); const page = { items: [event], total: 61, page: 2, pageSize: 50 };
    const fetch = vi.fn().mockResolvedValueOnce(json(detail)).mockResolvedValueOnce(json(page)); vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    expect(await getAlert(orgA, alertId, signal)).toEqual(detail);
    expect(await getAlertEvents(orgA, alertId, 2, 50, signal)).toEqual(page);
    expect(fetch.mock.calls[1][0]).toBe(`/api/v1/organizations/${orgA}/alerts/${alertId}/events?page=2&pageSize=50`);
    expect(fetch.mock.calls[1][1]).toMatchObject({ signal, credentials: "include" });
  });
  it("sends strict empty ACK and message-only comment without actor or tenant bodies", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(alertFixture({ workflowStatus: "ACKNOWLEDGED" }))).mockResolvedValueOnce(json(eventFixture({ type: "COMMENT_ADDED", message: "Checked ✅" }), 201)); vi.stubGlobal("fetch", fetch);
    await acknowledgeAlert("org/encoded", "alert/encoded"); await addAlertComment(orgA, alertId, "Checked ✅");
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/v1/organizations/org%2Fencoded/alerts/alert%2Fencoded/acknowledge", expect.objectContaining({ method: "POST", body: "{}", credentials: "include", headers: { "Content-Type": "application/json" } }));
    expect(fetch).toHaveBeenNthCalledWith(2, `/api/v1/organizations/${orgA}/alerts/${alertId}/comments`, expect.objectContaining({ method: "POST", body: '{"message":"Checked ✅"}', credentials: "include" }));
  });
  it.each([403, 404, 429, 503])("propagates HTTP %s without retrying a comment", async (status) => {
    const fetch = vi.fn().mockResolvedValue(json({ code: "UNAVAILABLE", message: "Unavailable" }, status)); vi.stubGlobal("fetch", fetch);
    await expect(addAlertComment(orgA, alertId, "One delivery only")).rejects.toMatchObject({ statusCode: status }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("exposes only valid Retry-After seconds and date through ApiError", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-10T00:00:00Z"));
    expect(ApiError.fromResponse(json({}, 429, { "Retry-After": "45" }), {}).retryAfterMs).toBe(45_000);
    expect(ApiError.fromResponse(json({}, 429, { "Retry-After": "Sat, 10 Oct 2026 00:01:00 GMT" }), {}).retryAfterMs).toBe(60_000);
    for (const header of ["not a date", "-2", "0.5", ""])
      expect(ApiError.fromResponse(json({}, 429, { "Retry-After": header }), {}).retryAfterMs).toBeUndefined();
    expect(ApiError.fromResponse(json({ retryAfterMs: 2 }, 429), { retryAfterMs: 2 }).retryAfterMs).toBeUndefined();
  });
});
