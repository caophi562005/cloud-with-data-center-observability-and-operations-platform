import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildLinuxAgentCommand,
  buildWindowsAgentCommand,
} from "../src/features/vms/lib/agent-connect";

const TOKEN = "ENR_test-token";
const RELEASE = "https://github.com/caophi562005/cloud-with-data-center-observability-and-operations-platform/releases/download/opsgrid-custom-6ab4b57bbaede19d";
const API = "https://api.opsgrid.hacmieu.com";
const GATEWAY = "https://ingest.opsgrid.hacmieu.com/api/v1/write";
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";

// Execute only local fixture functions: no downloads or privileged operations.
function runLinux(command: string, download: "success" | "empty-failure" | "partial-failure" = "success") {
  return spawnSync(bash, ["--noprofile", "--norc", "-c", `
    curl() {
      ${download === "empty-failure" ? "" : "printf '%s' 'printf \"TOKEN:%s\\n\" \"$OPSGRID_ENROLLMENT_TOKEN\"; printf \"EXEC:%s\\n\" \"$@\"'"}
      return ${download === "success" ? 0 : 18}
    }
    sudo() { "$@"; }
    ${command}
  `], { encoding: "utf8" });
}

function runWindows(command: string, downloadFails = false) {
  return spawnSync(powershell, ["-NoProfile", "-Command", `
    function Invoke-RestMethod { param($Uri)
      ${downloadFails ? "throw 'download-failed'" : `'param([string]$ApiBaseUrl, [string]$GatewayUrl) Write-Output ("TOKEN:" + $env:OPSGRID_ENROLLMENT_TOKEN); Write-Output ("API:" + $ApiBaseUrl); Write-Output ("GATEWAY:" + $GatewayUrl)'`}
    }
    try { ${command} }
    catch {
      if (Test-Path Env:OPSGRID_ENROLLMENT_TOKEN) { throw 'token not cleared after failure' }
      Write-Output 'TOKEN_CLEARED'
      exit 1
    }
    if (Test-Path Env:OPSGRID_ENROLLMENT_TOKEN) { throw 'token not cleared after success' }
    Write-Output 'TOKEN_CLEARED'
  `], { encoding: "utf8" });
}

const hasPowerShell = spawnSync(powershell, ["-NoProfile", "-Command", "exit 0"]).status === 0;

function linuxOutput(token: string) {
  return `TOKEN:${token}\nEXEC:--api-base-url\nEXEC:${API}\nEXEC:--gateway-url\nEXEC:${GATEWAY}\n`;
}

describe("agent connect commands", () => {
  it("builds the pinned native Linux streaming command with environment token and explicit endpoints", () => {
    const command = buildLinuxAgentCommand(TOKEN);
    expect(command).toBe(`curl -fsSL '${RELEASE}/install-launcher.sh' | sudo env OPSGRID_ENROLLMENT_TOKEN='${TOKEN}' bash -s -- --api-base-url '${API}' --gateway-url '${GATEWAY}'`);
    expect(command.split("\n")).toHaveLength(1);
    expect(command).not.toContain("--token");
  });

  it.skipIf(!existsSync(bash))("passes the literal token to the Bash launcher without shell expansion", () => {
    const token = "ENR_quote' $(printf INJECTED) ; $HOME";
    const result = runLinux(buildLinuxAgentCommand(token));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(linuxOutput(token));
  });

  it.skipIf(!existsSync(bash))("does not execute code when the Linux download returns no body", () => {
    const result = runLinux(buildLinuxAgentCommand(TOKEN), "empty-failure");
    expect(result.stdout).not.toContain("EXEC:");
    expect(result.stdout).not.toContain("TOKEN:");
  });

  it.skipIf(!existsSync(bash))("documents that streaming can execute a partial download before curl fails", () => {
    const result = runLinux(buildLinuxAgentCommand(TOKEN), "partial-failure");
    // Intentional trade-off: streaming does not gate execution on curl success.
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(linuxOutput(TOKEN));
  });

  it("builds the pinned native Windows environment-token scriptblock command", () => {
    const command = buildWindowsAgentCommand(TOKEN);
    expect(command).toBe(`$env:OPSGRID_ENROLLMENT_TOKEN='${TOKEN}'; try { & ([scriptblock]::Create((irm '${RELEASE}/install-launcher.ps1'))) -ApiBaseUrl '${API}' -GatewayUrl '${GATEWAY}' } finally { Remove-Item Env:OPSGRID_ENROLLMENT_TOKEN -ErrorAction SilentlyContinue }`);
    expect(command.split("\n")).toHaveLength(1);
    expect(command).not.toContain("-OutFile");
  });

  it.skipIf(!hasPowerShell)("passes a literal Windows token with apostrophes and metacharacters", () => {
    const token = "ENR_quote' $(Write-Output INJECTED); $HOME";
    const result = runWindows(buildWindowsAgentCommand(token));
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toEqual([`TOKEN:${token}`, `API:${API}`, `GATEWAY:${GATEWAY}`, "TOKEN_CLEARED"]);
  });

  it.skipIf(!hasPowerShell)("does not execute Windows code after a failed download and clears its token", () => {
    const result = runWindows(buildWindowsAgentCommand(TOKEN), true);
    expect(result.status).not.toBe(0);
    expect(result.stdout.trim()).toBe("TOKEN_CLEARED");
    expect(result.stdout).not.toContain("TOKEN:");
    expect(result.stdout).not.toContain("API:");
  });
});
