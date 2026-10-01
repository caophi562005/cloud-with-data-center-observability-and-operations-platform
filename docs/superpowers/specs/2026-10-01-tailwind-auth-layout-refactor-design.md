# Tailwind v4 Styling Refactor and Auth Layout Design

## Context

The React frontend lives in `apps/web` and already uses Tailwind CSS v4 through `@tailwindcss/vite`. PxlKit styles are imported from `src/index.css`. The current implementation mixes global tokens, app-shell styling, dashboard styling, and component layout rules in `src/index.css`. Auth layout and responsive rules are concentrated in `src/features/auth/auth.css`.

The working tree contains an existing user change in `apps/web/src/features/auth/auth.css` that changes the desktop grid to `minmax(20rem, 40vw) minmax(28rem, 1fr)`, plus unrelated API/Makefile changes. Those existing changes are outside this refactor and must remain untouched. No staging or commit is part of this task.

## Goals

- Make `apps/web/src/index.css` contain only global concerns:
  - Tailwind and PxlKit imports;
  - Tailwind source declaration;
  - `@font-face`;
  - light/dark theme boundaries and design-token variables;
  - minimal global document reset and body defaults.
- Delete `apps/web/src/features/auth/auth.css` completely.
- Move all shell, dashboard, and auth layout/component styling into Tailwind utility classes in JSX.
- Keep the current OpsGrid visual language, PxlKit behavior, theme behavior, text, authentication flow, React Query logic, API calls, and Cognito logic unchanged.
- Fix Login/Register sizing and scrolling at desktop and mobile breakpoints.
- Remove CSS rules and class names that become unused after migration.
- Pass the existing web build and lint commands.

## Non-goals

- No business-logic refactor.
- No authentication-flow, API, Cognito, router, or React Query changes.
- No new UI redesign, palette change, typography redesign, or PxlKit replacement.
- No new styling abstraction or component library.
- No changes to unrelated working-tree files.
- No git staging, commit, merge, or reset.

## Existing CSS inventory

### Keep in `src/index.css`

The following existing concerns remain, subject to cleanup only where necessary:

- `@import "tailwindcss"` and `@import "@pxlkit/ui-kit/styles.css"`.
- `@source "../node_modules/@pxlkit/ui-kit"`.
- The registered pixel font.
- `:root`, `.light`, and `.dark` token declarations, including `--cloudops-*`, `--retro-*`, and `--color-retro-*` variables used by Tailwind utilities and PxlKit.
- Global `html`, `body`, and `#root` sizing/background defaults.
- Minimal box-sizing, form-font inheritance, heading/paragraph margin reset, and body typography defaults.

### Migrate out of `src/index.css`

All rules beginning with `.cloudops-shell` and continuing through the dashboard and shell responsive rules are component-specific and will be represented in JSX with Tailwind utilities. This includes shell grid sizing, collapsed-sidebar columns, sidebar/header geometry, main-column overflow, main-content sizing, dashboard grids, dashboard state/card presentation, organization overview, checklist, member table, and tenant/user copy layout.

### Delete from `src/features/auth/auth.css`

The file will be deleted. Its layout, spacing, colors, typography, responsive behavior, and sizing will be represented in JSX utility classes. No replacement CSS file will be introduced.

The former SVG grid background will be expressed with a Tailwind arbitrary `background-image` utility so its visual appearance remains available without a stylesheet rule. The former capability-list pseudo-element will be replaced by an explicit decorative `<span aria-hidden="true">` in JSX and styled with Tailwind utilities. This removes the last component-specific CSS dependency.

## Chosen approach

Use a Tailwind-first migration with no new styling abstraction. Static and arbitrary Tailwind utilities will be colocated with the elements they style. Existing CSS variables remain the source of theme values, while utilities reference them through arbitrary values or the registered `text-retro-*`/related color utilities.

Complex values that are still visual but expressible as a Tailwind arbitrary value—such as the SVG grid image, exact grid templates, custom shadows, and text shadows—will use arbitrary utilities rather than CSS selectors. This preserves the visual result while keeping all component styling in JSX.

The `auth-layout-grid` `display: contents` wrapper is unnecessary after migration and will be removed. `AuthLayout` will render its tools and its two panel children directly under the grid container.

## Auth layout design

### Shared desktop columns

`AuthLayout` will use one shared grid for both Login and Register:

```text
minmax(20rem, 40vw) minmax(28rem, 1fr)
```

The layout switches to one column with `max-[901px]:grid-cols-1`. The `901px` integer threshold intentionally makes the Tailwind v4 max variant include the exact `900px` viewport; do not replace it with `max-[900px]`, which is strict at the boundary. Because both pages render the same `AuthBrandPanel` and form panel positions inside this shared grid, the left panel width is identical at any given desktop viewport.

The main layout keeps `min-h-screen`, `overflow-x-hidden`, the existing page background token, and the existing text token. The theme toggle remains absolutely positioned above the layout with Tailwind top/right spacing utilities.

### Brand panel

The brand panel keeps the existing surface, right border, centered content, content width, icon, title, copy, and capability list. Its desktop minimum height remains viewport-sized. Vertical padding is converted to fixed responsive values rather than a `vw`-dependent block padding. Horizontal spacing may use a Tailwind arbitrary clamp value where that best preserves the current visual density.

At `max-[901px]`:

- the minimum height becomes content-sized;
- the right border becomes a bottom border;
- the grid background is hidden;
- content switches to the existing two-column mobile arrangement.

At `max-[640px]`, the brand panel returns to a single content column, keeps the theme-toggle clearance at the top, and remains full width.

The capability list keeps its text and spacing. Each item receives an explicit decorative square span so no pseudo-element stylesheet rule is required.

### Form panel and scrolling

Both `LoginForm` and both render modes of `RegisterForm` will use the same form-panel utility pattern:

- `min-w-0` and `min-h-0` so the grid item can participate in a bounded viewport row;
- flex alignment that centers the card when there is available vertical space;
- `overflow-y-auto` on desktop so a genuinely oversized form scrolls within its panel instead of being clipped;
- fixed responsive vertical padding (`py-*`) with no `vw`-dependent vertical value;
- horizontal padding that preserves the current density through responsive utilities/arbitrary values;
- the PixelCard receives an auto vertical margin and keeps `w-full max-w-md`.

The auto-margin behavior centers a card when it fits and naturally removes excess centering space when the card is taller than the panel. This avoids the current false overflow caused by `padding: clamp(1rem, 5vw, 5rem)` while still allowing the Register form and confirmation form to scroll when their actual content is taller than the viewport.

At `max-[901px]`, the form panel's internal overflow is disabled so the one-column document can scroll naturally across the brand and form sections. At `max-[640px]`, the form and its buttons remain full width as they are today.

No form event handlers, validation, mutation calls, navigation calls, labels, descriptions, or text are changed.

## App shell and dashboard styling design

`AppLayout` will own the shell grid utilities, including the collapsed-sidebar column state, page minimum height, and mobile one-column override. The main column will own its flex direction, width constraints, horizontal overflow policy, vertical scroll behavior, and mobile reset. The main content element will own its max width, centering, flex growth, and responsive padding.

`AppHeader` will retain its existing Tailwind classes and receive the surface, border, and shadow utilities that were previously supplied by the global selector. Sidebar geometry will be expressed through the PxlKit root/component class or an equivalent layout wrapper without changing the sidebar's props, navigation, collapse behavior, or content.

Dashboard components will replace their semantic CSS class styling with colocated utilities:

- `DashboardPage`: page stack, state card, state title/copy, primary grid.
- `DashboardWelcome`: grid gap, title typography/effects, muted copy.
- `DashboardSummary`: summary grid and card shadow treatment; remove the unused wrapper class if no styling remains.
- `OrganizationOverview`: definition-list grid and term/value typography.
- `GettingStarted`: list/item grid, icon alignment, label overflow, and coming-soon muted state.
- `RecentMembers`: section sizing, horizontal table overflow, member-cell layout, and empty-state copy.
- `TenantSwitcher` and `UserMenu`: copy stack, truncation, and muted role text.

Responsive behavior currently represented by `@media (max-width: 1200px)`, `@media (max-width: 900px)`, and `@media (max-width: 640px)` will be converted to Tailwind responsive or arbitrary max-width variants. No custom media-query stylesheet will remain.

## Theme and global reset

The light/dark token values and the Tailwind color registrations remain unchanged. Utilities continue to resolve through the same `--cloudops-*`, `--retro-*`, and `--color-retro-*` variables, so the theme toggle and PxlKit surfaces continue to share the existing theme boundary.

Only document-level defaults remain in `index.css`. No shell, dashboard, auth, or feature selector will remain there after the refactor.

## Files in scope

Expected modified files:

- `apps/web/src/index.css`
- `apps/web/src/app/layouts/auth-layout.tsx`
- `apps/web/src/app/layouts/app-layout.tsx`
- `apps/web/src/components/shell/app-header.tsx`
- `apps/web/src/components/shell/app-sidebar.tsx` if required to apply root layout utilities
- `apps/web/src/components/shell/tenant-switcher.tsx`
- `apps/web/src/components/shell/user-menu.tsx`
- `apps/web/src/features/auth/components/auth-brand-panel.tsx`
- `apps/web/src/features/auth/components/login-form.tsx`
- `apps/web/src/features/auth/components/register-form.tsx`
- dashboard JSX files that currently consume selectors from `index.css`

Expected deleted file:

- `apps/web/src/features/auth/auth.css`

`login-page.tsx`, `register-page.tsx`, authentication hooks/API/schema/types, providers, router, and all files outside the styling scope remain behaviorally unchanged unless a class-only edit is needed.

## Verification plan

1. Search the source tree for every former component class and confirm each is either removed from JSX or intentionally retained only as an unstyled semantic class.
2. Confirm `auth.css` has no import and no file remains.
3. Confirm `index.css` contains no shell, dashboard, auth, or component selector.
4. Run `pnpm --dir apps/web run build`.
5. Run `pnpm --dir apps/web run lint`.
6. Open `/login` and `/register` in the existing GUI and measure:
   - `document.documentElement.clientHeight`;
   - `document.documentElement.scrollHeight`;
   - auth-layout, brand-panel, form-panel, and PixelCard bounding rectangles;
   - left-panel widths across both routes.
7. Verify at `1440x900`, `1440x700`, `1024x768`, the exact `900px` breakpoint, `640px`, and `375px`:
   - Login has no vertical scrollbar when its content fits;
   - Register has no padding-induced scrollbar;
   - Register scrolls only when its content actually exceeds available height;
   - desktop brand widths match between Login and Register;
   - mobile is one column and full width;
   - light/dark themes and PxlKit rendering remain correct.
8. Review the final diff to ensure unrelated API/Makefile working-tree changes are untouched and no git staging or commit occurs.

## Acceptance criteria

- `index.css` contains only approved global concerns.
- `auth.css` is deleted and no import references it.
- All component-specific layout styling is expressed through Tailwind classes in JSX.
- Login and Register share the same desktop left-panel width at the same viewport.
- No false vertical scrollbar is caused by viewport-width-dependent vertical padding.
- Tall Register content can scroll without being cut off.
- Mobile behavior at and below 900px remains one column and full width.
- Theme light/dark behavior and PxlKit rendering are preserved.
- Web build and lint pass.
- Unrelated working-tree changes remain untouched.
