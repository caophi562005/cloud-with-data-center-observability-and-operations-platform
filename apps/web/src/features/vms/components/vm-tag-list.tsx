import { PixelBadge } from "@pxlkit/ui-kit";
import { tagToString, visibleTags } from "../lib/vm-utils";

export function VmTagList({ tags, limit = 2 }: { tags: Record<string, string>; limit?: number }) {
  const { visible, hiddenCount } = visibleTags(tags, limit);

  if (visible.length === 0) {
    return <span className="text-xs text-retro-muted">Untagged</span>;
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {visible.map((tag) => (
        <PixelBadge key={tag} tone="neutral" variant="outline" size="sm">
          {tag}
        </PixelBadge>
      ))}
      {hiddenCount > 0 ? (
        <span className="text-xs font-semibold text-retro-muted" aria-label={`${hiddenCount} more tags`}>
          +{hiddenCount}
        </span>
      ) : null}
    </div>
  );
}

export function VmFullTagList({ tags }: { tags: Record<string, string> }) {
  const entries = Object.entries(tags);
  if (entries.length === 0) return <p className="text-sm text-retro-muted">No tags assigned.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([key, value]) => (
        <PixelBadge key={tagToString(key, value)} tone="cyan" variant="soft" size="sm">
          {tagToString(key, value)}
        </PixelBadge>
      ))}
    </div>
  );
}
