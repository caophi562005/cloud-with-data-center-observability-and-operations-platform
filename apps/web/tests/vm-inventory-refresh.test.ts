import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VmsPage } from "../src/features/vms/pages/vms-page";
import { inventoryFixtures, windowsCapabilities, unknownCapabilities } from "./fixtures/vms";

const query = vi.hoisted(() => ({
  data: [] as unknown[],
  isPending: false,
  isFetching: false,
  isError: false,
  error: null,
  refetch: vi.fn(),
}));

vi.mock("../src/app/providers/app-providers", () => ({
  useTenant: () => ({ currentOrganization: { id: "org-refresh-test" } }),
}));
vi.mock("../src/features/vms/hooks/use-vms", () => ({
  useVms: () => query,
  useCreateVm: () => ({ data: undefined, isPending: false, isError: false }),
}));

function renderInventory() {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(VmsPage)));
}

function inventoryRows(markup: string) {
  return [markup.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0] ?? "", ...[...markup.matchAll(/<article\b[\s\S]*?<\/article>/g)].map((match) => match[0])].join("");
}

function refreshButton(markup: string) {
  return markup.match(/<button\b[^>]*aria-label="Refresh virtual machines"[^>]*>[\s\S]*?<\/button>/)?.[0];
}

describe("VM inventory refresh presentation", () => {
  beforeEach(() => {
    query.data = [inventoryFixtures[0]];
    query.isPending = false;
    query.isFetching = false;
    query.isError = false;
    query.refetch.mockReset();
  });

  it("offers authoritative native health and neutral host-state filters", () => {
    const markup = renderInventory();
    const healthFilters = [...markup.matchAll(/aria-label="Filter by ([^"]+)"/g)].map((match) => match[1]);
    expect(healthFilters).toEqual(["Healthy", "Warning", "Critical", "Disconnected", "Unknown host state", "Unsupported host state"]);
  });

  it("places an accessible text refresh button beside the inventory count", () => {
    const markup = renderInventory();
    const button = refreshButton(markup);
    expect(button).toBeDefined();
    expect(markup).toMatch(/of 1 virtual machines<\/p>[\s\S]*?aria-label="Refresh virtual machines"/);
    expect(button).toContain('title="Refresh virtual machines"');
    expect(button).toContain("Refresh</span>");
    expect(button).not.toContain("<img");
    expect(button).toContain('aria-busy="false"');
    expect(button).not.toContain('disabled=""');
    expect(button).not.toContain("animate-spin");
  });

  it("keeps the inventory visible and disables refresh without an icon or animation", () => {
    query.isFetching = true;
    const markup = renderInventory();
    const button = refreshButton(markup);
    expect(button).toContain('disabled=""');
    expect(button).toContain('aria-busy="true"');
    expect(button).toContain("Refresh</span>");
    expect(button).not.toContain("animate-spin");
    expect(button).not.toContain("<img");
    expect(markup).toContain("Virtual machine inventory");
    expect(markup).toContain("Refreshing virtual machine inventory");
  });

  it("keeps inventory but explains provider-disabled telemetry instead of implying an empty provider", () => {
    query.data = [{ ...inventoryFixtures[0], metricsState: "disabled" }];
    const markup = renderInventory();
    expect(markup).toContain("Metrics integration is disabled"); expect(markup).toContain("Virtual machine inventory");
  });
  it("retains inventory but explains unavailable telemetry", () => {
    query.data = [{ ...inventoryFixtures[0], metricsState: "unavailable" }];
    const markup = renderInventory();
    expect(markup).toContain("Metrics are unavailable"); expect(markup).toContain("Virtual machine inventory");
  });
  // Dropping capability reasons or widening inventory beyond four metrics must fail here.
  it("keeps the Windows four-metric desktop/mobile subset and supported zeros", () => {
    query.data = [{ ...inventoryFixtures[3], metricsCapabilities: windowsCapabilities, metrics: { cpu: 0, memory: null, disk: 3, networkRx: 4, networkTx: 5, load: null, uptimeHours: 49 } }];
    const markup = renderInventory();
    expect(markup).toContain("hidden overflow-x-auto md:block"); expect(markup).toContain("grid gap-3 md:hidden");
    expect(markup.match(/0\.0%/g)).toHaveLength(2);
    expect(inventoryRows(markup)).not.toContain("Unsupported");
    expect(markup).not.toContain("Network RX"); expect(markup).not.toContain("Network TX"); expect(markup).not.toContain(">Load<");
  });
  it("explains unknown capability in both layouts without a physical outage claim", () => {
    query.data = [{ ...inventoryFixtures[0], status: "DISCONNECTED", hostState: "unsupported", telemetryCompatibility: "unknown", telemetryDelivery: "unsupported", agentStatus: "ACTIVE", metricsCapabilities: unknownCapabilities }];
    const markup = renderInventory();
    expect(markup.match(/Unsupported platform/g) ?? []).toHaveLength(2);
    expect(markup.match(/N\/A/g)).toHaveLength(8);
    expect(inventoryRows(markup).match(/>Unsupported host state</g)).toHaveLength(2);
    expect(inventoryRows(markup)).not.toContain(">Disconnected<");
    expect(markup).not.toContain("No fresh telemetry");
  });
  it.each(["disabled", "unavailable"])("%s provider state precedes unknown inventory reason", (metricsState) => {
    query.data = [{ ...inventoryFixtures[0], metricsState, metricsCapabilities: unknownCapabilities }];
    const markup = renderInventory();
    expect(markup).not.toContain("Unsupported platform"); expect(markup).not.toContain("N/A");
    expect(markup).toContain(metricsState === "disabled" ? "Metrics integration is disabled" : "Metrics are unavailable");
  });
  it.each(["pending", "error"])("retains %s inventory precedence over cached capabilities", (state) => {
    query.data = [{ ...inventoryFixtures[0], metricsCapabilities: unknownCapabilities }];
    query.isPending = state === "pending"; query.isError = state === "error";
    const markup = renderInventory();
    expect(markup).not.toContain("Unsupported platform");
    expect(markup).toContain(state === "pending" ? "Loading virtual machine inventory" : "Unable to load virtual machines");
    if (state === "error") expect(markup).toContain("Try again");
  });
  it("legacy Windows nulls remain missing rather than inferred unsupported", () => {
    query.data = [inventoryFixtures[3]];
    const markup = renderInventory();
    expect(inventoryRows(markup)).not.toContain("Unsupported"); expect(markup).not.toContain("N/A"); expect(markup).toContain("—");
  });
  it("allows refresh for an empty inventory", () => {
    query.data = [];
    const markup = renderInventory();
    expect(refreshButton(markup)).toBeDefined();
    expect(markup).toContain("No virtual machines yet");
  });

  it("enables refresh again after fetching finishes", () => {
    query.isFetching = true;
    expect(refreshButton(renderInventory())).toContain('disabled=""');
    query.isFetching = false;
    const button = refreshButton(renderInventory());
    expect(button).not.toContain('disabled=""');
    expect(button).not.toContain("animate-spin");
  });
});
