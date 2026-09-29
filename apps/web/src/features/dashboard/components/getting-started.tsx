import { PixelBadge, PixelCard } from "@pxlkit/ui-kit";
import { AppIcon } from "../../../components/ui/app-icon";
import type { GettingStartedItem } from "../../../types/domain";

export function GettingStarted({ items }: { items: GettingStartedItem[] }) {
  return (
    <PixelCard title="Getting started">
      <div className="getting-started-list">
        {items.map((item) => (
          <div
            className={`getting-started-item${
              item.comingSoon ? " getting-started-item-coming-soon" : ""
            }`}
            key={item.id}
          >
            {item.completed ? (
              <span className="getting-started-icon" role="img" aria-label="Completed">
                <AppIcon name="check-circle" size={18} />
              </span>
            ) : (
              <span className="getting-started-icon" aria-hidden="true">
                <AppIcon name="circle" size={18} />
              </span>
            )}
            <span className="getting-started-label">{item.label}</span>
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
