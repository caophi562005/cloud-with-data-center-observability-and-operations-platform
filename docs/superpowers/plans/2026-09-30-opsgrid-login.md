# OpsGrid Login Implementation Plan

> **For the agent executing this plan:** Required sub-skill: use `superpower-subagent-driven-development` (recommended) or `superpower-executing-plans` to execute this plan task-by-task. Track each step with the checkbox syntax below.

**Goal:** Add a responsive, accessible `/login` page for OpsGrid with PxlKit controls, shared light/dark theme support, and a replaceable mock authentication boundary.

**Architecture:** Add `/login` outside the existing dashboard `AppLayout`. `LoginPage` composes a reusable `AuthLayout`, `AuthBrandPanel`, and `LoginForm`; the form calls an `AuthClient` interface backed by deterministic mock methods. Keep the existing `/` → `/dashboard` redirect and dashboard behavior unchanged.

**Tech stack:** React 19, Vite, TypeScript strict, React Router 7, `@pxlkit/ui-kit@2.1.1`, existing Tailwind CSS 4 tokens, existing bundled Press Start 2P display font.

**Specification:** `docs/superpowers/specs/2026-09-30-opsgrid-login-design.md`

## Global constraints

- Use **OpsGrid** as the visible product brand with subtitle `Cloud & Data Center Observability Platform`.
- Keep `/` redirecting to `/dashboard`; add `/login` without adding an auth guard.
- Accept any syntactically valid email with a non-empty password in mock authentication; do not add fixed demo credentials.
- Reuse the existing PxlKit `pixel` surface, `ThemeToggle`, semantic `retro-*` tokens, and bundled Press Start 2P font.
- Prefer PxlKit `PixelInput`, `PixelPasswordInput`, `PixelCheckbox`, `PixelButton`, `PixelCard`, `PixelDivider`, `PixelTextLink`, `PixelIconFrame`, and PxlKit loading behavior.
- Do not add Cognito, OAuth SDKs, AWS SDKs, OAuth libraries, a form library, a second UI kit, backend calls, or new test/smoke-test files.
- Do not implement registration, invitations, MFA, password reset, organization selection, or RBAC.
- Preserve light/dark persistence through the existing `useDarkMode`/`useTheme`/`ThemeToggle` path.
- Keep login styling in a feature-specific CSS file; do not put auth layout rules into the dashboard shell CSS.
- Verify with lint, production build, and manual browser checks instead of adding automated tests.

---

### Task 1: Create the replaceable auth boundary and pure validation

**Files:**
- Create: `apps/web/src/features/auth/auth.types.ts`
- Create: `apps/web/src/features/auth/auth.schema.ts`
- Create: `apps/web/src/mocks/auth.ts`
- Create: `apps/web/src/lib/auth/auth-client.ts`

**Interfaces:**
- `SignInInput = { email: string; password: string; rememberMe: boolean }`.
- `AuthUser = { email: string; provider: "password" | "google" }`.
- `AuthClient` exposes `signIn(input: SignInInput): Promise<AuthUser>`, `signInWithGoogle(): Promise<AuthUser>`, and `signOut(): Promise<void>`.
- Validation exports `validateEmail(email: string): string | undefined`, `validatePassword(password: string): string | undefined`, and `validateCredentials(input: Pick<SignInInput, "email" | "password">): Partial<Record<"email" | "password", string>>`.
- Mock exports an `authMock` object implementing `AuthClient`; `auth-client.ts` exports `authClient: AuthClient = authMock`.

- [ ] **Step 1: Define the auth data types.**

Create `auth.types.ts` with the exact `SignInInput`, `AuthUser`, and `AuthClient` definitions above. Keep the provider union limited to `"password" | "google"`; do not introduce tokens, sessions, organizations, or Cognito-specific fields.

- [ ] **Step 2: Define pure field validators.**

Create `auth.schema.ts` with no dependency imports. Implement:

```ts
export function validateEmail(email: string): string | undefined {
  if (!email.trim()) return "Email is required.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return "Please enter a valid email address.";
  }
  return undefined;
}

export function validatePassword(password: string): string | undefined {
  return password ? undefined : "Password is required.";
}
```

Implement `validateCredentials` by calling both functions and returning only fields with errors. Keep the returned error strings stable so the UI can render them directly.

- [ ] **Step 3: Implement deterministic mock auth methods.**

Create `mocks/auth.ts` with a private `delay` helper using a short fixed delay (for example, 650ms). Implement:

```ts
export const authMock: AuthClient = {
  async signIn({ email }: SignInInput) {
    await delay(650);
    return { email: email.trim(), provider: "password" };
  },
  async signInWithGoogle() {
    await delay(650);
    return { email: "google-user@example.com", provider: "google" };
  },
  async signOut() {
    await delay(150);
  },
};
```

The mock assumes the form has already validated input and must not check hard-coded credentials.

- [ ] **Step 4: Expose only the replaceable app-facing client.**

Create `lib/auth/auth-client.ts` importing `AuthClient` and `authMock`, then export `authClient`. Components must import this boundary, not `mocks/auth.ts`, so a later Cognito adapter replaces one file.

- [ ] **Step 5: Verify the boundary compiles and commit.**

Run `pnpm --dir apps/web build`. Expect TypeScript/Vite success; no browser route exists yet, so do not add a temporary page. Commit:

```bash
git add apps/web/src/features/auth/auth.types.ts apps/web/src/features/auth/auth.schema.ts apps/web/src/mocks/auth.ts apps/web/src/lib/auth/auth-client.ts
git commit -m "feat: add replaceable mock auth boundary"
```

---

### Task 2: Build the reusable auth shell and brand panel

**Files:**
- Create: `apps/web/src/app/layouts/auth-layout.tsx`
- Create: `apps/web/src/features/auth/components/auth-brand-panel.tsx`
- Create: `apps/web/src/features/auth/auth.css`

**Interfaces:**
- `AuthLayout({ children }: { children: React.ReactNode }): JSX.Element`.
- `AuthBrandPanel(): JSX.Element`.

- [ ] **Step 1: Add the auth layout component.**

Create `auth-layout.tsx` with a `<main className="auth-layout">` root, a top-right `<div className="auth-layout-tools"><ThemeToggle /></div>`, and a `<div className="auth-layout-grid">{children}</div>`. Import `ThemeToggle` from `components/shell/theme-toggle.tsx` and import `../../features/auth/auth.css` once from this layout. The layout must not import the auth client or navigation hooks.

- [ ] **Step 2: Add the brand panel.**

Create `auth-brand-panel.tsx` using PxlKit `PixelIconFrame` with `tone="cyan"`, `shape="square"`, and the existing cloud `AppIcon` as the icon. Render a semantic `<section className="auth-brand-panel" aria-labelledby="auth-brand-title">` containing:

```tsx
<h1 id="auth-brand-title">OpsGrid</h1>
<p>Cloud &amp; Data Center Observability Platform</p>
<ul aria-label="OpsGrid capabilities">
  <li>Monitor infrastructure.</li>
  <li>Detect incidents.</li>
  <li>Operate with confidence.</li>
</ul>
```

Keep grid decoration and icon treatment `aria-hidden` where decorative. Do not use a marketing CTA, hero image, emoji, or animation.

- [ ] **Step 3: Add scoped responsive auth styles.**

Create `auth.css` using existing `--cloudops-*`, `--retro-*`, and `--font-pixel` variables. Implement these concrete rules:

- `.auth-layout`: `min-height: 100vh`, `position: relative`, `display: grid`, desktop columns `minmax(20rem, .8fr) minmax(28rem, 1.2fr)`, page background and text tokens.
- `.auth-layout-grid`: `display: contents` on desktop so brand and form panels occupy the two columns; keep a single-column grid on mobile if needed.
- `.auth-layout-tools`: absolute top-right control with responsive inset and z-index above panels.
- `.auth-brand-panel`: `position: relative`, `display: flex`, `min-height: 100vh`, `align-items: center`, `padding: clamp(2rem, 7vw, 7rem)`, right border, surface token, and `overflow: hidden`.
- Add a low-opacity technical grid with a pseudo-element using token colors and fixed-size lines; no gradient glow, blur, or moving animation.
- `.auth-brand-panel h1`: use `var(--font-pixel)` sparingly, readable responsive size, and retro cyan accent.
- `.auth-brand-panel ul`: no bullets, 8/16/24 spacing rhythm, muted but contrast-safe text.
- `.auth-form-panel`: centered flex/grid container with `padding: clamp(1rem, 5vw, 5rem)` and `min-width: 0`.
- At `max-width: 900px`, make one column, reduce brand panel to a compact header with no full-height requirement, remove the right border, hide the decorative grid, and keep the theme toggle visible.
- At `max-width: 640px`, use 1rem horizontal gutters, make form controls full width, and ensure no horizontal overflow.

Use visible focus and contrast-safe tokens; do not add auth-specific light/dark token duplicates.

- [ ] **Step 4: Verify styles compile and commit.**

Run `pnpm --dir apps/web build`. Inspect the CSS diff for accidental dashboard selector changes. Commit:

```bash
git add apps/web/src/app/layouts/auth-layout.tsx apps/web/src/features/auth/components/auth-brand-panel.tsx apps/web/src/features/auth/auth.css
git commit -m "feat: add responsive OpsGrid auth shell"
```

---

### Task 3: Implement the login form and mock Google action

**Files:**
- Create: `apps/web/src/features/auth/components/google-login-button.tsx`
- Create: `apps/web/src/features/auth/components/login-form.tsx`

**Interfaces:**
- `GoogleLoginButton({ disabled, onError }: { disabled?: boolean; onError: (message: string) => void }): JSX.Element`.
- `LoginForm(): JSX.Element`.

- [ ] **Step 1: Implement the Google button.**

Create `google-login-button.tsx` with a small inline SVG Google `G` mark marked `aria-hidden="true"`. Render a full-width PxlKit `PixelButton` with `type="button"`, `variant="outline"`, `tone="neutral"`, `iconLeft={googleMark}`, and visible text `Continue with Google`.

Keep `loading` state local. On click, set loading, call `authClient.signInWithGoogle()`, navigate with `useNavigate()` to `/dashboard`, and call `onError("Google sign-in could not be completed. Please try again.")` in the catch branch. Always clear loading in `finally`. Pass `disabled || loading` to the button and use `loading={loading}` so duplicate activation is impossible.

- [ ] **Step 2: Implement form state and validation.**

Create `login-form.tsx` with controlled `email`, `password`, and `rememberMe` state; `touched` state for the two fields; `errors` state typed from the validator output; `formError`; and `isSubmitting`.

Create `useRef<HTMLInputElement | null>` refs for email and password. Implement:

```ts
const firstInvalidField = errors.email ? emailRef : passwordRef;
firstInvalidField.current?.focus();
```

after a failed submit. On blur, validate only the blurred field and mark it touched. On submit, mark both fields touched, call `validateCredentials`, render errors, focus the first invalid field, and return without calling the client when errors exist.

- [ ] **Step 3: Compose PxlKit fields and actions.**

Render a `PixelCard` with a form heading `Welcome back` and supporting text `Sign in to continue to OpsGrid.`. Inside a native `<form onSubmit={handleSubmit} noValidate>` render:

```tsx
<PixelInput
  ref={emailRef}
  id="login-email"
  label="Email"
  type="email"
  name="email"
  autoComplete="email"
  value={email}
  onChange={(event) => setEmail(event.target.value)}
  onBlur={() => handleBlur("email")}
  error={touched.email ? errors.email : undefined}
/>

<PixelPasswordInput
  ref={passwordRef}
  id="login-password"
  label="Password"
  name="password"
  autoComplete="current-password"
  value={password}
  onChange={(event) => setPassword(event.target.value)}
  onBlur={() => handleBlur("password")}
  error={touched.password ? errors.password : undefined}
  toggleLabels={["Show password", "Hide password"]}
/>

<PixelCheckbox
  id="login-remember"
  label="Remember me"
  checked={rememberMe}
  onChange={setRememberMe}
  tone="cyan"
/>
```

Render `Forgot password?` with `PixelTextLink` in button mode, `type="button"`, and a concise console message stating the flow is not implemented in Phase 1. It must not change location.

Render the primary action as:

```tsx
<PixelButton type="submit" fullWidth tone="cyan" loading={isSubmitting}>
  {isSubmitting ? "Signing in..." : "Sign in"}
</PixelButton>
```

While submitting, disable the checkbox and Google button. Render a form-level `role="alert"` message when validation fails or the client rejects. Keep the message concise and do not remove inline field errors.

- [ ] **Step 4: Wire password mock navigation.**

In `handleSubmit`, after successful `await authClient.signIn({ email, password, rememberMe })`, call `navigate("/dashboard")`. Set `isSubmitting` before the call and clear it in `finally`; catch errors into `formError` without clearing user input.

- [ ] **Step 5: Build and commit the form.**

Run `pnpm --dir apps/web build`. Confirm TypeScript accepts refs passed to both PxlKit inputs and no native anchor reload is introduced. Commit:

```bash
git add apps/web/src/features/auth/components/google-login-button.tsx apps/web/src/features/auth/components/login-form.tsx
git commit -m "feat: add mock OpsGrid login form"
```

---

### Task 4: Compose the login page and wire the `/login` route

**Files:**
- Create: `apps/web/src/features/auth/pages/login-page.tsx`
- Modify: `apps/web/src/app/router/router.tsx`

**Interfaces:**
- `LoginPage(): JSX.Element`.
- Existing `AppRouter()` continues to provide the router; `/login` is an outside-layout route.

- [ ] **Step 1: Compose `LoginPage`.**

Create `login-page.tsx` with no auth state or mock imports:

```tsx
export function LoginPage(): JSX.Element {
  return (
    <AuthLayout>
      <AuthBrandPanel />
      <LoginForm />
    </AuthLayout>
  );
}
```

- [ ] **Step 2: Add the route outside `AppLayout`.**

Import `LoginPage` in `router.tsx` and add `{ path: "/login", element: <LoginPage /> }` as a top-level route alongside the existing root redirect. Keep the existing `/dashboard` child under `AppLayout`, keep `/` redirecting to `/dashboard`, and keep the wildcard redirect unchanged.

- [ ] **Step 3: Run lint/build and commit route wiring.**

Run:

```bash
pnpm --dir apps/web lint
pnpm --dir apps/web build
```

Expect both commands to pass; the existing Vite chunk-size warning is non-blocking. Commit:

```bash
git add apps/web/src/features/auth/pages/login-page.tsx apps/web/src/app/router/router.tsx
git commit -m "feat: expose OpsGrid login route"
```

---

### Task 5: Verify login behavior, responsive layout, and dashboard regression

**Files:**
- Modify only if verification finds a concrete defect in the files from Tasks 1–4.
- Do not add test or smoke-test files.

- [ ] **Step 1: Start the existing Vite app from the current repository root.**

Run:

```bash
pnpm --dir apps/web dev -- --host 127.0.0.1 --port 5173
```

Use `http://127.0.0.1:5173/login` for React verification; `http://127.0.0.1:3080` is the DSH Web UI and is not the app preview.

- [ ] **Step 2: Verify desktop light theme.**

Open `/login` at a desktop viewport and confirm:

- document title/visible brand says OpsGrid;
- left brand panel and right login panel are distinct, with no glass blur or strong gradient;
- theme toggle is keyboard reachable and visibly labeled;
- email/password labels are visible and fields show PxlKit pixel borders/focus states;
- Remember me and Forgot password are present;
- primary Sign in is visually stronger than Google;
- `PixelDivider` separates the two auth methods;
- no dashboard sidebar/header appears on `/login`.

- [ ] **Step 3: Verify validation and keyboard behavior.**

Submit empty form and confirm required errors appear near both fields, the live form message is announced, and focus moves to email. Enter `bad-email` and a password, blur/submit, and confirm only the email format error remains. Tab through theme toggle, fields, password visibility, remember me, forgot-password action, Sign in, and Google button without focus disappearing.

- [ ] **Step 4: Verify password mock flow.**

Enter `admin@example.com` and `secret`, optionally check Remember me, submit, confirm the button shows `Signing in...` and is disabled during the delay, then confirm navigation to `/dashboard`. Confirm the existing dashboard still renders.

- [ ] **Step 5: Verify Google mock flow and deferred action.**

Return to `/login`, activate `Continue with Google`, confirm its loading/disabled state and navigation to `/dashboard`. Return to `/login`, activate `Forgot password?`, confirm no navigation/reload occurs.

- [ ] **Step 6: Verify dark mode and persistence.**

Toggle to dark mode, confirm brand/form text, borders, error states, and focus rings remain readable, refresh `/login`, and confirm dark mode persists. Toggle back to light mode and confirm the dashboard uses the same preference.

- [ ] **Step 7: Verify responsive behavior.**

Use a 375px viewport and a tablet-width viewport. Confirm the brand panel becomes compact/hidden as designed, the form remains full-width without horizontal scrolling, all actions remain reachable, and the theme toggle remains visible.

- [ ] **Step 8: Final repository verification and commit any concrete fixes.**

Run:

```bash
pnpm --dir apps/web lint
pnpm --dir apps/web build
git diff --check
git status --short
```

If verification required a fix, commit it with a focused `fix: ...` message. Do not claim completion until the final build and lint pass and the browser checks above are recorded.
