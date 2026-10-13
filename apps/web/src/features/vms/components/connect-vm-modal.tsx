import { useLayoutEffect, useRef, useState } from "react";
import { PixelButton, PixelModal } from "@pxlkit/ui-kit";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../../lib/query/query-keys";
import { formatLocalDateTime, getBrowserTimeZone } from "../../../lib/date-time";
import {
  issueOrganizationInstallCode, issueVmEnrollmentToken,
  revokeOrganizationInstallCode, revokeVmAgent,
} from "../api/vms.api";
import {
  buildLinuxAgentCommand, buildWindowsAgentCommand, canManageAgent,
  NATIVE_AGENT_BUILD_ID,
} from "../lib/agent-connect";

interface ConnectVmModalProps {
  open: boolean;
  organizationId: string;
  role: string | undefined;
  mode?: "connect" | "reinstall" | "recover";
  vmId?: string;
  hostname?: string;
  agentActive?: boolean;
  onClose: () => void;
}
interface LocalCode { id: string; token: string; expiresAt: string }

/** Conditional, tenant/VM/role-keyed lifetime: no secret can survive closing or scope change. */
export function ConnectVmModal(props: ConnectVmModalProps) {
  if (!props.open) return null;
  return <ConnectSession key={`${props.organizationId}:${props.vmId ?? ""}:${props.role ?? ""}:${props.mode ?? "connect"}`} {...props} />;
}

function ConnectSession({ organizationId, role, mode = "connect", vmId, hostname, agentActive, onClose }: ConnectVmModalProps) {
  const client = useQueryClient();
  const [code, setCode] = useState<LocalCode>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [now, setNow] = useState(Date.now());
  const lifetime = useRef({ active: true, busy: false, generation: 0, controller: undefined as AbortController | undefined });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const allowed = canManageAgent(role);
  const expired = Boolean(code && Date.parse(code.expiresAt) <= now);
  const canIssue = allowed && (mode === "connect" || (mode === "recover" && vmId && (!agentActive || revoked)));

  useLayoutEffect(() => {
    const session = lifetime.current;
    session.active = true;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      session.active = false;
      session.generation += 1;
      session.controller?.abort();
      clearInterval(timer);
    };
  }, []);

  function close() {
    const session = lifetime.current;
    session.active = false;
    session.generation += 1;
    session.controller?.abort();
    setCode(undefined); setConfirmed(false); setCopied(""); setError(""); setPending(false);
    // Clearing the display is NOT revocation; copied unused codes remain valid until expiry.
    closeRef.current();
  }

  async function request(action: "issue" | "revoke-code" | "revoke-agent") {
    const session = lifetime.current;
    if (!session.active || session.busy || !allowed) return;
    if (action === "issue" && (!canIssue || code)) return;
    if (action === "revoke-code" && (mode !== "connect" || !code)) return;
    if (action === "revoke-agent" && (mode !== "recover" || !vmId || !agentActive || revoked || !confirmed)) return;
    session.busy = true;
    const generation = ++session.generation;
    const controller = new AbortController();
    session.controller = controller;
    setPending(true); setError(""); setCopied("");
    try {
      if (action === "issue") {
        // Direct typed request + local state only: neither data nor variables enter TanStack.
        if (mode === "connect") {
          const result = await issueOrganizationInstallCode(organizationId, controller.signal);
          if (!session.active || generation !== session.generation) return;
          setCode({ id: result.id, token: result.token, expiresAt: result.expiresAt });
        } else if (vmId) {
          const result = await issueVmEnrollmentToken(organizationId, vmId, controller.signal);
          if (!session.active || generation !== session.generation) return;
          setCode({ id: result.tokenId, token: result.token, expiresAt: result.expiresAt });
        }
      } else if (action === "revoke-code" && code) {
        await revokeOrganizationInstallCode(organizationId, code.id, controller.signal);
        if (!session.active || generation !== session.generation) return;
        setCode(undefined);
      } else if (vmId) {
        await revokeVmAgent(organizationId, vmId, controller.signal);
        if (!session.active || generation !== session.generation) return;
        setRevoked(true); setConfirmed(false);
        // Only ordinary non-secret inventory queries are invalidated.
        void client.invalidateQueries({ queryKey: queryKeys.vm(organizationId, vmId), exact: true });
        void client.invalidateQueries({ queryKey: queryKeys.vms(organizationId), exact: true });
      }
    } catch {
      if (!session.active || generation !== session.generation) return;
      setError("The request could not be completed. Refresh the VM/inventory before retrying; a server action may already have completed.");
    } finally {
      if (session.active && generation === session.generation) {
        session.busy = false; session.controller = undefined; setPending(false);
      }
    }
  }

  async function copy(platform: "Linux" | "Windows", command: string) {
    const session = lifetime.current;
    if (!session.active || session.busy || pending || expired) return;
    const generation = ++session.generation;
    setCopied(""); setError("");
    try {
      await navigator.clipboard.writeText(command);
      if (session.active && generation === session.generation) setCopied(`${platform} command copied.`);
    } catch {
      if (session.active && generation === session.generation) setError("Clipboard access is unavailable. Focus the command, select it and copy manually.");
    }
  }

  const commands = mode === "reinstall" || (code && !expired)
    ? { Linux: buildLinuxAgentCommand(code?.token, mode === "recover"), Windows: buildWindowsAgentCommand(code?.token, mode === "recover") }
    : undefined;
  const title = mode === "connect" ? "Connect VM" : mode === "reinstall" ? "Reinstall using local identity" : "Recover this VM agent";

  return <PixelModal open onClose={close} title={title} description={mode === "connect" ? "Install on the machine; its inventory record appears only after successful registration." : `Target: ${hostname ?? vmId}. This does not create a new VM.`} size="lg" footer={<PixelButton type="button" tone="neutral" variant="ghost" onClick={close}>Close</PixelButton>}>
    <div className="min-w-0 max-h-[calc(100dvh-16rem)] space-y-4 overflow-y-auto" aria-busy={pending}>
      <p className="border-2 border-retro-gold bg-retro-gold/10 p-3 text-sm text-retro-text">Native release {NATIVE_AGENT_BUILD_ID} is UNPUBLISHED. Download availability and installer/UI runtime behavior are UNVERIFIED; these commands are not ready for production use.</p>
      {!allowed ? <p role="status" className="text-sm text-retro-muted">Read-only role. Only organization Admins and Operators can issue codes or recover agents; server permissions remain authoritative.</p> : null}
      {mode === "reinstall" ? <p className="text-sm text-retro-muted">Use only when this machine has a protected native local identity. No new code or enrollment API fetch is needed; packages may still be downloaded. Missing identity or credential-only legacy Alloy residue fails closed: stop the old runtime and use explicit targeted recovery instead.</p> : null}
      {mode === "recover" ? <div className="space-y-3 border-2 border-retro-border p-3">
        <p className="text-sm text-retro-text">Recovery is bound to this VM, not an organization install code. Stop the old runtime first. Explicit --re-enroll / -ReEnroll replaces local credentials; unflagged credential-only Alloy residue or missing identity fails closed. Issuing a replacement can invalidate a previous unused targeted token.</p>
        {agentActive && !revoked ? <>
          <label className="flex items-start gap-2 text-sm text-retro-text"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={!allowed || pending} className="mt-1 focus-visible:outline-2 focus-visible:outline-retro-cyan" />I understand revocation stops the current agent credential. I have stopped the old runtime and authorize recovery of this VM.</label>
          <PixelButton type="button" tone="red" disabled={!allowed || !confirmed || pending} onClick={() => void request("revoke-agent")}>Revoke current agent first</PixelButton>
        </> : <p className="text-sm text-retro-muted">{revoked ? "Current credential revoked. " : "No active agent credential. "}Issue a VM-bound recovery token below; no hidden rotation is performed.</p>}
      </div> : null}
      {!code && mode !== "reinstall" ? <PixelButton type="button" tone="cyan" disabled={!canIssue || pending} onClick={() => void request("issue")}>{pending ? "Working…" : mode === "connect" ? "Generate one-time install code" : "Issue targeted recovery token"}</PixelButton> : null}
      {code ? <div className="space-y-2 border-2 border-retro-border p-3">
        <p className="text-sm text-retro-text">{mode === "connect" ? "Organization install code · One use · Valid up to one hour" : "VM-bound token · One enrollment"} · Expires {formatLocalDateTime(code.expiresAt)} · {getBrowserTimeZone()}</p>
        {expired ? <p role="status" className="text-sm text-retro-gold">Expired. Close and reopen to request another code.</p> : null}
        <p className="text-xs text-retro-muted">Returned for this session only. Closing clears the display, not any copied command, shell history or issued code. An unused copied code stays valid until expiry or explicit revocation; registration consumes it. Do not share it.</p>
        {mode === "connect" ? <PixelButton type="button" tone="red" variant="ghost" disabled={!allowed || pending} onClick={() => void request("revoke-code")}>Revoke this install code</PixelButton> : null}
      </div> : null}
      {commands ? <div className="grid min-w-0 gap-4 md:grid-cols-2">{(["Linux", "Windows"] as const).map((platform) => <div key={platform} className="min-w-0 border-2 border-retro-border bg-retro-canvas/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-retro-text">{platform}{platform === "Windows" ? " · Administrator PowerShell" : " · sudo required"}</h3><PixelButton type="button" tone="cyan" variant="ghost" size="sm" aria-label={`Copy ${platform} ${mode === "recover" ? "recovery" : "install"} command`} disabled={pending || expired} onClick={() => void copy(platform, commands[platform])}>Copy</PixelButton></div>
        <textarea readOnly value={commands[platform]} aria-label={`${platform} agent command (select for manual copy)`} spellCheck={false} className="mt-3 min-h-40 w-full resize-y whitespace-pre-wrap break-all border-2 border-retro-border bg-retro-surface p-3 font-mono text-xs leading-5 text-retro-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-retro-cyan" onFocus={(event) => event.currentTarget.select()} />
      </div>)}</div> : null}
      {commands ? <p className="text-xs text-retro-muted">The initial command/assignment may remain in clipboard, shell history and process environment; Linux sudo env assignment may also expose the ENR code in initial argv. Cleanup is best effort, not secure erasure. The native installer passes existing AGT credentials only through bounded stdin, never native/service argv. ENR is not sent over the pipe stdin used for the downloaded Linux script.</p> : null}
      <p role="status" aria-live="polite" className="text-sm text-retro-muted">{pending ? "Request in progress…" : copied}</p>
      {error ? <p role="alert" className="text-sm text-retro-red">{error}</p> : null}
    </div>
  </PixelModal>;
}
