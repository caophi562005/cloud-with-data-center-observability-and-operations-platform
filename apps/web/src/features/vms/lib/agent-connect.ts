const AGENT_INSTALLER_BASE_URL = "https://get.opsgrid.hacmieu.com";

function quoteBash(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildLinuxAgentCommand(token: string): string {
  // Deliberately stream execution for the user-requested ultra-short command.
  return `curl -fsSL ${AGENT_INSTALLER_BASE_URL}/linux | sudo bash -s -- --token ${quoteBash(token)}`;
}

export function buildWindowsAgentCommand(token: string): string {
  // The launcher consumes and clears this process-local token environment variable.
  return `$env:OPSGRID_ENROLLMENT_TOKEN=${quotePowerShell(token)};irm ${AGENT_INSTALLER_BASE_URL}/windows|iex`;
}
