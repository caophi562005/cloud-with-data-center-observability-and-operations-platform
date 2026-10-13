import { useEffect, useState } from "react";
import { PixelButton } from "@pxlkit/ui-kit";
import { formatLocalDateTime } from "../../../lib/date-time";

export function RelativeTime({ value }: { value: string | null | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!value || !Number.isFinite(Date.parse(value))) return <span>Not reported</span>;
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  const label = seconds < 60 ? "Just now" : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`;
  return <time dateTime={value} title={formatLocalDateTime(value)}>{label}</time>;
}

/** Only public identifiers/hashes may be passed here; never credentials. */
export function PublicValue({ label, value }: { label: string; value: string | null | undefined }) {
  const [feedback, setFeedback] = useState("");
  async function copy() {
    if (!value) return;
    try { await navigator.clipboard.writeText(value); setFeedback(`${label} copied`); }
    catch { setFeedback(`Unable to copy ${label}. Select the text to copy it manually.`); }
  }
  return <div className="min-w-0">
    <dt className="text-sm text-retro-muted">{label}</dt>
    <dd className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
      <span className="break-all font-mono text-sm text-retro-text">{value ?? "Not reported"}</span>
      {value ? <PixelButton type="button" size="sm" tone="neutral" variant="ghost" aria-label={`Copy ${label}`} onClick={() => void copy()}>Copy</PixelButton> : null}
      <p role="status" aria-live="polite" className="w-full text-xs text-retro-muted">{feedback}</p>
    </dd>
  </div>;
}
