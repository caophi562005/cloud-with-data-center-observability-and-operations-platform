import type { JSX } from "react";
import { PixelIconFrame } from "@pxlkit/ui-kit";
import { AppIcon } from "../../../components/ui/app-icon";

export function AuthBrandPanel(): JSX.Element {
  return (
    <section className="auth-brand-panel" aria-labelledby="auth-brand-title">
      <div className="auth-brand-panel-grid" aria-hidden="true" />
      <div className="auth-brand-panel-content">
        <div className="auth-brand-panel-icon" aria-hidden="true">
          <PixelIconFrame
            icon={<AppIcon name="cloud" size={32} />}
            tone="cyan"
            shape="square"
          />
        </div>
        <div className="auth-brand-panel-copy">
          <h1 id="auth-brand-title">OpsGrid</h1>
          <p>Cloud &amp; Data Center Observability Platform</p>
          <ul aria-label="OpsGrid capabilities">
            <li>Monitor infrastructure.</li>
            <li>Detect incidents.</li>
            <li>Operate with confidence.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
