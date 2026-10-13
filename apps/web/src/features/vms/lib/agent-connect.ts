import { resolveApiOrigin } from "../../../../config/api-origin";

export const NATIVE_AGENT_BUILD_ID = "opsgrid-custom-6ab4b57bbaede19d";
export const NATIVE_AGENT_RELEASE_URL = `https://github.com/caophi562005/cloud-with-data-center-observability-and-operations-platform/releases/download/${NATIVE_AGENT_BUILD_ID}`;
// Installers run on remote machines, so never use the browser's relative dev URL.
const API_BASE_URL = resolveApiOrigin(
  import.meta.env.VITE_AGENT_API_URL ?? import.meta.env.VITE_API_URL,
  true,
  "VITE_AGENT_API_URL",
);
const GATEWAY_URL = "https://ingest.opsgrid.hacmieu.com/api/v1/write";

function quoteBash(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function canManageAgent(role: string | undefined): boolean {
  return role === "ADMIN" || role === "OPERATOR";
}

export function buildLinuxAgentCommand(token?: string, reEnroll = false): string {
  // sudo clears the parent's environment: explicit env assignment reaches root.
  // This initial assignment can be visible in argv/history; no secret on pipe stdin.
  const launch = token ? `sudo env OPSGRID_ENROLLMENT_TOKEN=${quoteBash(token)} bash` : "sudo bash";
  return `curl -fsSL ${quoteBash(`${NATIVE_AGENT_RELEASE_URL}/install-launcher.sh`)} | ${launch} -s -- --api-base-url ${quoteBash(API_BASE_URL)} --gateway-url ${quoteBash(GATEWAY_URL)}${reEnroll ? " --re-enroll" : ""}`;
}

export function buildWindowsAgentCommand(token?: string, reEnroll = false): string {
  const launch = `& ([scriptblock]::Create((irm ${quotePowerShell(`${NATIVE_AGENT_RELEASE_URL}/install-launcher.ps1`)}))) -ApiBaseUrl ${quotePowerShell(API_BASE_URL)} -GatewayUrl ${quotePowerShell(GATEWAY_URL)}${reEnroll ? " -ReEnroll" : ""}`;
  return token
    ? `$env:OPSGRID_ENROLLMENT_TOKEN=${quotePowerShell(token)}; try { ${launch} } finally { Remove-Item Env:OPSGRID_ENROLLMENT_TOKEN -ErrorAction SilentlyContinue }`
    : launch;
}
