# CloudOps Phase 1 Dashboard Design

## Context

The web application is a minimal React 19 + Vite + TypeScript frontend in `apps/web`. PxlKit `@pxlkit/ui-kit@2.1.1` is already installed and its styles are imported from `src/index.css`. The current entry point is the Vite starter screen in `src/App.tsx`; there is no router, application shell, mock domain data, or feature-first structure yet.

## Goals

- Deliver a working `/dashboard` route for Phase 1: Identity, Organization, and RBAC.
- Establish a reusable desktop application shell with a fixed sidebar and header.
- Keep organization context in simple frontend mock state so switching organizations updates the visible context.
- Use PxlKit as the primary UI system, with Tailwind utilities and focused CSS tokens for layout and SaaS styling.
- Support light and dark modes, persisted in local storage and initialized from the system preference when no choice exists.
- Keep dashboard-only components under `features/dashboard` and shell components under `components/shell`.
- Make the navigation configuration easy to extend for future infrastructure, observability, operations, automation, and AIOps sections without rendering those sections in Phase 1.

## Non-goals

- No backend calls, authentication provider, Cognito integration, Redux store, or real RBAC enforcement.
- No VM monitoring, metrics, logs, traces, alerts, incidents, integrations, Kubernetes, runbooks, or AIOps screens.
- No automated test suite or smoke-test files for this UI task.
- No implementation of future `/org/:orgSlug/...` routes; the route structure only remains compatible with adding them later.

## Chosen approach

Use React Router rather than a pathname switch. Add `react-router-dom` to the web app and create a browser router in `src/app/router/router.tsx` with `/` redirecting to `/dashboard` and `/dashboard` rendering the application layout and dashboard page. This adds a small dependency, but gives the shell an explicit route boundary and leaves a clean path for future organization-scoped routes.

Use PxlKit's `PixelSidebar`, `PixelDropdown`, `PixelButton`/`PixelIconButton`, `PixelAvatar`, `PixelBadge`, `PixelBreadcrumb`, `PixelCard`, `PixelStatCard`, and `PixelDataTable` where their APIs fit. Wrap the app with `PxlKitSurfaceProvider surface="linear"` so the product keeps PxlKit's design tokens while avoiding an overly pixel-art presentation.

## Architecture

```text
apps/web/src/
├── app/
│   ├── layouts/
│   │   └── app-layout.tsx
│   ├── providers/
│   │   └── app-providers.tsx
│   ├── router/
│   │   └── router.tsx
│   └── navigation/
│       ├── navigation.config.ts
│       └── navigation.types.ts
├── components/
│   ├── ui/
│   └── shell/
│       ├── app-sidebar.tsx
│       ├── app-header.tsx
│       ├── tenant-switcher.tsx
│       ├── theme-toggle.tsx
│       └── user-menu.tsx
├── features/
│   └── dashboard/
│       ├── components/
│       │   ├── dashboard-welcome.tsx
│       │   ├── dashboard-summary.tsx
│       │   ├── organization-overview.tsx
│       │   ├── recent-members.tsx
│       │   └── getting-started.tsx
│       └── pages/
│           └── dashboard-page.tsx
├── mocks/
│   ├── organizations.ts
│   ├── members.ts
│   └── current-user.ts
├── types/
│   └── domain.ts
├── App.tsx
├── index.css
└── main.tsx
```

Only files needed by Phase 1 will be created. Empty future folders and unused placeholder layouts will not be added.

### Providers and tenant state

`AppProviders` will compose the PxlKit surface provider, the theme behavior, and a small tenant context. The tenant context owns the selected organization, initializes to `VNPT Cloud`, and exposes the organization list plus a setter. It is intentionally local React context rather than a global state library. Components read it through a small hook so the sidebar, header, and dashboard remain synchronized.

### Routing

`router.tsx` will use `createBrowserRouter` and `RouterProvider`. The route tree will contain:

- `/` → `<Navigate to="/dashboard" replace />`
- `/dashboard` → `<AppLayout />` with `<DashboardPage />` as its outlet
- a catch-all route that redirects to `/dashboard`

The layout owns the shell and renders the active route through `Outlet`. Future organization-scoped routes can be added as nested routes without moving shell code.

### Navigation configuration

`navigation.types.ts` will define typed navigation items and sections with `id`, `label`, `href`, optional icon metadata, and an optional `disabled` state. `navigation.config.ts` will export only the Phase 1 sections:

- Dashboard
- Manage: Members, Organization, Settings

The sidebar maps this configuration to `PixelSidebar`. It will not hard-code individual menu rows in JSX. Future groups can be appended to the configuration when their routes are implemented.

### Shell components

- `AppSidebar` renders the CloudOps brand, `TenantSwitcher`, configured navigation, and current user footer. It uses PxlKit's collapsible sidebar and stays fixed on desktop.
- `TenantSwitcher` uses `PixelDropdown` with a header, selected check state, both mock organizations, a separator, and an Organization settings item. Selecting an organization updates tenant context.
- `AppHeader` renders the current page breadcrumb/title on the left and search, notifications, theme, and user actions on the right. Search and notification controls are presentational Phase 1 controls with accessible labels; they do not call an API.
- `ThemeToggle` uses PxlKit's `useDarkMode` hook. It stores the mode through PxlKit's local-storage integration, honors `prefers-color-scheme` when mode is `system`, and updates the document theme classes.
- `UserMenu` uses `PixelDropdown` and current-user mock data for the avatar, name, email, and role.

On narrow screens, the shell keeps the header visible and allows the sidebar to collapse; content switches to a single-column layout with responsive spacing. Desktop content uses a fixed sidebar column and a scrollable main column.

## Dashboard design

`DashboardPage` reads the selected organization, current user, and members from mock data and composes these focused components:

1. `DashboardWelcome` — “Good morning, Admin” and the selected organization context.
2. `DashboardSummary` — four PxlKit stat cards for Organization, Members, Your Role, and Environment.
3. `OrganizationOverview` — organization name, slug, plan, and created date in a PxlKit card.
4. `RecentMembers` — typed PxlKit data table with name, email, role, and status columns. Role and status use PxlKit badges.
5. `GettingStarted` — checklist card with completed and pending items. “Add first monitored VM” is visibly marked as coming soon and has no action.

Organization-specific members are selected from mock data by organization id. Switching to `Cloud Lab` therefore changes the displayed organization and member context without any backend dependency.

## Mock data and types

`types/domain.ts` will contain the shared `Organization`, `Member`, `CurrentUser`, and role/status unions. The three files in `src/mocks` will export typed constants only:

- `organizations.ts`: `org_001` VNPT Cloud / ADMIN and `org_002` Cloud Lab / OPERATOR.
- `members.ts`: member rows keyed by organization id, including the requested VNPT Cloud examples.
- `current-user.ts`: Admin User, `admin@example.com`, role `ADMIN`.

No component will contain hard-coded domain records.

## Styling and theme

Replace the Vite starter styles with CloudOps tokens layered on the existing PxlKit stylesheet. Use neutral slate surfaces, a cyan/blue observability accent, subtle borders, and restrained shadows. Add light and dark token sets under the document's `.light` and `.dark` classes. Tailwind will handle grid, flex, spacing, and responsive utilities; CSS will own application-level tokens and shell dimensions.

The root will fill the viewport rather than using the starter's fixed 1126px centered frame. The main content will use a readable max-width inside the scrollable area while preserving desktop density.

## Accessibility and interaction boundaries

- Every icon-only control will have an accessible label or tooltip.
- Navigation uses the active route state and semantic navigation landmarks.
- Dropdown selection is keyboard accessible through PxlKit.
- Status text is not conveyed by color alone.
- Disabled/future navigation is not rendered as an active destination.
- Search, notification, and “coming soon” controls do not pretend to perform unavailable backend actions.

## Verification boundary

No test files will be added. After implementation, run the existing web build command to catch TypeScript and bundling errors, then verify that the app can open `/dashboard` in the existing Vite-backed GUI. This is a build/availability check, not a new smoke-test suite.
