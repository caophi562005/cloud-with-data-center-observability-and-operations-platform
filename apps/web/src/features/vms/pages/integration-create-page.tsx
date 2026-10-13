import { PixelButton, PixelEmptyState } from "@pxlkit/ui-kit";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useTenant } from "../../../app/providers/app-providers";
import { IntegrationConfigEditor } from "../components/integration-config-editor";
import { isValidVmId, useVm } from "../hooks/use-vms";
import { useMonitoringCatalog, useVmMonitoringConfig } from "../hooks/use-monitoring";
import { canManageAgent } from "../lib/agent-connect";
import { integrationReadError } from "../lib/integration-metric-format";
import { integrationDetailPath, vmIntegrationsPath } from "../lib/integration-route";
import "./integration-detail.css";

export function IntegrationCreatePage() {
  const { vmId } = useParams<{ vmId: string }>(); const { currentOrganization } = useTenant();
  if (!currentOrganization) return <PixelEmptyState title="No organization selected" description="Select an organization to configure an integration." />;
  if (!vmId || !isValidVmId(vmId)) return <PixelEmptyState title="Invalid VM link" description="Choose a VM from the VM list." action={<Link to="/vms">Back to VMs</Link>} />;
  return <IntegrationCreateSession key={`${currentOrganization.id}:${vmId}:${currentOrganization.role}`} organizationId={currentOrganization.id} vmId={vmId} role={currentOrganization.role} />;
}
function IntegrationCreateSession({ organizationId, vmId, role }: { organizationId: string; vmId: string; role: string }) {
  const navigate = useNavigate(); const vmQuery = useVm(organizationId, vmId);
  const configQuery = useVmMonitoringConfig(organizationId, vmId); const catalogQuery = useMonitoringCatalog(organizationId);
  const back = <Link className="integration-back" to={vmIntegrationsPath(vmId)}>← Back to VM integrations</Link>;
  const denied = [vmQuery.error?.statusCode, configQuery.error?.statusCode, catalogQuery.error?.statusCode].some((status) => status === 403 || status === 404);
  if (denied || (vmQuery.isError && !vmQuery.data) || (configQuery.isError && !configQuery.data) || (catalogQuery.isError && !catalogQuery.data)) {
    const error = vmQuery.error ?? configQuery.error ?? catalogQuery.error;
    return <div className="integration-detail integration-stack">{back}<PixelEmptyState title="Configuration unavailable" description={integrationReadError(error?.statusCode ?? 0, "Integration configuration")} action={<PixelButton tone="neutral" onClick={() => { void vmQuery.refetch(); void configQuery.refetch(); void catalogQuery.refetch(); }}>Retry configuration</PixelButton>} /></div>;
  }
  if (!vmQuery.data || !configQuery.data || !catalogQuery.data) return <div className="integration-detail integration-stack">{back}<p role="status">Loading VM and native monitoring catalog…</p></div>;
  const vm = vmQuery.data; const config = configQuery.data; const catalog = catalogQuery.data;
  const os = vm.osType === "Linux" ? "linux" : vm.osType === "Windows" ? "windows" : null;
  const editable = Boolean(canManageAgent(role) && config.managed && config.definition && config.version !== null && vm.collectorType === "TELEGRAF" && vm.telemetryCompatibility === "native" && os && catalog.host.supportedOs.includes(os));
  return <div className="integration-detail integration-stack" data-testid="integration-create-page">{back}<header><h1>Add integration</h1><p className="integration-muted">{vm.hostname} · Native catalog targets only. No discovery or network probe.</p></header>
    {editable && os ? <IntegrationConfigEditor key={`${organizationId}:${vmId}:new:${role}:${os}`} organizationId={organizationId} vmId={vmId} role={role} os={os} initial={config} catalog={catalog} onCancel={() => navigate(vmIntegrationsPath(vmId))} onSaved={(savedId) => { if (savedId) navigate(`${integrationDetailPath(vmId, savedId)}?tab=configuration`, { replace: true }); }} /> : <PixelEmptyState title="Read-only configuration" description="Adding an integration requires Admin or Operator access, a managed native Telegraf definition and a known supported operating system. No default definition will be saved." />}
  </div>;
}
