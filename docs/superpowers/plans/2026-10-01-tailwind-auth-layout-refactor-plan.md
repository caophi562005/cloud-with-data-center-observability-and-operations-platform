# Tailwind v4 Styling Refactor and Auth Layout Fix Implementation Plan

> **面向 Agent 执行者：** 必需子技能：使用 `superpower-subagent-driven-development`（推荐）或 `superpower-executing-plans` 按任务逐项执行本计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 将 `apps/web` 的 shell、dashboard、Login/Register component-specific styling 全部迁移到 Tailwind CSS v4，删除 `auth.css`，并修复 auth viewport scrollbar/layout 问题。

**架构：** 保留 `index.css` 作为唯一全局 stylesheet，只承载 Tailwind/PxlKit imports、font、theme tokens 和 document reset。组件 layout 由 JSX 中的 Tailwind utilities 表达；AuthLayout 提供统一的 desktop grid 和 mobile breakpoint，form panel 使用固定 vertical padding 与 bounded overflow，避免 viewport-width-dependent padding 产生假 scrollbar。

**技术栈：** React 19、TypeScript、Vite、Tailwind CSS v4、`@tailwindcss/vite`、PxlKit `@pxlkit/ui-kit@2.1.1`、React Router、TanStack Query、DSH browser tools。

**规格：** `docs/superpowers/specs/2026-10-01-tailwind-auth-layout-refactor-design.md`

## 全局约束

- `apps/web/src/index.css` 只保留 imports/source/font/theme tokens 和 minimal global reset/body defaults。
- 删除 `apps/web/src/features/auth/auth.css`，不创建替代的 component stylesheet。
- 所有 shell、dashboard、auth component-specific layout/style 使用 JSX Tailwind utilities，包括 arbitrary values；不要新增 custom selector 或 custom media query。
- Auth desktop grid 使用 `minmax(20rem, 40vw) minmax(28rem, 1fr)`；`max-[901px]` 切换单列；`max-[640px]` 保持 full-width mobile behavior。`max-[901px]` 是为 Tailwind v4 的严格 max 变体保留 900px inclusive 行为的整数阈值，不得改回 `max-[900px]`。
- Form panel 的 vertical padding 不得依赖 `vw`；Login/Register 必须在内容实际适合 viewport 时不产生 vertical scrollbar，内容超出时可以自然滚动且不被裁切。
- 不修改 business logic、authentication flow、React Query、API、Cognito、router、文案或 PxlKit behavior。
- 保持 light/dark token values、PxlKit styles import 和现有 visual language。
- 保留当前工作树中 `auth.css` 的 `40vw/1fr` 变更意图；不 reset 或覆盖 API/Makefile 等无关改动。
- 不运行 `git add`、`git commit`、merge、reset 或其他 staging/commit 操作。
- 每个代码修改步骤完成后使用 `pnpm --dir apps/web run build` 或目标 lint/build 检查；最终必须完整运行 build 与 lint。

---

### Task 1:建立基线并锁定无关工作树改动

**文件：**
- 读取：`apps/web/src/index.css`
- 读取：`apps/web/src/features/auth/auth.css`
- 读取：`apps/web/src/app/layouts/auth-layout.tsx`
- 读取：`apps/web/src/app/layouts/app-layout.tsx`
- 不修改其他工作树文件

**接口：**
- 依赖输入：已批准的规格文档和当前 `main` working tree。
- 对外产出：一份执行记录，包含当前 `git status`, build/lint baseline，以及未修改文件清单；后续任务以此判断 diff 是否越界。

- [ ] **步骤 1：记录 working tree 基线**

运行：

```powershell
git status --short
```

确认并记录已有的 `.gitignore`, `Makefile`, `apps/api/**` 变更和 `apps/web/src/features/auth/auth.css` 的现有 grid 变更；不得 reset、stash、stage 或编辑这些文件。

- [ ] **步骤 2：运行当前 web build baseline**

运行：

```powershell
pnpm --dir apps/web run build
```

预期：记录命令的真实结果。若 baseline 已失败，只记录具体错误并把它与本次 CSS 迁移产生的错误区分开，不修改业务代码修复无关问题。

- [ ] **步骤 3：运行当前 web lint baseline**

运行：

```powershell
pnpm --dir apps/web run lint
```

预期：记录命令的真实结果，并保留 baseline 输出供最终对比。

- [ ] **步骤 4：记录可复现的 auth DOM baseline**

在现有 GUI 打开 `/login` 和 `/register`，对每个页面执行以下 measurement expression，并保存返回值：

```js
(() => {
  const rect = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  };
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
    layout: rect('main'),
    brand: rect('[aria-labelledby="auth-brand-title"]'),
    form: rect('section[aria-label*="account"], section[aria-label*="Sign in"]'),
    card: rect('section[aria-label*="account"] > *, section[aria-label*="Sign in"] > *'),
  };
})()
```

- [ ] **步骤 5：确认基线任务完成后再编辑代码**

用 `git status --short` 确认除计划/spec 文件外没有自动生成的 source changes。

---

### Task 2:迁移 AuthLayout 与 brand panel，删除 auth.css

**文件：**
- 修改：`apps/web/src/app/layouts/auth-layout.tsx`
- 修改：`apps/web/src/features/auth/components/auth-brand-panel.tsx`

**接口：**
- 依赖输入：`AuthLayout({ children: React.ReactNode }): JSX.Element`; `AuthBrandPanel(): JSX.Element`。
- 对外产出：AuthLayout 直接提供 desktop two-column/mobile one-column Tailwind grid；AuthBrandPanel 提供同一左列下的 brand visual。为保持此任务结束时 form panel 仍可运行，`auth.css` import/file 暂时保留到 Task 3 的 form migration 完成；Task 3 随后原子地移除最后的 import 并删除 stylesheet。

- [ ] **步骤 1：替换 AuthLayout stylesheet import 和 wrapper**

在 `auth-layout.tsx` 中：

- 保留 `import "../../features/auth/auth.css";` 到 Task 3 完成 form-panel utilities；这段暂存依赖保证本任务结束时仍有旧 form-panel layout。Task 3 会在 form utilities 落地后删除该 import。
- 删除 `auth-layout-grid` wrapper。
- 将 `<main>` class 改为包含以下行为的 Tailwind utilities：`relative grid min-h-screen`, `grid-cols-[minmax(20rem,40vw)_minmax(28rem,1fr)]`, `overflow-x-hidden`, page background/text tokens，以及 `max-[901px]:grid-cols-1`。
- 将 tools wrapper 改为 absolute top/right utility，保留 `z-10` 和 `ThemeToggle`。
- 让 `children` 直接成为 grid items，保持 render order：brand panel 在左，form panel 在右。

目标结构：

```tsx
<main className="relative grid min-h-screen grid-cols-[minmax(20rem,40vw)_minmax(28rem,1fr)] overflow-x-hidden bg-[var(--cloudops-page)] text-[var(--cloudops-text)] max-[901px]:grid-cols-1">
  <div className="absolute right-4 top-4 z-10 sm:right-8 sm:top-8 lg:right-10 lg:top-8">
    <ThemeToggle />
  </div>
  {children}
</main>
```

- [ ] **步骤 2：迁移 AuthBrandPanel structural utilities**

在 `auth-brand-panel.tsx` 中：

- 给 section 添加 `relative isolate flex min-h-screen flex-col justify-center overflow-hidden border-r-2 border-retro-border bg-retro-surface`。
- 使用固定 vertical spacing：`py-8 lg:py-16`；horizontal spacing 使用 `px-[clamp(2rem,7vw,7rem)]`，不得把 `vw` 放入 `py`/`padding-block`。
- 在 section 上添加 `max-[901px]:min-h-0 max-[901px]:border-r-0 max-[901px]:border-b-2 max-[901px]:px-[clamp(1.5rem,7vw,4rem)] max-[901px]:py-8`。
- 添加 `max-[640px]:px-4 max-[640px]:pb-6 max-[640px]:pt-[4.5rem]`；content 在 `max-[901px]` 使用 `grid-cols-[auto_minmax(0,1fr)]`，在 `max-[640px]` 恢复单列。
- 将 content/copy/icon/list 的旧 selector 分别转为 `relative z-10 grid w-full max-w-[34rem] gap-6`, `grid gap-2`, `inline-flex items-center`, `mt-6 grid list-none gap-2 p-0 text-retro-muted` 等 utilities。
- 保留既有 text、aria labels、PxlKit icon 和 title/copy。

- [ ] **步骤 3：用 arbitrary background utility 保留 SVG grid visual**

将原 `.auth-brand-panel-grid` 的 data URI 转为 `<div aria-hidden="true">` 的 Tailwind class：

```tsx
<div
  aria-hidden="true"
  className="pointer-events-none absolute inset-0 -z-10 bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'%3E%3Cpath d='M32 0H0V32' fill='none' stroke='%2339d5df' stroke-opacity='.22' stroke-width='1'/%3E%3C/svg%3E\")] bg-[length:2rem_2rem] opacity-[0.45] max-[901px]:hidden"
/>
```

保持编码后的 SVG 内容、尺寸和 opacity 与现有规则一致；不要用新的颜色或渐变替代。

- [ ] **步骤 4：替换 capability pseudo-element**

将每个 `<li>` 改为 `relative pl-6 leading-normal`，并在现有 text 前插入：

```tsx
<span
  aria-hidden="true"
  className="absolute left-0 top-2 size-2 border border-retro-cyan bg-[var(--cloudops-accent-soft)]"
/>
```

不改变三条 capability 文案或 `aria-label`。

- [ ] **步骤 5：确认 brand selectors 已迁移且暂存 form stylesheet 依赖明确**

运行：

```powershell
grep -R "auth\.css\|auth-layout\|auth-layout-tools\|auth-layout-grid\|auth-brand-panel\|auth-brand-panel-grid\|auth-brand-panel-content" apps/web/src --include="*.tsx" --include="*.ts" --include="*.css"
```

预期：`auth-layout`, `auth-layout-tools`, `auth-layout-grid`, `auth-brand-panel*` selector 不再出现在 JSX/CSS；此任务结束时只允许 `auth-layout.tsx` 暂时保留一条 `auth.css` import，且 `auth-form-panel` 仍由 stylesheet 支撑，直到 Task 3 完成 form migration。

- [ ] **步骤 6：验证 AuthLayout 编译**

运行：

```powershell
pnpm --dir apps/web run build
pnpm --dir apps/web run lint
```

预期：两条命令均通过；若 arbitrary URL class 导致 TypeScript/JSX 语法错误，修正字符串 escaping，不回退到 CSS 文件。

---

### Task 3:迁移 Login/Register form panel layout

**文件：**
- 修改：`apps/web/src/features/auth/components/login-form.tsx`
- 修改：`apps/web/src/features/auth/components/register-form.tsx`
- 修改：`apps/web/src/app/layouts/auth-layout.tsx`
- 删除：`apps/web/src/features/auth/auth.css`

**接口：**
- 依赖输入：任务 2 的 AuthLayout grid 与 brand panel，以及暂时仍提供旧 form-panel style 的 auth.css。
- 对外产出：`LoginForm`, `RegisterForm` 的 register/confirm render branches 继续保留原 props、state、handlers、PxlKit components 和 accessible labels，仅改变 layout classes；form utilities 落地后移除 AuthLayout 的最后一条 stylesheet import 并删除 auth.css。

- [ ] **步骤 1：定义并应用统一 form-panel utility pattern**

将 LoginForm 的 section、RegisterForm 的两个 section 都使用同一 class pattern：

```text
flex min-h-0 min-w-0 justify-center overflow-y-auto
bg-[var(--cloudops-page)]
px-[clamp(1rem,5vw,5rem)] py-6 sm:py-8 lg:py-10
max-[901px]:overflow-visible
max-[640px]:w-full max-[640px]:px-4 max-[640px]:py-8 max-[640px]:pb-12
```

`px` 可保留 horizontal clamp 以接近现有视觉，但 vertical spacing 必须由 fixed `py-*` utilities 提供。

- [ ] **步骤 2：保持 PixelCard width 并增加 safe vertical centering**

在 LoginForm 和 RegisterForm 两个 branch 的 PixelCard 上把 className 统一为：

```text
my-auto w-full max-w-md
```

保留所有 `title`, `description`, `fullWidth`, `tone`, `loading` props 和 form contents。不要向 form handlers、mutation calls 或 navigation code 添加 layout logic。

- [ ] **步骤 3：移除 stylesheet-only mobile workarounds**

确认以下旧规则不再需要：form panel child width/max-width/min-width 和 `form > button` width rule。现有 `w-full max-w-md` 与 PxlKit `fullWidth` props 已覆盖这些行为；不增加 duplicate classes 到每个 button，除非 build/browser measurement 证明 PxlKit root width 需要显式 `min-w-0`。

- [ ] **步骤 4：移除最后的 auth stylesheet 依赖**

在确认 LoginForm、RegisterForm 的三种 form-panel render branches 都已获得统一 utilities 后：

- 删除 `import "../../features/auth/auth.css";` from `apps/web/src/app/layouts/auth-layout.tsx`。
- 删除 `apps/web/src/features/auth/auth.css`。
- 搜索 `auth.css` 和 `auth-form-panel`，确认没有 import 或旧 selector 依赖残留；`auth-form-panel` 也应已从 form JSX 中移除。

- [ ] **步骤 5：验证 auth form branches**

运行：

```powershell
pnpm --dir apps/web run build
pnpm --dir apps/web run lint
```

预期：登录、注册和 confirmation branch 均通过类型检查；未出现未使用 import、stylesheet resolution 或 JSX nesting 错误。

---

### Task 4:迁移 app shell 的 Tailwind utilities

**文件：**
- 修改：`apps/web/src/app/layouts/app-layout.tsx`
- 修改：`apps/web/src/components/shell/app-header.tsx`
- 修改：`apps/web/src/components/shell/app-sidebar.tsx`
- 修改：`apps/web/src/components/shell/tenant-switcher.tsx`
- 修改：`apps/web/src/components/shell/user-menu.tsx`

**接口：**
- 依赖输入：现有 `AppLayout`, `AppSidebar`, `AppHeader`, `TenantSwitcher`, `UserMenu` props/hooks 不变。
- 对外产出：shell 视觉和 responsive behavior 不再依赖 `index.css` selector；PxlKit root receives className through its existing `React.HTMLAttributes<HTMLElement>` API.

- [ ] **步骤 1：将 shell grid 放入 AppLayout**

保留 `data-sidebar-collapsed` attribute 和 `collapsed` state，但把 `.cloudops-shell` selector 替换为 conditional static class strings：

```tsx
const shellColumns = collapsed
  ? "grid-cols-[3.5rem_minmax(0,1fr)]"
  : "grid-cols-[14rem_minmax(0,1fr)]";

<div
  className={`min-h-screen bg-[var(--cloudops-page)] ${shellColumns} max-[901px]:grid-cols-[minmax(0,1fr)]`}
  data-sidebar-collapsed={collapsed ? "true" : "false"}
>
```

Use complete literal class strings so Tailwind v4 scans both collapsed states.

- [ ] **步骤 2：迁移 main column/content utilities**

Replace `.cloudops-main-column` with:

```text
flex h-screen min-h-screen min-w-0 flex-col overflow-x-hidden overflow-y-auto overscroll-contain bg-[var(--cloudops-page)] max-[901px]:h-auto max-[901px]:min-h-0 max-[901px]:overflow-visible
```

Replace `.cloudops-main-content` with:

```text
mx-auto w-full max-w-[88rem] flex-[1_0_auto] px-[clamp(1rem,3vw,3rem)] pt-8 pb-12 max-[901px]:px-4 max-[901px]:pt-6 max-[901px]:pb-8
```

Keep `<Outlet />` and the existing component hierarchy unchanged.

- [ ] **步骤 3：apply PxlSidebar root geometry through className**

Add the following className to `PixelSidebar` in `AppSidebar`; its props extend `React.HTMLAttributes<HTMLElement>` in the installed PxlKit declaration:

```text
sticky top-0 z-10 h-screen min-h-screen border-retro-border shadow-[3px_0_0_var(--cloudops-shadow)] max-[901px]:h-auto max-[901px]:min-h-0 max-[901px]:max-w-full max-[901px]:shadow-[0_3px_0_var(--cloudops-shadow)]
```

Do not change `sections`, `header`, `footer`, collapse callbacks, navigation callbacks, or accessibility labels.

- [ ] **步骤 4：complete header and shell-copy utilities**

In `AppHeader`, add the former header surface/border/shadow utilities to the existing header class without removing current responsive flex classes. In `TenantSwitcher` and `UserMenu`, replace `tenant-switcher-copy`/`user-menu-copy` selectors with explicit classes for column direction, truncation, gap, text alignment, muted role line, and strong-label ellipsis. Keep all menu values and handlers.

- [ ] **步骤 5：verify shell-only changes**

Run:

```powershell
pnpm --dir apps/web run build
pnpm --dir apps/web run lint
```

Then search:

```powershell
grep -R "cloudops-shell\|cloudops-main-column\|cloudops-main-content\|tenant-switcher-copy\|user-menu-copy" apps/web/src --include="*.tsx" --include="*.css"
```

Expected: no stylesheet selectors remain; any remaining string is an intentional semantic/data hook with no CSS dependency.

---

### Task 5:迁移 dashboard JSX styling

**文件：**
- 修改：`apps/web/src/features/dashboard/pages/dashboard-page.tsx`
- 修改：`apps/web/src/features/dashboard/components/dashboard-welcome.tsx`
- 修改：`apps/web/src/features/dashboard/components/dashboard-summary.tsx`
- 修改：`apps/web/src/features/dashboard/components/organization-overview.tsx`
- 修改：`apps/web/src/features/dashboard/components/getting-started.tsx`
- 修改：`apps/web/src/features/dashboard/components/recent-members.tsx`

**接口：**
- 依赖输入：现有 dashboard props, hooks, query states, PxlKit components 和 domain types。
- 对外产出：相同 dashboard DOM content/data behavior，所有 former `index.css` dashboard selectors replaced by colocated Tailwind classes.

- [ ] **步骤 1：migrate DashboardPage stack and state card**

Use these utility equivalents:

- `.dashboard-page` → `grid min-w-0 gap-6` on all page wrappers.
- `.dashboard-state` → `grid min-w-0 gap-3 border-2 border-retro-border bg-retro-surface p-[clamp(1.5rem,4vw,3rem)] shadow-[4px_4px_0_var(--cloudops-shadow)]`.
- state heading → `text-retro-cyan font-[var(--font-pixel)] text-[clamp(1rem,2vw,1.25rem)] font-normal leading-normal uppercase [overflow-wrap:anywhere]`.
- state copy → `max-w-3xl text-retro-muted [overflow-wrap:anywhere]`.
- `.dashboard-primary-grid` → `grid min-w-0 grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)] items-start gap-5 max-[901px]:grid-cols-[minmax(0,1fr)]`.

Keep loading/error/no-organization branching and `role` values exactly as written.

- [ ] **步骤 2：migrate welcome and summary grids**

In `DashboardWelcome`, use `grid gap-[0.4rem]`; give the heading `text-retro-cyan font-[var(--font-pixel)] text-[clamp(1rem,2.2vw,1.4rem)] font-normal tracking-[0.06em] leading-[1.45] uppercase text-shadow-[2px_2px_0_var(--cloudops-shadow)]`, and use `text-retro-muted` for the paragraph.

In `DashboardSummary`, use `grid min-w-0 grid-cols-3 gap-4 max-[1200px]:grid-cols-2 max-[640px]:grid-cols-1` on the summary grid. Remove `dashboard-summary` class if it has no remaining style responsibility. Because the installed `PixelStatCardProps` does not expose `className`, apply `shadow-[4px_4px_0_var(--cloudops-shadow)]` to the summary grid's direct child divs with the parent arbitrary variant `[&>div]:shadow-[4px_4px_0_var(--cloudops-shadow)]`, matching the former `.dashboard-summary-grid > div` selector without changing PxlKit props or DOM structure.

- [ ] **步骤 3：migrate organization overview**

Use `grid grid-cols-2 min-w-0 gap-x-6 gap-y-5 m-0 max-[640px]:grid-cols-1` on the definition list. Add `min-w-0` to its direct cells, `text-[0.7rem] font-bold uppercase tracking-[0.08em] leading-tight text-retro-muted` to `dt`, and `m-0 mt-[0.35rem] text-retro-text [overflow-wrap:anywhere]` to `dd`.

- [ ] **步骤 4：migrate getting-started and recent-members**

For Getting Started:

- add `shadow-[4px_4px_0_var(--cloudops-shadow)] [&_header]:border-b-2 [&_header]:border-retro-border` to the `PixelCard`;
- list → `grid gap-[0.625rem]`;
- item → `grid min-h-10 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3`;
- icon → `inline-flex items-center justify-center text-[var(--cloudops-accent)]`;
- label → `min-w-0 [overflow-wrap:anywhere]`;
- coming-soon label → `text-retro-muted`.

For Organization Overview, add the same `shadow-[4px_4px_0_var(--cloudops-shadow)] [&_header]:border-b-2 [&_header]:border-retro-border` utility to its `PixelCard` so the former `.dashboard-page article` and `.dashboard-page article header` rules remain identical.

For Recent Members:

- section → `min-w-0 overflow-x-auto [scrollbar-gutter:stable]`;
- `PixelCard` → `shadow-[4px_4px_0_var(--cloudops-shadow)] [&_header]:border-b-2 [&_header]:border-retro-border`;
- table min width → `[&_table]:min-w-[42rem]` on the Recent Members `PixelCard`, targeting only this component;
- member cell → `flex min-w-max items-center gap-3 whitespace-nowrap`;
- empty-state copy → `text-retro-muted [overflow-wrap:anywhere]`.

Keep member column definitions, row renderers, query branches, and table props unchanged.

- [ ] **步骤 5：verify dashboard-only migration**

Run:

```powershell
pnpm --dir apps/web run build
pnpm --dir apps/web run lint
```

Search for former dashboard selectors:

```powershell
grep -R "dashboard-page\|dashboard-state\|dashboard-welcome\|dashboard-summary-grid\|dashboard-primary-grid\|organization-overview-grid\|getting-started-list\|getting-started-item\|member-cell\|recent-members" apps/web/src --include="*.tsx" --include="*.css"
```

Expected: no selector in `index.css`; remove each className that no longer carries semantic/accessibility value.

---

### Task 6:reduce index.css to global-only and remove dead styling

**文件：**
- 修改：`apps/web/src/index.css`
- 修改：any JSX file still containing a class whose only consumer was removed CSS

**接口：**
- 依赖输入：Tasks 2–5 have replaced all component selector behavior with utilities.
- 对外产出：`index.css` contains only the approved global contract; source tree has no dead component CSS or auth stylesheet references.

- [ ] **步骤 1：remove component rules from index.css**

Delete every rule beginning at `.cloudops-shell` through the end of the file, including all dashboard selectors and custom `@media` blocks. Preserve the import/source/font/token sections and the minimal global reset/body declarations.

After editing, the file must contain no selector beginning with `.cloudops-`, `.dashboard-`, `.organization-`, `.getting-started-`, `.member-cell`, `.recent-members`, `.tenant-switcher-`, or `.user-menu-`.

- [ ] **步骤 2：remove dead className strings**

Use a source search over `apps/web/src` and remove class names that no longer have a styling or semantic/accessibility role. Do not remove accessible labels, `aria-*` values, React keys, or PxlKit props merely because their text resembles an old CSS class.

- [ ] **步骤 3：run CSS/source dead-rule audit**

Run:

```powershell
grep -R "auth\.css\|cloudops-shell\|cloudops-main-column\|cloudops-main-content\|dashboard-state\|dashboard-welcome\|dashboard-summary-grid\|dashboard-primary-grid\|organization-overview-grid\|getting-started-list\|member-cell\|tenant-switcher-copy\|user-menu-copy" apps/web/src --include="*.tsx" --include="*.ts" --include="*.css"
```

Expected: no `auth.css` import/file and no old component selector definitions. A remaining string must be a deliberate non-styling accessibility/data value and must be documented in the final report.

- [ ] **步骤 4：run strict build and lint after CSS removal**

Run:

```powershell
pnpm --dir apps/web run build
pnpm --dir apps/web run lint
```

Expected: both pass with no missing import, invalid Tailwind arbitrary class syntax, TypeScript error, or lint error.

---

### Task 7:verify viewport layout, themes, and final diff

**文件：**
- Read-only verification of all changed `apps/web` files
- Read-only verification of `docs/superpowers/specs/2026-10-01-tailwind-auth-layout-refactor-design.md`

**接口：**
- 依赖输入：completed Tailwind migration and passing build/lint.
- 对外产出：measurement report covering every requested viewport and a final diff-scope report; no source changes from verification.

- [ ] **步骤 1：open Login and measure desktop fit**

Open `/login` in the existing GUI at `1440x900`, `1440x700`, and `1024x768`. For each viewport capture:

```js
(() => {
  const box = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  return {
    viewport: { width: innerWidth, height: innerHeight },
    document: {
      clientHeight: document.documentElement.clientHeight,
      scrollHeight: document.documentElement.scrollHeight,
      hasVerticalOverflow: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    },
    layout: box('main'),
    brand: box('[aria-labelledby="auth-brand-title"]'),
    form: box('section[aria-label="Sign in to OpsGrid"]'),
    card: box('section[aria-label="Sign in to OpsGrid"] > *'),
  };
})()
```

Acceptance: when the card fits, `hasVerticalOverflow` is `false`; the form card is not clipped; brand width equals the expected first grid track.

- [ ] **步骤 2：open Register and measure actual overflow behavior**

Repeat at `1440x900`, `1440x700`, and `1024x768` using `section[aria-label="Create an OpsGrid account"]`. Record document and form-panel `scrollHeight/clientHeight` separately. At the fit viewport, no overflow may be attributable only to panel padding; at a genuinely short viewport, the form may scroll but must expose its first and last controls.

Switch Register to confirmation mode if the route can reach it through the existing flow, then confirm the same measurement pattern for `section[aria-label="Confirm your OpsGrid account"]`.

- [ ] **步骤 3：verify exact breakpoint and mobile widths**

At `900px`, `640px`, and `375px`, verify:

- `getComputedStyle(document.querySelector('main')).gridTemplateColumns` represents one column;
- brand and form panels have the same viewport width;
- no horizontal overflow exists;
- mobile form/card and buttons remain full width;
- low-height mobile content scrolls as one natural document rather than being cut off.

Use:

```js
({
  viewport: { width: innerWidth, height: innerHeight },
  columns: getComputedStyle(document.querySelector('main')).gridTemplateColumns,
  documentWidth: document.documentElement.scrollWidth,
  viewportWidth: document.documentElement.clientWidth,
  brandWidth: document.querySelector('[aria-labelledby="auth-brand-title"]')?.getBoundingClientRect().width,
  formWidth: document.querySelector('section[aria-label*="OpsGrid"]')?.getBoundingClientRect().width,
})
```

- [ ] **步骤 4：compare Login/Register brand width at matching desktop sizes**

Capture brand panel bounding boxes on both routes at each desktop size and assert the widths are equal within sub-pixel rounding. Record the measured values in the final report.

- [ ] **步骤 5：verify theme and PxlKit rendering**

Use the existing ThemeToggle on `/login`, `/register`, and `/dashboard`. Confirm `.light`/`.dark` classes change, token-based backgrounds/text remain readable, PixelCard/Input/Button/Sidebar/DataTable render without missing styles, and no business interaction behavior changed.

- [ ] **步骤 6：run final commands**

Run:

```powershell
pnpm --dir apps/web run build
pnpm --dir apps/web run lint
git diff --check
git status --short
```

Expected: build and lint pass; diff check has no whitespace errors; status shows only the intended frontend/spec/plan changes plus the pre-existing unrelated working-tree changes; no staged or committed changes are created.

- [ ] **步骤 7：prepare final report**

Report:

1. modified and deleted files;
2. CSS categories migrated to Tailwind;
3. only global CSS retained in `index.css` and why;
4. viewport measurements and scrollbar results for Login/Register;
5. build/lint results;
6. confirmation that API/Makefile changes were left untouched and no staging/commit occurred.
