import { useId, useRef, useState, type JSX } from "react";
import { PixelButton, PixelTextarea } from "@pxlkit/ui-kit";
import { validateAlertComment } from "../lib/alert-utils";
export function AlertCommentForm({ onSubmit, pending, error, outcomeUncertain, disabled = false }: { disabled?: boolean; onSubmit(input: { message: string }): Promise<void>; pending: boolean; error: string | null; outcomeUncertain: boolean }): JSX.Element {
  const id = useId(); const [draft, setDraft] = useState(""); const [invalid, setInvalid] = useState<string | null>(null); const inFlight = useRef(false); const message = invalid ?? error;
  return <form className="space-y-3" aria-label="Add alert comment" aria-busy={pending} onSubmit={async (event) => {
    event.preventDefault(); if (inFlight.current || pending || outcomeUncertain || disabled) return;
    const input = validateAlertComment(draft); if ('error' in input) { setInvalid(input.error); return; }
    inFlight.current = true; setInvalid(null);
    try { await onSubmit(input); setDraft(""); } catch { /* Parent renders safe mutation error; retain draft. */ } finally { inFlight.current = false; }
  }}>
    <PixelTextarea id={`${id}-comment`} label="Comment" value={draft} onChange={(event) => { setDraft(event.target.value); setInvalid(null); }} rows={3} disabled={pending || disabled} aria-invalid={Boolean(message)} aria-describedby={`${id}-hint${message ? ` ${id}-error` : ''}`} />
    <p id={`${id}-hint`} className="text-xs text-retro-muted">Up to 4,000 Unicode characters and 16 KiB. Comments are append-only.</p>
    {message ? <p id={`${id}-error`} role="alert" className="text-sm">{message}</p> : null}
    {outcomeUncertain ? <p className="text-sm text-retro-muted">Your comment may have been saved. Refresh history and check before manually trying again.</p> : null}
    <PixelButton type="submit" size="sm" loading={pending} disabled={pending || outcomeUncertain || disabled} aria-busy={pending}>Add comment</PixelButton>
  </form>;
}
