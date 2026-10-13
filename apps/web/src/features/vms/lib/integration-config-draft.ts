import type { IntegrationDraft, IntegrationInstance, MonitoringConfigView, MonitoringSaveInput, MonitoringSecretPatches } from "../monitoring.types";
import { MAX_INTEGRATIONS } from "./monitoring-draft";

/** Only the selected definition changes; unselected canonical data is cloned, not rebuilt. */
export function buildIntegrationSaveInput(snapshot: MonitoringConfigView, instanceId: string, draft: IntegrationDraft | null, secrets: MonitoringSecretPatches): MonitoringSaveInput {
  if (!snapshot.managed || !snapshot.definition || !Number.isSafeInteger(snapshot.version) || snapshot.version! < 1)
    throw new Error("A managed versioned definition is required.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(instanceId)) throw new Error("A canonical selected instance UUID is required.");
  const definition = structuredClone(snapshot.definition);
  const ids = definition.integrations.map((item) => item.id);
  if (ids.length > MAX_INTEGRATIONS || new Set(ids).size !== ids.length) throw new Error("Invalid instance collection.");
  if (Object.keys(secrets).some((id) => id !== instanceId)) throw new Error("Credentials must belong only to the selected instance.");
  const index = ids.indexOf(instanceId);
  if (draft === null) {
    if (index < 0 || Object.keys(secrets).length) throw new Error("Removal requires an existing selected instance and no credential patches.");
    definition.integrations.splice(index, 1);
  } else {
    if (draft.id !== instanceId) throw new Error("The selected instance ID cannot change.");
    if (index >= 0 && definition.integrations[index].kind !== draft.kind) throw new Error("An existing integration kind cannot change.");
    if (index < 0 && ids.length >= MAX_INTEGRATIONS) throw new Error("Use no more than 16 integration instances.");
    if (draft.kind === "docker" && !draft.settings.acknowledgePrivilegedAccess) throw new Error("Docker privileges require explicit acknowledgement.");
    const selected = structuredClone(draft) as IntegrationInstance;
    if (index >= 0) definition.integrations[index] = selected;
    else definition.integrations.push(selected);
  }
  return { expectedVersion: snapshot.version!, definition, secrets: structuredClone(secrets) };
}
