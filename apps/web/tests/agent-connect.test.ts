import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildLinuxAgentCommand,
  buildWindowsAgentCommand,
} from "../src/features/vms/lib/agent-connect";

const TOKEN = "ENR_test-token";
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";
const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";

// Execute only local fixture functions: no downloads or privileged operations.
function runLinux(command: string, download: "success" | "empty-failure" | "partial-failure" = "success") {
  return spawnSync(bash, ["--noprofile", "--norc", "-c", `
    curl() {
      ${download === "empty-failure" ? "" : "printf '%s' 'printf \"EXEC:%s\\n\" \"$@\"'"}
      return ${download === "success" ? 0 : 18}
    }
    sudo() { "$@"; }
    ${command}
  `], { encoding: "utf8" });
}

function runWindows(command: string, downloadFails = false) {
  return spawnSync(powershell, ["-NoProfile", "-Command", `
    function Invoke-RestMethod { param($Uri)
      ${downloadFails ? "throw 'download-failed'" : `'Write-Output ("EXEC:" + $env:OPSGRID_ENROLLMENT_TOKEN); [Environment]::SetEnvironmentVariable("OPSGRID_ENROLLMENT_TOKEN", $null, "Process")'`}
    }
    ${command}
    ${downloadFails ? "" : "if ($env:OPSGRID_ENROLLMENT_TOKEN) { throw 'fixture did not consume token' }"}
  `], { encoding: "utf8" });
}

const hasPowerShell = spawnSync(powershell, ["-NoProfile", "-Command", "exit 0"]).status === 0;

describe("agent connect commands", () => {
  it("builds the ultra-short Linux streaming command", () => {
    const command = buildLinuxAgentCommand(TOKEN);
    expect(command).toBe(`curl -fsSL https://get.opsgrid.hacmieu.com/linux | sudo bash -s -- --token '${TOKEN}'`);
    expect(command.split("\n")).toHaveLength(1);
    expect(command.length).toBeLessThan(105);
    expect(command).not.toContain("github.com");
  });

  it.skipIf(!existsSync(bash))("passes the literal token to the Bash launcher without shell expansion", () => {
    const token = "ENR_quote' $(printf INJECTED) ; $HOME";
    const result = runLinux(buildLinuxAgentCommand(token));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`EXEC:--token\nEXEC:${token}\n`);
  });

  it.skipIf(!existsSync(bash))("does not execute code when the Linux download returns no body", () => {
    const result = runLinux(buildLinuxAgentCommand(TOKEN), "empty-failure");
    expect(result.stdout).not.toContain("EXEC:");
  });

  it.skipIf(!existsSync(bash))("documents that streaming can execute a partial download before curl fails", () => {
    const result = runLinux(buildLinuxAgentCommand(TOKEN), "partial-failure");
    // Intentional trade-off: this short form no longer gates execution on curl success.
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`EXEC:--token\nEXEC:${TOKEN}\n`);
  });

  it("builds the ultra-short Windows environment-token IEX command", () => {
    const command = buildWindowsAgentCommand(TOKEN);
    expect(command).toBe(`$env:OPSGRID_ENROLLMENT_TOKEN='${TOKEN}';irm https://get.opsgrid.hacmieu.com/windows|iex`);
    expect(command.split("\n")).toHaveLength(1);
    expect(command.length).toBeLessThan(110);
    expect(command).not.toContain("github.com");
    expect(command).not.toContain("-OutFile");
  });

  it.skipIf(!hasPowerShell)("passes a literal Windows token with apostrophes and metacharacters", () => {
    const token = "ENR_quote' $(Write-Output INJECTED); $HOME";
    const result = runWindows(buildWindowsAgentCommand(token));
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`EXEC:${token}`);
  });

  it.skipIf(!hasPowerShell)("does not execute Windows code after a failed download", () => {
    const result = runWindows(buildWindowsAgentCommand(TOKEN), true);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("EXEC:");
  });
});
