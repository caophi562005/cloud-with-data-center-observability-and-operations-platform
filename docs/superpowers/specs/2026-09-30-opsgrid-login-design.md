# OpsGrid Login Design

## Status

Approved in conversation on 2026-09-30 for implementation planning. This design covers only the Phase 1 `/login` page and its mock authentication boundary.

## Scope and decisions

- Add a production-style `/login` route for the existing React/Vite/TypeScript app.
- Keep `/` redirecting to `/dashboard`; do not add a global auth guard in this task.
- Use the current product brand **OpsGrid** with the subtitle `Cloud & Data Center Observability Platform`.
- Use mock authentication only. Any syntactically valid email with a non-empty password succeeds after a short async delay; no hard-coded demo credentials.
- A successful password or Google mock login navigates to `/dashboard`.
- Keep the existing PxlKit `pixel` surface and reuse the existing theme system and `ThemeToggle`.
- Do not add Cognito, OAuth, AWS SDKs, OAuth libraries, a form library, or a second UI kit.
- Do not implement registration, invitations, MFA, password reset, organization selection, RBAC, or backend calls.

## Design direction

Use a split authentication shell rather than a marketing landing page:

- Desktop: a restrained brand panel on the left and a focused form panel on the right, approximately 40/60 in available width.
- The brand panel uses the existing OpsGrid retro/technical tokens, a PxlKit `PixelIconFrame` around the existing cloud icon, short product copy, and a very subtle technical grid decoration. No large gradients, glass blur, animated background, or dense pixel-art treatment.
- The form panel is vertically centered, has a comfortable maximum width of roughly 28–32rem, and contains a PxlKit `PixelCard` or equivalent surface with clear heading hierarchy.
- The theme toggle is placed in the top-right of the authentication shell and reuses `components/shell/theme-toggle.tsx` directly.
- The form remains readable in both light and dark themes. Body copy uses the existing monospace body token; display accents can use the already bundled Press Start 2P font sparingly.
- On mobile, the brand panel becomes a compact top header with the OpsGrid mark and a shortened subtitle; the full left panel decoration is hidden. The form becomes full-width with responsive gutters and no horizontal scrolling.

Brand copy:

```text
OpsGrid
Cloud & Data Center Observability Platform

Monitor infrastructure.
Detect incidents.
Operate with confidence.
```

Form copy:

```text
Welcome back
Sign in to continue to OpsGrid.
Email
Password
Remember me
Forgot password?
Sign in
OR CONTINUE WITH
Continue with Google
```

## Architecture

The existing `AppProviders` remains the single provider boundary. The existing `ThemeProvider` and `useTheme` continue to own light/dark mode and localStorage persistence. The new route is outside `AppLayout` so the dashboard sidebar and header never render on the login page.

The router will add a `/login` route rendering `LoginPage`. The existing `/` redirect to `/dashboard` and the existing wildcard redirect remain unchanged.

`LoginPage` composes the page-level pieces:

```tsx
<AuthLayout>
  <AuthBrandPanel />
  <LoginForm />
</AuthLayout>
```

`AuthLayout` owns only authentication-page layout, responsive behavior, theme-toggle placement, and the page landmark. It does not know about credentials or navigation outcomes. It accepts children so future forgot-password and reset-password pages can reuse the shell.

## Components and responsibilities

### `src/app/layouts/auth-layout.tsx`

- Render the authentication shell and responsive two-column structure.
- Render the shared `ThemeToggle`.
- Provide the main landmark and class hooks for auth-specific styling.
- Do not contain form state or auth calls.

### `src/features/auth/components/auth-brand-panel.tsx`

- Render the OpsGrid mark using `PixelIconFrame` and the existing cloud `AppIcon`.
- Render the short product descriptor and three-line value statement.
- Keep decorative elements `aria-hidden` and non-interactive.

### `src/features/auth/components/login-form.tsx`

- Own email, password, remember-me, touched-field, validation, loading, and submit state.
- Render semantic `<form onSubmit>` with PxlKit `PixelInput`, `PixelPasswordInput`, `PixelCheckbox`, `PixelButton`, `PixelDivider`, and `PixelTextLink`.
- Set `autocomplete="email"` and `autocomplete="current-password"`.
- Call the auth client for password sign-in and navigate to `/dashboard` after success.
- Render inline validation messages and a live form-level status/error message.
- Move focus to the first invalid field on submit.
- Render `Forgot password?` as a clearly styled, keyboard-accessible deferred action that does not create a reset-password route in this task.

### `src/features/auth/components/google-login-button.tsx`

- Render a secondary PxlKit `PixelButton` using `variant="outline"` or an equivalent lower-emphasis variant.
- Include a small inline Google `G` mark as a decorative icon beside the visible `Continue with Google` label; the label remains the accessible name.
- Call the auth client's mock `signInWithGoogle`, show loading/disabled state, and navigate to `/dashboard` on success.
- Do not load a Google SDK or start an OAuth flow.

### `src/features/auth/pages/login-page.tsx`

- Compose `AuthLayout`, `AuthBrandPanel`, and `LoginForm`.
- Contain no credential validation or mock implementation.

### `src/features/auth/auth.types.ts`

Define the small future-compatible boundary types:

```ts
export type SignInInput = {
  email: string;
  password: string;
  rememberMe: boolean;
};

export type AuthUser = {
  email: string;
  provider: "password" | "google";
};

export interface AuthClient {
  signIn(input: SignInInput): Promise<AuthUser>;
  signInWithGoogle(): Promise<AuthUser>;
  signOut(): Promise<void>;
}
```

The interface is intentionally small; it is not a repository or state-management layer.

### `src/features/auth/auth.schema.ts`

- Export pure validators for email and password.
- Return field-level error strings used by the form.
- Require a non-empty email with a conventional email shape and a non-empty password.
- Avoid adding a schema dependency.

### `src/lib/auth/auth-client.ts`

- Export the app-facing `authClient` typed as `AuthClient`.
- Keep the concrete implementation replaceable; the UI imports this boundary rather than importing mock functions directly.
- For this task, wire it to the mock implementation from `src/mocks/auth.ts`.

### `src/mocks/auth.ts`

- Implement the `AuthClient` methods with a short deterministic async delay.
- Accept any validated password sign-in input and return an `AuthUser` with provider `password`.
- Return an `AuthUser` with provider `google` for `signInWithGoogle`.
- Resolve `signOut` without backend calls.

### `src/features/auth/auth.css`

Keep login-only layout rules isolated from the existing dashboard shell styles. Use existing semantic `retro-*` tokens, responsive breakpoints, and the PxlKit surface language. Do not add a second theme token set.

## Data and interaction flow

### Password sign-in

1. User fills email and password.
2. `PixelInput`/`PixelPasswordInput` expose semantic labels and field state.
3. On blur, the form validates the changed field.
4. On submit, the form validates both fields. If invalid, it retains values, renders inline errors, announces the summary, and focuses the first invalid input.
5. If valid, the form disables its controls, changes the primary action to `Signing in...`, and calls `authClient.signIn({ email, password, rememberMe })`.
6. The mock resolves, the loading state clears, and the form navigates to `/dashboard`.

### Google mock sign-in

1. User activates `Continue with Google`.
2. The button enters a loading/disabled state.
3. `authClient.signInWithGoogle()` resolves after the same short mock delay.
4. The form navigates to `/dashboard`.

### Deferred actions

`Forgot password?` remains visible for the intended product flow but does not navigate to an unimplemented route. It may report a concise console message for development feedback; it must not look like a broken anchor or trigger a page reload.

## Validation and error handling

- Required and format errors are displayed below their associated field.
- Each field must expose `aria-invalid` and `aria-describedby` through the PxlKit field component.
- A compact form-level `role="alert"`/live status communicates that fields need attention without replacing inline errors.
- Validation runs on blur for visited fields and on submit for all fields; it does not aggressively validate every keystroke.
- Mock auth is deterministic and is not expected to return credential errors. A defensive catch still restores controls and displays a generic retry message if the mock boundary rejects.
- Loading prevents duplicate submits and keeps the primary button width stable through PxlKit's loading behavior.

## Accessibility and responsive requirements

- Use native `<form>`, `<label>` association supplied by PxlKit, and real buttons.
- Keep a logical keyboard order: theme toggle, email, password visibility control, remember me, forgot-password action, sign-in, Google sign-in.
- Preserve visible focus rings in both themes; do not remove PxlKit focus styles.
- Use `autocomplete="email"` and `autocomplete="current-password"`.
- Decorative icons and grid ornaments are `aria-hidden`; visible action labels remain text.
- Maintain at least 4.5:1 normal-text contrast in both themes and visible 2px-class focus treatment.
- The mobile layout targets 375px without horizontal overflow; tablet collapses the brand panel before the form becomes cramped.
- The theme toggle must use the existing `useTheme`/`ThemeToggle` path so preference persistence remains shared with `/dashboard`.
- Avoid distracting animation; honor PxlKit reduced-motion behavior and use no auth-page animation beyond existing button/input feedback.

## Verification plan

No automated test or smoke-test files will be added, per the project constraint. Verification will use:

- `pnpm --dir apps/web lint`
- `pnpm --dir apps/web build`
- Browser checks at `/login` for desktop and a 375px viewport.
- Light and dark mode checks, including refresh persistence.
- Empty submit and malformed-email validation checks.
- Password visibility toggle, remember-me state, loading text/disabled state, mock navigation, Google mock navigation, keyboard focus order, and no horizontal overflow.
- Regression check that `/` still redirects to `/dashboard` and the existing dashboard remains unchanged.

## Cognito extension point

The login UI depends only on `AuthClient`. A later task can replace the `authClient` implementation in `src/lib/auth/auth-client.ts` with a Cognito adapter that maps password sign-in, managed Google sign-in, callback handling, token persistence, and sign-out to the same interface. No login component or page layout should need to change for that adapter swap.
