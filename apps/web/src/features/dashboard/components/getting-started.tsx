import { PixelBadge, PixelCard } from "@pxlkit/ui-kit";
import { PxlKitIcon } from "../../../components/ui/pxlkit-icon";
import type { GettingStartedItem } from "../../../types/domain";

export function GettingStarted({ items }: { items: GettingStartedItem[] }) {
  return (
    <PixelCard
      title="Getting started"
      className="shadow-[4px_4px_0_var(--cloudops-shadow)] [&_header]:border-b-2 [&_header]:border-retro-border"
    >
      <div className="grid gap-[0.625rem]">
        {items.map((item) => (
          <div
            className="grid min-h-10 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3"
            key={item.id}
          >
            {item.completed ? (
              <span
                className="inline-flex items-center justify-center text-[var(--cloudops-accent)]"
                role="img"
                aria-label="Completed"
              >
                <PxlKitIcon name="check-circle" size={18} />
              </span>
            ) : (
              <span
                className="inline-flex items-center justify-center text-[var(--cloudops-accent)]"
                aria-hidden="true"
              >
                <PxlKitIcon name="circle" size={18} />
              </span>
            )}
            <span
              className={`min-w-0 [overflow-wrap:anywhere]${
                item.comingSoon ? " text-retro-muted" : ""
              }`}
            >
              {item.label}
            </span>
            {item.comingSoon ? (
              <PixelBadge tone="neutral" variant="soft">
                Coming soon
              </PixelBadge>
            ) : null}
          </div>
        ))}
      </div>
    </PixelCard>
  );
}
