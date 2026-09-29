# CloudOps Phase 1 Dashboard Implementation Plan

> **面向 Agent 执行者：** 必需子技能：使用 superpower-subagent-driven-development（推荐）或 superpower-executing-plans 按任务逐项执行本计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 将 `apps/web` 的 Vite starter 替换为可访问的 React Router application shell，并交付可用的 `/dashboard` Identity/Organization/RBAC mock dashboard。

**架构：** 使用 `react-router-dom` 的 browser router，`AppLayout` 作为带 `Outlet` 的共享 shell，React Context 在 `AppProviders` 中管理当前 organization 和 theme。所有 domain data 放在 `src/mocks`，导航由配置驱动，PxlKit 负责 sidebar、dropdown、card、stat、avatar、badge、breadcrumb 和 data table。

**技术栈：** React 19、TypeScript strict、Vite 8、React Router、PxlKit UI Kit 2.1.1、Tailwind CSS 4。

**规格：** [2026-09-30-cloudops-dashboard-design.md](docs/superpowers/specs/2026-09-30-cloudops-dashboard-design.md)

## 全局约束

- 只修改 `apps/web` 前端和本任务的设计/计划文档；不调用 backend。
- 使用 `@pxlkit/ui-kit@2.1.1` 作为主要 UI kit，不引入 shadcn、MUI、Ant Design 或其他 UI kit。
- 所有 organization、member、current-user、getting-started mock data 必须来自 `apps/web/src/mocks`。
- TypeScript 使用 strict/bundler 配置；组件使用 functional React components。
- 不使用 Redux，不实现真实 Cognito/authentication/RBAC enforcement。
- 只实现 `/dashboard`；未来 infrastructure、observability、operations、automation、AIOps 页面不渲染。
- Theme 必须支持 light/dark，首次无存储选择时跟随 `prefers-color-scheme`，用户选择必须持久化。
- 不新增 automated test 文件或 smoke-test 文件；以 TypeScript/Vite build 和现有 GUI 页面检查作为验证边界。
- 不留下未使用的 Vite starter UI、未使用组件或未引用的 domain record。

## 文件与职责总览

- 修改 `apps/web/package.json` 与 `apps/web/pnpm-lock.yaml`：加入 React Router 依赖。
- 修改 `apps/web/src/App.tsx`：只负责组合 `AppProviders` 与 `AppRouter`。
- 保留 `apps/web/src/main.tsx` 的 StrictMode bootstrap。
- 新建 `apps/web/src/types/domain.ts`：共享 domain unions/interfaces。
- 新建 `apps/web/src/mocks/organizations.ts`、`members.ts`、`current-user.ts`、`getting-started.ts`：只导出 typed constants。
- 新建 `apps/web/src/app/providers/app-providers.tsx`：PxlKit surface、theme context、tenant context。
- 新建 `apps/web/src/app/router/router.tsx`：browser router 与 `/dashboard` route tree。
- 新建 `apps/web/src/app/layouts/app-layout.tsx`：sidebar/header/outlet shell。
- 新建 `apps/web/src/app/navigation/navigation.types.ts` 与 `navigation.config.ts`：类型化导航配置。
- 新建 `apps/web/src/components/ui/app-icon.tsx`：无外部依赖的少量 SVG icon primitive。
- 新建 `apps/web/src/components/shell/app-sidebar.tsx`、`app-header.tsx`、`tenant-switcher.tsx`、`theme-toggle.tsx`、`user-menu.tsx`：全局 shell UI。
- 新建 `apps/web/src/features/dashboard/components/dashboard-welcome.tsx`、`dashboard-summary.tsx`、`organization-overview.tsx`、`recent-members.tsx`、`getting-started.tsx` 与 `pages/dashboard-page.tsx`：dashboard-only UI。
- 修改 `apps/web/src/index.css`：移除 Vite starter frame，加入 CloudOps tokens、responsive shell 和 light/dark rules。
- 修改 `apps/web/index.html`：将 document title 改为 `CloudOps`。
- 删除 `apps/web/src/App.css`：移除不再使用的 Vite starter styles。

---

### 任务 1：建立 domain types、mock data 与 providers

**文件：**
- 新建：`apps/web/src/types/domain.ts`
- 新建：`apps/web/src/mocks/organizations.ts`
- 新建：`apps/web/src/mocks/members.ts`
- 新建：`apps/web/src/mocks/current-user.ts`
- 新建：`apps/web/src/mocks/getting-started.ts`
- 新建：`apps/web/src/app/providers/app-providers.tsx`
- 修改：`apps/web/package.json`
- 修改：`apps/web/pnpm-lock.yaml`

**接口：**
- `Role = 'ADMIN' | 'OPERATOR' | 'VIEWER'`
- `MemberStatus = 'ACTIVE' | 'INVITED'`
- `Organization = { id, name, slug, role, plan, environment, createdAt }`
- `Member = { id, organizationId, name, email, role, status }`
- `CurrentUser = { id, name, email, role }`
- `GettingStartedItem = { id, label, completed, comingSoon? }`
- `useTenant(): { organizations: Organization[]; currentOrganization: Organization; selectOrganization: (organizationId: string) => void }`
- `useTheme(): { resolved: 'light' | 'dark'; toggle: () => void }`

- [ ] **Bước 1: Khai báo các type dùng chung**

Tạo `domain.ts` với các unions/interfaces sau:

```ts
export type Role = 'ADMIN' | 'OPERATOR' | 'VIEWER';
export type MemberStatus = 'ACTIVE' | 'INVITED';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: Role;
  plan: string;
  environment: string;
  createdAt: string;
}

export interface Member {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: Role;
  status: MemberStatus;
}

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface GettingStartedItem {
  id: string;
  label: string;
  completed: boolean;
  comingSoon?: boolean;
}
```

- [ ] **Bước 2: Tạo organization, user, checklist mock constants**

`organizations.ts` export `organizations` với đúng hai object sau:

```ts
{
  id: 'org_001', name: 'VNPT Cloud', slug: 'vnpt-cloud', role: 'ADMIN',
  plan: 'Development', environment: 'Development', createdAt: 'Sep 2026'
}
{
  id: 'org_002', name: 'Cloud Lab', slug: 'cloud-lab', role: 'OPERATOR',
  plan: 'Development', environment: 'Staging', createdAt: 'Aug 2026'
}
```

`current-user.ts` export `currentUser` với id `user_001`, name `Admin User`, email `admin@example.com`, role `ADMIN`.

`getting-started.ts` export `gettingStartedItems` theo đúng thứ tự: `Organization created` completed; `Administrator account configured` completed; `Authentication configured` completed; `Invite team members` incomplete; `Add first monitored VM` incomplete với `comingSoon: true`.

- [ ] **Bước 3: Tạo member mock rows theo organization**

`members.ts` export `membersByOrganization: Record<string, Member[]>`. `org_001` có 12 members để summary hiển thị `12`; ba dòng đầu tiên phải đúng:

```text
John Nguyen / john@example.com / ADMIN / ACTIVE
Jane Tran   / jane@example.com / OPERATOR / ACTIVE
Tom Le      / tom@example.com / VIEWER / ACTIVE
```

Chín dòng còn lại của `org_001` dùng các tên `Alex Pham`, `Minh Ho`, `Linh Vo`, `Quang Bui`, `An Nguyen`, `Huy Dang`, `Mai Phan`, `Bao Tran`, `Kim Do`, đều có email `@example.com`, status `ACTIVE`, và role hợp lệ. `org_002` có bốn active members để tenant switching cũng có data hiển thị.

- [ ] **Bước 4: Implement theme và tenant contexts**

Trong `app-providers.tsx`, dùng PxlKit `useDarkMode()` trong một `ThemeProvider` nội bộ. `toggle()` gọi `setMode(resolved === 'dark' ? 'light' : 'dark')`; PxlKit hook tự quản lý localStorage key `pxlkit:dark-mode`, áp dụng `.light`/`.dark`, và theo dõi system preference ở mode `system`.

`TenantProvider` khởi tạo `currentOrganization` bằng `organizations[0]`; `selectOrganization` tìm theo id và bỏ qua id không tồn tại. Export `useTenant` và `useTheme`, đồng thời throw một Error rõ ràng nếu hook được gọi ngoài provider.

Composition cuối cùng:

```tsx
export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <PxlKitSurfaceProvider surface="linear">
      <ThemeProvider>
        <TenantProvider>{children}</TenantProvider>
      </ThemeProvider>
    </PxlKitSurfaceProvider>
  );
}
```

- [ ] **Bước 5: Cài React Router dependency**

Chạy từ workspace root:

```bash
pnpm --dir apps/web add react-router-dom
```

Xác nhận `apps/web/package.json` có dependency và `apps/web/pnpm-lock.yaml` đã được cập nhật.

- [ ] **Bước 6: Commit provider/data foundation**

```bash
git add apps/web/package.json apps/web/pnpm-lock.yaml apps/web/src/types/domain.ts apps/web/src/mocks apps/web/src/app/providers/app-providers.tsx
git commit -m "feat: add CloudOps dashboard mock foundation"
```

---

### 任务 2：建立 typed navigation config 与 icon primitive

**文件：**
- 新建：`apps/web/src/app/navigation/navigation.types.ts`
- 新建：`apps/web/src/app/navigation/navigation.config.ts`
- 新建：`apps/web/src/components/ui/app-icon.tsx`

**接口：**
- `IconName`：有限的 CloudOps icon name union。
- `NavigationItem = { id: string; label: string; href: string; icon: IconName; disabled?: boolean }`
- `NavigationSection = { id: string; label?: string; items: NavigationItem[] }`
- `navigationSections: NavigationSection[]`
- `AppIcon({ name, size? }: { name: IconName; size?: number })`

- [ ] **Bước 1: Khai báo navigation types và Phase 1 config**

`navigation.config.ts` chỉ export hai Phase 1 sections:

```ts
export const navigationSections: NavigationSection[] = [
  {
    id: 'overview',
    items: [
      { id: 'dashboard', label: 'Dashboard', href: '/dashboard', icon: 'dashboard' },
    ],
  },
  {
    id: 'manage',
    label: 'Manage',
    items: [
      { id: 'members', label: 'Members', href: '/members', icon: 'users' },
      { id: 'organization', label: 'Organization', href: '/organization', icon: 'organization' },
      { id: 'settings', label: 'Settings', href: '/settings', icon: 'settings' },
    ],
  },
];
```

The three Manage destinations remain visible navigation entries; only `/dashboard` is implemented and the router catch-all returns users to `/dashboard` for the other paths.

- [ ] **Bước 2: Implement the small inline SVG icon map**

`app-icon.tsx` supports `cloud`, `dashboard`, `users`, `organization`, `settings`, `search`, `bell`, `sun`, `moon`, `chevron-down`, `check`, `check-circle`, `circle`, `user`, and `menu`.

Render one `<svg aria-hidden="true" focusable="false">` from a `Record<IconName, ReactNode>` path map. The component owns no click behavior and requires no icon dependency. Set `width` and `height` from `size` with default `16`.

- [ ] **Bước 3: Commit navigation foundation**

```bash
git add apps/web/src/app/navigation apps/web/src/components/ui/app-icon.tsx
git commit -m "feat: add configurable CloudOps navigation"
```

---

### 任务 3：Implement the dashboard feature components

**文件：**
- 新建：`apps/web/src/features/dashboard/components/dashboard-welcome.tsx`
- 新建：`apps/web/src/features/dashboard/components/dashboard-summary.tsx`
- 新建：`apps/web/src/features/dashboard/components/organization-overview.tsx`
- 新建：`apps/web/src/features/dashboard/components/recent-members.tsx`
- 新建：`apps/web/src/features/dashboard/components/getting-started.tsx`
- 新建：`apps/web/src/features/dashboard/pages/dashboard-page.tsx`

**接口：**
- `DashboardWelcome({ organizationName, firstName }: { organizationName: string; firstName: string })`
- `DashboardSummary({ organization, memberCount, role }: { organization: Organization; memberCount: number; role: Role })`
- `OrganizationOverview({ organization }: { organization: Organization })`
- `RecentMembers({ members }: { members: Member[] })`
- `GettingStarted({ items }: { items: GettingStartedItem[] })`
- `DashboardPage(): JSX.Element`

- [ ] **Bước 1: Compose the dashboard page from mock state**

`DashboardPage` reads `currentOrganization` from `useTenant`, looks up `membersByOrganization[currentOrganization.id] ?? []`, passes the full member list to `DashboardSummary`, passes `members.slice(0, 3)` to `RecentMembers`, and reads `gettingStartedItems` from mocks.

Render the page in this order:

```tsx
<div className="dashboard-page">
  <DashboardWelcome firstName="Admin" organizationName={currentOrganization.name} />
  <DashboardSummary
    organization={currentOrganization}
    memberCount={members.length}
    role={currentOrganization.role}
  />
  <div className="dashboard-primary-grid">
    <OrganizationOverview organization={currentOrganization} />
    <GettingStarted items={gettingStartedItems} />
  </div>
  <RecentMembers members={members.slice(0, 3)} />
</div>
```

- [ ] **Bước 2: Implement welcome and summary components**

`DashboardWelcome` renders the exact copy `Good morning, Admin` and `Here's what's happening in {organizationName}.`.

`DashboardSummary` renders four `PixelStatCard` components using the actual PxlKit prop `label`: Organization/selected name, Members/member count, Your Role/Administrator or Operator or Viewer, and Environment/selected environment. Use `surface="linear"` and restrained tones.

- [ ] **Bước 3: Implement organization overview**

`OrganizationOverview` uses `<PixelCard title="Organization overview">` and a definition-list grid with Organization Name, Slug, Plan, and Created. Render the plan value inside `<PixelBadge tone="cyan" variant="soft">` so the overview has a consistent accent in both themes.

- [ ] **Bước 4: Implement recent members with PxlKit DataTable**

Import `PixelDataTable` and `type PixelDataTableProps` from `@pxlkit/ui-kit`. Avoid a new direct TanStack import by declaring:

```tsx
const columns: PixelDataTableProps<Member>['columns'] = [
  {
    accessorKey: 'name',
    header: 'Name',
    cell: ({ row }) => (
      <div className="member-cell">
        <PixelAvatar name={row.original.name} size="sm" />
        <span>{row.original.name}</span>
      </div>
    ),
  },
  { accessorKey: 'email', header: 'Email' },
  {
    accessorKey: 'role',
    header: 'Role',
    cell: ({ row }) => <PixelBadge tone="cyan">{formatRole(row.original.role)}</PixelBadge>,
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => <PixelBadge tone="green">{formatStatus(row.original.status)}</PixelBadge>,
  },
];
```

Render `<PixelDataTable<Member> data={members} columns={columns} density="comfortable" bordered stickyHeader />` inside a titled dashboard section. Define `formatRole` and `formatStatus` as local pure functions with all three role labels and both status labels; do not duplicate those labels in JSX.

- [ ] **Bước 5: Implement getting started checklist**

`GettingStarted` uses a PxlKit card and maps `items` from `gettingStartedItems`. Completed rows show `check-circle` and `aria-label="Completed"`; pending rows show `circle`; the VM row shows a `Coming soon` badge and no click handler. Checklist strings remain in `src/mocks/getting-started.ts`.

- [ ] **Bước 6: Commit dashboard feature**

```bash
git add apps/web/src/features/dashboard
git commit -m "feat: add Phase 1 identity dashboard"
```

---

### 任务 4：Implement the PxlKit shell and shared layout

**文件：**
- 新建：`apps/web/src/components/shell/app-sidebar.tsx`
- 新建：`apps/web/src/components/shell/tenant-switcher.tsx`
- 新建：`apps/web/src/components/shell/app-header.tsx`
- 新建：`apps/web/src/components/shell/theme-toggle.tsx`
- 新建：`apps/web/src/components/shell/user-menu.tsx`
- 新建：`apps/web/src/app/layouts/app-layout.tsx`

**接口：**
- All six components are exported React function components without required props; they read tenant/theme/user/navigation state from their respective modules.
- `AppSidebar` converts `navigationSections` to PxlKit sidebar sections and maps each `NavigationItem.icon` to `AppIcon`.
- `AppLayout(): JSX.Element`

- [ ] **Bước 1: Build `AppSidebar` from config**

Use PxlKit `PixelSidebar` with `collapsible`, `defaultCollapsed={false}`, `sections`, `header`, and `footer`. Filter `disabled` items before mapping and set `active` from `useLocation().pathname === item.href`.

The header contains the CloudOps cloud mark, the `CloudOps` wordmark, and `TenantSwitcher`. The footer contains `PixelAvatar name={currentUser.name} size="sm"` and the role label `Administrator`. No individual Manage row is written directly in JSX.

- [ ] **Bước 2: Implement `TenantSwitcher` with `PixelDropdown`**

Use PxlKit's compositional API and concrete trigger/content:

```tsx
<PixelDropdown.Root>
  <PixelDropdown.Trigger ariaLabel="Switch organization" icon={<AppIcon name="chevron-down" />}>
    <span className="tenant-switcher-copy">
      <strong>{currentOrganization.name}</strong>
      <small>{formatRole(currentOrganization.role)}</small>
    </span>
  </PixelDropdown.Trigger>
  <PixelDropdown.Content>
    <PixelDropdown.Header>Switch organization</PixelDropdown.Header>
    {organizations.map((organization) => (
      <PixelDropdown.Item
        key={organization.id}
        value={organization.id}
        icon={organization.id === currentOrganization.id ? <AppIcon name="check" /> : undefined}
        onSelect={() => selectOrganization(organization.id)}
      >
        {organization.name}
      </PixelDropdown.Item>
    ))}
    <PixelDropdown.Separator />
    <PixelDropdown.Item value="organization-settings" icon={<AppIcon name="settings" />}>
      Organization settings
    </PixelDropdown.Item>
  </PixelDropdown.Content>
</PixelDropdown.Root>
```

Render the selected role as `Admin` for `ADMIN` and `Operator` for `OPERATOR`. The settings item has no backend action and does not change tenant state.

- [ ] **Bước 3: Implement `ThemeToggle` and `UserMenu`**

`ThemeToggle` uses `useTheme()` and PxlKit `PixelIconButton`; label is `Switch to light mode` or `Switch to dark mode`, icon is `sun` or `moon` based on resolved mode.

`UserMenu` uses a `PixelDropdown.Root` trigger containing `PixelAvatar`, current user name, and role. Its content includes the user name/email header, Profile, Account settings, separator, and Sign out item with no action. Do not add auth logic.

- [ ] **Bước 4: Implement `AppHeader`**

Use `useLocation()` and render a `PixelBreadcrumb` with `Dashboard` active for `/dashboard`. The right side contains a soft neutral Search `PixelButton` with search icon and `⌘ K` hint, a `PixelIconButton label="Notifications"` with bell icon, `ThemeToggle`, and `UserMenu`. Search and notifications have no click side effects. Use semantic `<header>` and an accessible label for the action group.

- [ ] **Bước 5: Implement `AppLayout`**

`AppLayout` renders only the shared shell and route outlet:

```tsx
<div className="cloudops-shell">
  <AppSidebar />
  <div className="cloudops-main-column">
    <AppHeader />
    <main className="cloudops-main-content">
      <Outlet />
    </main>
  </div>
</div>
```

Do not put dashboard data or dashboard sections in this file.

- [ ] **Bước 6: Commit shell and layout**

```bash
git add apps/web/src/components/shell apps/web/src/app/layouts/app-layout.tsx
git commit -m "feat: add CloudOps sidebar header and layout"
```

---

### 任务 5：Wire React Router and replace the Vite App entry

**文件：**
- 新建：`apps/web/src/app/router/router.tsx`
- 修改：`apps/web/src/App.tsx`

**接口：**
- `AppRouter(): JSX.Element`
- `App(): JSX.Element`

- [ ] **Bước 1: Define the browser router**

Create `router.tsx` with `createBrowserRouter`, `RouterProvider`, and `Navigate` from `react-router-dom`. Import the already-created `AppLayout` and `DashboardPage` and define these route semantics:

```tsx
const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/dashboard" replace /> },
  {
    element: <AppLayout />,
    children: [{ path: '/dashboard', element: <DashboardPage /> }],
  },
  { path: '*', element: <Navigate to="/dashboard" replace /> },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
```

Keep the router object outside the component so it is not recreated on render.

- [ ] **Bước 2: Replace the Vite starter App component**

Replace `App.tsx` with:

```tsx
function App() {
  return (
    <AppProviders>
      <AppRouter />
    </AppProviders>
  );
}

export default App;
```

Leave `main.tsx` using `StrictMode`, `createRoot`, `index.css`, and `App`.

- [ ] **Bước 3: Commit router boundary**

```bash
git add apps/web/src/App.tsx apps/web/src/app/router/router.tsx
git commit -m "feat: wire React Router dashboard entry"
```

---

### 任务 6：Replace starter styling and document metadata

**文件：**
- 修改：`apps/web/src/index.css`
- 修改：`apps/web/index.html`
- 删除：`apps/web/src/App.css`

**接口：**
- CSS classes used by shell/dashboard: `.cloudops-shell`, `.cloudops-sidebar`, `.cloudops-main-column`, `.cloudops-main-content`, `.dashboard-page`, `.dashboard-primary-grid`, `.member-cell`, `.checklist-item`.

- [ ] **Bước 1: Remove the fixed Vite frame and define theme tokens**

Keep these imports at the top:

```css
@import "tailwindcss";
@import "@pxlkit/ui-kit/styles.css";
@source "../node_modules/@pxlkit/ui-kit";
```

Define `:root`/`.light` tokens for slate backgrounds, elevated surfaces, text, muted text, borders, cyan accent, and focus ring. Define matching `.dark` overrides. Set `html`, `body`, and `#root` to `min-height: 100%; margin: 0;` and remove the old `1126px` width, border, center alignment, starter headings, and social/demo selectors.

- [ ] **Bước 2: Define responsive shell and dashboard layout rules**

Use CSS grid for the desktop shell:

```css
.cloudops-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(15rem, 17rem) minmax(0, 1fr);
  background: var(--cloudops-page);
}

.cloudops-sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
}

.cloudops-main-column {
  min-width: 0;
  min-height: 100vh;
}

.cloudops-main-content {
  width: min(100%, 88rem);
  margin: 0 auto;
  padding: 2rem clamp(1rem, 3vw, 3rem) 3rem;
}
```

Add a breakpoint at `max-width: 900px` that makes the shell one column, lets the PxlKit sidebar collapse, reduces content padding, changes `.dashboard-primary-grid` to one column, and allows header actions to wrap. Keep the desktop sidebar fixed/sticky and the main column scrollable.

- [ ] **Bước 3: Style cards, members, and checklist without overriding PxlKit internals**

Use application classes for section gaps, member avatar/name alignment, checklist rows, muted metadata, and responsive table overflow. Do not duplicate PxlKit card/table borders or replace PxlKit component primitives with custom cards.

- [ ] **Bước 4: Update document title and remove unused starter CSS**

Change `<title>web</title>` to `<title>CloudOps</title>` in `index.html`. Delete `src/App.css` after confirming no import remains.

- [ ] **Bước 5: Commit visual shell styling**

```bash
git add apps/web/src/index.css apps/web/index.html
git rm apps/web/src/App.css
git commit -m "feat: add CloudOps responsive theme styling"
```

---

### 任务 7：Build and verify the delivered `/dashboard`

**文件：**
- Verify all modified files under `apps/web`.
- No new test files.

**接口：**
- Build command: `pnpm --dir apps/web build`
- Existing GUI URL: `http://127.0.0.1:3080/dashboard`

- [ ] **Bước 1: Run the production build**

Run:

```bash
pnpm --dir apps/web build
```

Expected result: TypeScript composite build and Vite build complete successfully with no unresolved imports, unused-local errors, or JSX prop type errors.

- [ ] **Bước 2: Check the existing GUI route**

Refresh/open `http://127.0.0.1:3080/dashboard` in the existing browser session. Confirm the URL remains `/dashboard` and the page shows CloudOps branding, tenant switcher, sidebar, header actions, welcome copy, four stat cards, organization overview, recent members table, and getting-started checklist.

- [ ] **Bước 3: Check the stateful interactions manually**

1. Open the tenant dropdown, select `Cloud Lab`, and confirm the sidebar/header/dashboard organization name, role, member count, overview values, and recent members update.
2. Activate the theme icon, confirm the document switches between `.light` and `.dark`, the visual tokens change, and a refresh preserves the selected mode through local storage.
3. Activate the PxlKit sidebar collapse control and confirm the main content remains usable at desktop width.

- [ ] **Bước 4: Review working tree and commit final integration**

Run:

```bash
git status --short
git log -5 --oneline
```

Confirm only intended source/lock files are changed and generated `dist` output remains ignored. Commit any final integration adjustment with:

```bash
git add apps/web
git commit -m "feat: deliver CloudOps dashboard shell"
```
