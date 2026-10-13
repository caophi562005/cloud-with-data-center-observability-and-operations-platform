import { describe, expect, it } from "vitest";
import type { IntegrationDraft, IntegrationInstance, MonitoringCatalog, MonitoringConfigView, MonitoringSecretPatches } from "../monitoring.types";
import { buildIntegrationSaveInput } from "./integration-config-draft";
import { newIntegration, validateMonitoringDraft } from "./monitoring-draft";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
function fixture(): MonitoringConfigView {
  return {
    managed: true, version: 7, secretConfigured: { [A]: { password: true }, [B]: {} },
    definition: {
      schemaVersion: 1, profileKey: "telegraf-native-v1", host: Object.assign({ intervalSeconds: 60 }, { futureHost: { preserved: true } }),
      integrations: [
        { id: A, kind: "redis", enabled: true, intervalSeconds: 45, settings: { host: "localhost", port: 6379, tls: false } },
        Object.assign({ id: B, kind: "docker" as const, enabled: false, intervalSeconds: 120, settings: Object.assign({ endpoint: "unix:///var/run/docker.sock", acknowledgePrivilegedAccess: true as const }, { futureSetting: ["unchanged"] }) }, { futureInstance: { retained: true } }),
      ],
    },
  };
}
function selected(snapshot: MonitoringConfigView): IntegrationDraft { return structuredClone(snapshot.definition!.integrations[0]); }
const catalog: MonitoringCatalog = {
  host: { profileKey: "telegraf-native-v1", compatibility: "1.38.4", supportedOs: ["linux", "windows"], interval: { default: 60, minimum: 15, maximum: 3600 }, runtimeVerification: "UNVERIFIED", inputs: {}, system: { linux: {}, windows: {} } },
  integrations: ["redis", "docker"].map((kind) => ({ kind: kind as "redis" | "docker", title: kind, plugin: kind as "redis" | "docker", supportedOs: ["linux", "windows"], compatibility: "1.38.4", settingsFields: [], secretFields: [], fields: [], tags: [] })),
};
function dockerErrors(names: string[], enabled = true) {
  const snapshot = fixture(); const item = newIntegration("docker", "linux", 60);
  if (item.kind !== "docker") throw new Error("Docker fixture expected");
  item.settings.acknowledgePrivilegedAccess = true; item.settings.collectContainerMetrics = enabled; item.settings.containerNames = names;
  return validateMonitoringDraft({ ...snapshot.definition!, integrations: [item] }, {}, snapshot, catalog, "linux");
}

describe("single-integration canonical save input", () => {
  it("preserves host, other UUID/kind/enabled/interval/settings and unknown canonical data byte-equivalently", () => {
    const snapshot = fixture(); Object.assign(snapshot.definition!, { futureRoot: { value: "retained" } });
    const before = JSON.stringify(snapshot); const other = JSON.stringify(snapshot.definition!.integrations[1]); const draft = selected(snapshot); draft.intervalSeconds = 90;
    const input = buildIntegrationSaveInput(snapshot, A, draft, {});
    expect(input.expectedVersion).toBe(7); expect(input.definition.host).toEqual(snapshot.definition!.host);
    expect(JSON.stringify(input.definition.integrations[1])).toBe(other);
    expect(input.definition).toHaveProperty("futureRoot", { value: "retained" });
    expect(input.definition.integrations[0]).toMatchObject({ id: A, kind: "redis", intervalSeconds: 90 });
    expect(JSON.stringify(snapshot)).toBe(before);
  });
  it("clones rather than aliases snapshot, selected draft and patches", () => {
    const snapshot = fixture(); const draft = selected(snapshot); const secrets: MonitoringSecretPatches = { [A]: { password: { action: "set", value: "local-test-replacement" } } };
    const input = buildIntegrationSaveInput(snapshot, A, draft, secrets);
    input.definition.host.intervalSeconds = 200; input.definition.integrations[0].intervalSeconds = 300; input.secrets[A].password = { action: "clear" };
    expect(snapshot.definition!.host.intervalSeconds).toBe(60); expect(draft.intervalSeconds).toBe(45); expect(secrets[A].password?.action).toBe("set");
  });
  it("creates one new UUID without changing prior instances", () => {
    const snapshot = fixture(); const draft = { ...selected(snapshot), id: C };
    const input = buildIntegrationSaveInput(snapshot, C, draft, {});
    expect(input.definition.integrations.slice(0, 2)).toEqual(snapshot.definition!.integrations);
    expect(input.definition.integrations[2].id).toBe(C);
  });
  it("removes only the explicitly selected definition and retains host and B", () => {
    const snapshot = fixture(); const input = buildIntegrationSaveInput(snapshot, A, null, {});
    expect(input.definition.integrations).toEqual([snapshot.definition!.integrations[1]]); expect(input.definition.host).toEqual(snapshot.definition!.host); expect(input.expectedVersion).toBe(7);
  });
  it("rejects missing selected removal, absent UUID and draft UUID changes", () => {
    const snapshot = fixture(); expect(() => buildIntegrationSaveInput(snapshot, C, null, {})).toThrow();
    expect(() => buildIntegrationSaveInput(snapshot, "", selected(snapshot), {})).toThrow();
    expect(() => buildIntegrationSaveInput(snapshot, A, { ...selected(snapshot), id: C }, {})).toThrow();
  });
  it("rejects kind changes for an existing UUID", () => {
    const draft = newIntegration("mysql", "linux", 60); draft.id = A;
    expect(() => buildIntegrationSaveInput(fixture(), A, draft, {})).toThrow();
  });
  it("rejects duplicate snapshot UUIDs", () => {
    const snapshot = fixture(); snapshot.definition!.integrations.push(structuredClone(snapshot.definition!.integrations[0]));
    expect(() => buildIntegrationSaveInput(snapshot, A, selected(snapshot), {})).toThrow();
  });
  it("allows editing at sixteen instances but rejects creating seventeen", () => {
    const snapshot = fixture(); const original = selected(snapshot) as IntegrationInstance;
    snapshot.definition!.integrations = Array.from({ length: 16 }, (_, index) => ({ ...structuredClone(original), id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` }));
    expect(buildIntegrationSaveInput(snapshot, A, selected(snapshot), {}).definition.integrations).toHaveLength(16);
    const id = "00000000-0000-4000-8000-000000000099";
    expect(() => buildIntegrationSaveInput(snapshot, id, { ...selected(snapshot), id }, {})).toThrow();
    snapshot.definition!.integrations.push({ ...original, id });
    expect(() => buildIntegrationSaveInput(snapshot, A, selected(snapshot), {})).toThrow();
  });
  it.each([null, 0, 1.5])("rejects unavailable/invalid captured version %s", (version) => {
    const snapshot = fixture(); snapshot.version = version;
    expect(() => buildIntegrationSaveInput(snapshot, A, selected(snapshot), {})).toThrow();
  });
  it("rejects unmanaged or missing canonical definitions", () => {
    const snapshot = fixture(); const draft = selected(snapshot); snapshot.managed = false;
    expect(() => buildIntegrationSaveInput(snapshot, A, draft, {})).toThrow();
    snapshot.managed = true; snapshot.definition = null;
    expect(() => buildIntegrationSaveInput(snapshot, A, draft, {})).toThrow();
  });
  it.each(["keep", "set", "clear"] as const)("scopes %s credentials to A only, never definition or other instances", (action) => {
    const patch = action === "set" ? { action, value: "local-test-replacement" } : { action };
    const input = buildIntegrationSaveInput(fixture(), A, selected(fixture()), { [A]: { password: patch } });
    expect(input.secrets).toEqual({ [A]: { password: patch } });
    expect(Object.keys(input.secrets)).toEqual([A]); expect(JSON.stringify(input.definition)).not.toContain("local-test-replacement");
  });
  it("rejects unselected credential patches and patches during removal", () => {
    expect(() => buildIntegrationSaveInput(fixture(), A, selected(fixture()), { [B]: { password: { action: "keep" } } })).toThrow();
    expect(() => buildIntegrationSaveInput(fixture(), A, null, { [A]: { password: { action: "clear" } } })).toThrow();
  });
  it("never invents a Docker privileged acknowledgement", () => {
    const item = newIntegration("docker", "linux", 60);
    expect(() => buildIntegrationSaveInput(fixture(), item.id, item, {})).toThrow();
  });
});

describe("Docker bounded exact-name draft validation", () => {
  it("defaults to opt-out, empty selection, unacknowledged privileges and OS-locked endpoints", () => {
    const linux = newIntegration("docker", "linux", 60); const windows = newIntegration("docker", "windows", 60);
    expect(linux.settings).toEqual({ endpoint: "unix:///var/run/docker.sock", acknowledgePrivilegedAccess: false, collectContainerMetrics: false, containerNames: [] });
    expect(windows.settings).toMatchObject({ endpoint: "npipe:////./pipe/docker_engine" }); expect(linux.id).not.toBe(windows.id);
  });
  it("allows opt-out empty selection but never enabled empty selection", () => {
    expect(dockerErrors([], false)).toEqual([]); expect(dockerErrors([]).some((error) => error.fieldId.endsWith("-containerNames"))).toBe(true);
  });
  it.each([["*"], ["web*"], ["web", "web"], [""], [" web"], ["a".repeat(129)]].map((names) => ({ names })))("rejects wildcard, duplicate, blank or invalid name selection $names", ({ names }) => {
    expect(dockerErrors(names).some((error) => error.fieldId.endsWith("-containerNames"))).toBe(true);
  });
  it("allows 32 unique exact names of up to 128 characters, rejects 33", () => {
    const names = Array.from({ length: 31 }, (_, index) => `web_${index}.prod-1`); names.push("a".repeat(128));
    expect(dockerErrors(names)).toEqual([]); expect(dockerErrors([...names, "thirty-third"]).length).toBeGreaterThan(0);
  });
});
