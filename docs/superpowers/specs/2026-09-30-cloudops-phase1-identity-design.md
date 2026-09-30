# CloudOps Phase 1 Identity, Organization & RBAC Design

## Status

Architecture approved in conversation for implementation planning. This document is the written specification for the Phase 1 full vertical slice. No implementation code is included in this document. Implementation must wait until the user reviews this specification and approves moving to the implementation-plan stage.

## Scope

Implement the Phase 1 identity foundation across the existing React/Vite frontend, NestJS API, Neon PostgreSQL database, Redis cache, and existing Cognito Terraform configuration.

In scope:

- NestJS 12 modular monolith with feature-first modules.
- Cognito custom-login BFF flow using `USER_PASSWORD_AUTH`.
- Conditional `SECRET_HASH` support for the confidential Cognito App Client.
- Cognito access-token verification with `aws-jwt-verify`.
- HttpOnly access and refresh cookies, plus the internal username cookie needed for confidential-client refresh hashing.
- Refresh, logout, and protected `/me` endpoints.
- Prisma schema, migrations, seed, and Neon PostgreSQL integration.
- `User`, `Organization`, `Membership`, and `Role` data model.
- Tenant-aware organization and membership authorization.
- Centralized `ADMIN`, `OPERATOR`, and `VIEWER` permission mapping.
- Redis cache for safe user, organization, membership, and permission metadata.
- Zod environment, body, parameter, and query validation.
- CORS, CSRF/origin protection, security headers, rate limiting, request IDs, and structured logging.
- Swagger, health checks, unit tests, and HTTP/e2e contract tests with external services mocked.
- React API client, TanStack Query server-state integration, session bootstrap, protected routes, and real organization/member data wiring.
- Vite development proxy for `/api` requests.
- Verification of the existing Cognito Terraform configuration; Terraform changes only when validation or provider compatibility identifies a concrete defect.

Out of scope:

- Hosted UI, Managed Login for username/password, SRP, `USER_SRP_AUTH`, `AdminInitiateAuth`, custom NestJS JWTs, Passport, `jsonwebtoken`, password hashing, or application password storage.
- Cognito Groups as tenant RBAC.
- Virtual machines, metrics, logs, traces, alerts, incidents, cloud connectors, Kubernetes, runbooks, workers, or AIOps.
- Redis-backed application sessions or storage of Cognito tokens in Redis.
- Full invitation, MFA, password-reset, or Cognito challenge UX.
- Zustand or another client-state library.
- Remote Terraform state, Secrets Manager, or new Phase 2 infrastructure.

## Existing repository baseline

The repository already contains:

- A React/Vite dashboard under `apps/web` with OpsGrid branding, a shell, theme support, and mock tenant data.
- A NestJS 12 starter under `apps/api` with no Phase 1 modules yet.
- Existing `@tanstack/react-query` in the web package, currently unused.
- Existing Cognito Terraform module and `dev/persistent/identity` root under `infra/terraform`.
- An ignored `apps/api/.env` containing `DATABASE_URL`, Cognito configuration, and `REDIS_URL`. Secret values must never be copied into this specification, source files, logs, test fixtures, or output.

The existing Terraform state and outputs are the baseline for the API configuration. The current App Client is confidential and has `generate_secret = true`, `ALLOW_USER_PASSWORD_AUTH`, and `ALLOW_REFRESH_TOKEN_AUTH`.

The existing `/` redirect to `/dashboard` and OpsGrid branding remain. A protected dashboard route may redirect unauthenticated users to `/login` after the existing root redirect.

## Architectural decisions

### Backend boundary

Use a modular monolith with feature-first modules:

```text
apps/api/
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts
└── src/
    ├── main.ts
    ├── app.module.ts
    ├── config/
    │   ├── app.config.ts
    │   ├── auth.config.ts
    │   ├── database.config.ts
    │   ├── redis.config.ts
    │   ├── env.schema.ts
    │   └── index.ts
    ├── common/
    │   ├── decorators/
    │   ├── filters/
    │   ├── guards/
    │   ├── interceptors/
    │   ├── pipes/
    │   ├── types/
    │   └── constants/
    ├── infrastructure/
    │   ├── database/prisma/
    │   ├── cache/
    │   └── aws/cognito/
    └── modules/
        ├── auth/
        ├── users/
        ├── organizations/
        ├── memberships/
        ├── authorization/
        └── health/
```

`AuthService` owns authentication business flow. The Cognito adapter owns AWS SDK calls, token verification, secret hashing, and Cognito exception translation. Controllers never call AWS SDK or Prisma directly.

`PrismaService` owns the database connection lifecycle. Because Prisma 7.10.0 requires a runtime driver adapter, it uses `@prisma/adapter-pg` with `pg` and the configured PostgreSQL/Neon `DATABASE_URL`. Repositories/services own queries. `RedisService` owns the Redis connection lifecycle; `CacheService` exposes a small application abstraction so feature modules do not depend on Redis client details.

The placeholder Observe configuration in the starter module must not run with fake credentials. Structured application logging uses Pino. The unused Observe dependency may be removed if no real Observe configuration is supplied.

### Authentication data flow

```text
React custom login form
  → POST /api/v1/auth/login
  → Zod login validation
  → AuthService
  → CognitoService.signInWithPassword
  → InitiateAuth(USER_PASSWORD_AUTH)
  → optional SECRET_HASH
  → verify access token and ID token
  → upsert User by cognitoSub
  → set HttpOnly cookies
  → safe user response
```

The API authorization credential is always the Cognito access token. The ID token is used only for verified identity claims such as `sub`, `email`, and `name` during synchronization. Neither token is returned in JSON or exposed to React.

A successful first login upserts a local `User` by `cognitoSub`. It never creates a membership or grants a role automatically. A user with no membership remains authenticated, and `/api/v1/me` returns an empty organization list.

### Confidential-client refresh detail

Cognito requires the username when calculating `SECRET_HASH` for a confidential App Client refresh request. Because the current User Pool uses email usernames, the API sets an additional internal HttpOnly `cognito_username` cookie after login when a client secret is configured. This cookie is not an access credential, is never readable by React, and is never returned in JSON. It allows the API to calculate the correct refresh `SECRET_HASH` without storing a session in Redis.

If the client has no secret, the API omits `SECRET_HASH` and does not require this cookie. If a confidential-client refresh request lacks the username cookie, the API returns a safe unauthorized error and clears auth cookies rather than guessing.

## Database design

Use Prisma with PostgreSQL UUID identifiers and a Prisma `Role` enum:

```prisma
enum Role {
  ADMIN
  OPERATOR
  VIEWER
}

model User {
  id          String       @id @default(uuid()) @db.Uuid
  cognitoSub  String       @unique
  email       String
  displayName String?
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  memberships Membership[]

  @@index([email])
}

model Organization {
  id          String       @id @default(uuid()) @db.Uuid
  name        String
  slug        String       @unique
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  memberships Membership[]
}

model Membership {
  id             String       @id @default(uuid()) @db.Uuid
  userId         String       @db.Uuid
  organizationId String       @db.Uuid
  role           Role
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt
  user           User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([userId, organizationId])
  @@index([userId])
  @@index([organizationId])
}
```

`email` is profile data and a secondary lookup value; it is not the immutable identity key. No password, Cognito token, client secret, or Redis URL is persisted in these models.

The migration creates all three tables and the enum. The seed creates the demo organization required for Phase 1. An optional `SEED_ADMIN_COGNITO_SUB` may assign `ADMIN` to an already synchronized local user; it never creates an admin solely because a user logged in. If the referenced user does not exist, the seed fails with an actionable message instructing the operator to complete one Cognito login and rerun the seed.

## API contract

### Authentication and session

```text
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
GET  /api/v1/me
```

`POST /auth/login` accepts:

```json
{
  "email": "admin@example.com",
  "password": "password"
}
```

It returns only safe application data:

```json
{
  "user": {
    "id": "user-id",
    "email": "admin@example.com",
    "displayName": "Admin User"
  }
}
```

`POST /auth/refresh` reads the refresh and internal username cookies. It calls `REFRESH_TOKEN_AUTH`, verifies the returned access token, replaces the access cookie, and replaces the refresh cookie only when Cognito returns a new refresh token. It never accepts a refresh token in the request body.

`POST /auth/logout` clears all auth cookies regardless of remote revoke success. Cognito refresh-token revocation is attempted best effort and failures are logged as redacted warnings.

`GET /me` returns:

```json
{
  "user": {
    "id": "user-id",
    "email": "admin@example.com",
    "displayName": "Admin User"
  },
  "organizations": [
    {
      "id": "organization-id",
      "name": "VNPT Cloud",
      "slug": "vnpt-cloud",
      "role": "ADMIN"
    }
  ]
}
```

There are no access tokens, refresh tokens, client secrets, or unnecessary raw Cognito claims in any response.

### Tenant resources

```text
GET    /api/v1/organizations/:organizationId
PATCH  /api/v1/organizations/:organizationId
GET    /api/v1/organizations/:organizationId/members
POST   /api/v1/organizations/:organizationId/members
PATCH  /api/v1/organizations/:organizationId/members/:userId
DELETE /api/v1/organizations/:organizationId/members/:userId
```

The membership create endpoint manages an already synchronized local user by `userId`; it is not an invitation or Cognito provisioning flow. All path parameters, query parameters, and request bodies use Zod schemas. The API returns safe user and membership metadata only.

Every tenant request executes this order:

```text
Cognito access-token guard
  → parse organizationId
  → resolve current local user
  → find Membership
  → evaluate permission
  → execute repository query
```

### Permissions

```text
ADMIN:
  profile.read
  organization.read
  organization.update
  member.read
  member.manage

OPERATOR:
  profile.read
  organization.read
  member.read

VIEWER:
  profile.read
  organization.read
  member.read
```

Permissions are declared centrally in `permissions.ts` and `role-permissions.ts`. Controllers use `@RequirePermissions(...)`; authorization logic does not spread `if (role === 'ADMIN')` checks throughout the codebase.

### Health and documentation

```text
GET /api/v1/health
GET /api/docs
```

Health is public and performs lightweight application, PostgreSQL, and Redis checks without exposing connection details. Swagger documents cookie-based authentication with `ApiCookieAuth`, not bearer-token storage in the browser.

## Cognito adapter

Use `@aws-sdk/client-cognito-identity-provider` with the default AWS SDK credential provider chain. Normal password login does not require static AWS access keys; no access-key variables are added to `.env.example`.

The adapter exposes business-safe methods equivalent to:

```ts
signInWithPassword(email: string, password: string)
refreshToken(refreshToken: string, username?: string)
verifyAccessToken(token: string)
verifyIdToken(token: string)
revokeToken(refreshToken: string)
```

`CognitoSecretHashService` calculates Base64-encoded HMAC-SHA256 over `username + clientId`, keyed by `COGNITO_CLIENT_SECRET`. It returns no hash when the client secret is absent. The login and refresh parameter builders add `SECRET_HASH` only when a configured secret exists.

`CognitoAuthGuard` reads the access cookie and verifies it with `aws-jwt-verify` using the configured user pool, client ID, issuer, expiration, signature, and `token_use = access`. It does not accept an ID token as the API authorization token.

Cognito exceptions are translated into application errors. Invalid credentials produce `AUTH_INVALID_CREDENTIALS`; refresh failures produce a safe unauthorized response. AWS exception names, request IDs, and stack traces never reach the client.

## Cookie, CSRF, and HTTP security

`AuthCookieService` is the single owner of cookie options and exposes:

```text
setAccessToken()
setRefreshToken()
clearAccessToken()
clearRefreshToken()
clearAuthCookies()
```

It also manages the internal username cookie required for confidential-client refresh hashing. Auth cookies are HttpOnly, use `Path=/`, use `Secure=false` only for local development, use `Secure=true` in production, and use configured `SameSite`/`MaxAge` values. Controllers and business services do not duplicate these options.

The API configures:

- CORS with the exact configured `WEB_URL` and `credentials: true`.
- No wildcard origin with credential cookies.
- `helmet` security headers.
- SameSite cookies plus strict `Origin`/`Referer` validation for unsafe requests. Requests from missing or disallowed origins are rejected in production; the local development origin is explicitly allowed.
- Request body redaction before logging or telemetry.
- Graceful shutdown for Prisma and Redis.

The frontend contract remains `fetch('/api/v1/...', { credentials: 'include' })`; React never reads auth cookies or Cognito tokens.

`@nestjs/throttler` protects login and refresh with route-specific limits and gives ordinary application routes a higher limit. It must not apply an extremely low global limit to every endpoint.

## Redis cache design

`REDIS_URL` is a runtime configuration value and is never logged or returned. Redis is a cache and coordination dependency, not an auth-token or session store.

Create:

```text
src/infrastructure/cache/redis.module.ts
src/infrastructure/cache/redis.service.ts
src/infrastructure/cache/cache.service.ts
```

Use the official `redis` Node client. The infrastructure module owns connect, health, and graceful quit. The feature-facing cache abstraction supports typed `get`, `set`, `delete`, and prefix invalidation.

Namespaced keys:

```text
cloudops:v1:me:{userId}
cloudops:v1:organization:{organizationId}
cloudops:v1:members:{organizationId}
cloudops:v1:membership:{userId}:{organizationId}
```

TTL policy:

- `/me`: approximately 30 seconds.
- Membership/permission lookups: approximately 60 seconds.
- Organization and member lists: approximately 30–60 seconds.

Cached values contain only safe user, organization, membership, and role metadata. Passwords, access tokens, refresh tokens, ID tokens, client secrets, database URLs, and Redis URLs are never cached.

Organization and membership mutations invalidate affected `me`, organization, member-list, and membership keys. A Redis outage falls back to PostgreSQL for authorization correctness and emits a redacted structured warning; it does not grant access based on stale or missing cache data.

Production Redis deployments should use TLS (`rediss://`) when required by the provider. The existing local environment value is not rewritten automatically by the design.

## Environment contract

Create `apps/api/.env.example` without real credentials:

```env
NODE_ENV=development
PORT=3000
WEB_URL=http://localhost:5173

DATABASE_URL=postgresql://user:password@host/database?sslmode=require
REDIS_URL=redis://default:password@localhost:6379

COGNITO_REGION=ap-southeast-1
COGNITO_USER_POOL_ID=replace-with-user-pool-id
COGNITO_CLIENT_ID=replace-with-client-id
# Required for the current confidential Terraform App Client.
COGNITO_CLIENT_SECRET=replace-with-client-secret

# Optional: assign ADMIN to an already synchronized local user during prisma seed.
# SEED_ADMIN_COGNITO_SUB=replace-with-cognito-sub
```

Zod validates required values, URLs, region/pool/client formats, and environment enum. `COGNITO_CLIENT_SECRET` remains optional at the schema level so a public App Client can be supported by the adapter; the current Terraform configuration requires it operationally because `generate_secret = true`. `REDIS_URL` is required for development and production runtime; unit tests override the Redis dependency.

The implementation may add `NODE_ENV=development`, `PORT=3000`, and `WEB_URL=http://localhost:5173` to the ignored local `apps/api/.env`. It must not overwrite existing database, Redis, Cognito client-secret, pool, client, or region values.

## React architecture

Use feature-first folders and create only directories that contain implementation files:

```text
apps/web/src/
├── app/
│   ├── layouts/
│   ├── providers/
│   └── router/
├── components/
│   ├── shell/
│   └── ui/
├── features/
│   ├── auth/
│   │   ├── api/
│   │   ├── components/
│   │   ├── hooks/
│   │   └── pages/
│   ├── dashboard/
│   │   ├── components/
│   │   └── pages/
│   ├── organizations/
│   │   ├── api/
│   │   ├── components/
│   │   └── hooks/
│   └── memberships/
│       ├── api/
│       ├── components/
│       └── hooks/
├── lib/
│   ├── api/
│   └── query/
└── types/
```

`@tanstack/react-query` is already installed and becomes the server-state layer. Add a `QueryClientProvider` to the existing provider composition. Use query keys `['me']`, `['organization', organizationId]`, and `['members', organizationId]`.

The shared HTTP client always uses `credentials: 'include'`, performs one refresh-and-retry after a 401, and then surfaces an authentication failure without infinite retries. Feature API modules call the shared client; components never call `fetch` directly.

The `TenantProvider` keeps only the selected organization ID in React state. The organization list comes from the `['me']` query. If the selected organization disappears, it selects the first available organization; if the list is empty, `currentOrganization` is null and the dashboard renders an explicit no-organization state rather than mock data.

The login page is public and remains the custom OpsGrid form. The dashboard and tenant routes are protected. `/` continues to redirect to `/dashboard`, and the protected route redirects unauthenticated users to `/login`. The Vite dev server proxies `/api` to `http://localhost:3000` so the frontend uses relative API URLs.

Replace runtime use of mock current-user, organization, and member data with API queries. Keep only UI-only mock content, such as the static getting-started checklist, when it has no backend source. Do not invent backend fields such as plan or environment if the Phase 1 API does not provide them.

Do not add Zustand. Local component state and small React context are sufficient for UI-only state; TanStack Query owns server state.

## Package changes

Add to `apps/api` runtime dependencies:

```text
@nestjs/config
@nestjs/swagger
@nestjs/throttler
@nestjs/terminus
@aws-sdk/client-cognito-identity-provider
aws-jwt-verify
@prisma/client
@prisma/adapter-pg
pg
zod
cookie-parser
helmet
redis
nestjs-pino
pino-http
```

Add to `apps/api` development dependencies:

```text
prisma
@types/cookie-parser
tsx
dotenv
@types/pg
```

Keep existing NestJS testing, Vitest, Supertest, TypeScript, Prettier, and Oxlint dependencies. Do not add Passport, JWT-signing, password-hashing, or static AWS credential packages. `@tanstack/react-query` needs no web package change.

Add these API package scripts so the documented commands are reproducible:

```text
typecheck
prisma:generate
prisma:migrate:dev
prisma:migrate:deploy
prisma:seed
```

The scripts must delegate to `tsc`, `prisma generate`, `prisma migrate dev`, `prisma migrate deploy`, and `prisma db seed` respectively.

## Testing and verification

Unit tests mock `CognitoService`, `PrismaService`, `CacheService`, and `RedisService`. No normal unit or e2e test calls AWS, Neon, or hosted Redis.

Required backend test areas:

- AuthService login, refresh, logout, first-login synchronization, and safe errors.
- CognitoService command parameters, conditional `SECRET_HASH`, refresh-token behavior, and revoke best effort.
- Cognito access/ID token verifier configuration.
- AuthCookieService options, set/clear behavior, and username-cookie handling.
- AuthorizationService, permission mapping, CognitoAuthGuard, and PermissionsGuard.
- User, organization, and membership services/repositories.
- Redis cache hit, miss, invalidation, and PostgreSQL fallback.
- Login, refresh, logout, `/me`, health, and tenant HTTP contracts.

Required frontend verification:

- Login form sends credentials to the API and never exposes tokens.
- Successful login loads `/me` and reaches dashboard.
- Expired access cookie refreshes once.
- Logout clears server session cookies and query cache.
- Empty organization response renders the no-organization state.
- Tenant switching and member queries use TanStack Query keys and invalidation.
- Light/dark theme, responsive layout, and dashboard regression remain intact.

Run:

```powershell
pnpm --dir apps/api build
pnpm --dir apps/api lint
pnpm --dir apps/api typecheck
pnpm --dir apps/api test
pnpm --dir apps/api test:e2e

pnpm --dir apps/web lint
pnpm --dir apps/web build

pnpm --dir apps/api prisma:generate
pnpm --dir apps/api prisma:migrate:deploy
terraform fmt -check -recursive infra/terraform
terraform -chdir=infra/terraform/environments/dev/persistent/identity validate
```

The typo-free implementation scripts must be added before executing these commands; the final report must show the exact commands and results. `prisma migrate deploy` and any real Cognito/Redis smoke test are only claimed when their actual command output succeeds with available credentials and network access.

## Terraform boundary

The existing Terraform module remains the source of Cognito App Client behavior. Before implementation completion:

- Confirm `generate_secret = true` for the current BFF client.
- Confirm `ALLOW_USER_PASSWORD_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH` are the only required explicit auth flows for this Phase 1 password/refresh path.
- Confirm pool ID, client ID, region, issuer, and client secret handoff match the API environment.
- Run Terraform formatting and validation.
- Modify Terraform only if provider validation or an explicit mismatch identifies a concrete issue.

Do not add Cognito Groups, static AWS access keys, secret outputs, remote state, or later-phase resources.

## Definition of done

The implementation is complete only when:

- The NestJS API, Prisma schema/migration, Redis cache, Cognito adapter, cookies, auth guards, authorization, health, Swagger, error filter, logging, CORS/CSRF, rate limiting, and tests are implemented.
- React custom login calls the NestJS API, uses HttpOnly cookies through `credentials: include`, loads `/me`, uses TanStack Query, protects dashboard routes, and displays real tenant/member data.
- Terraform validation confirms the existing Cognito configuration supports the required flow.
- No password, token, client secret, database URL, Redis URL, or static AWS access key is logged or committed.
- Build, lint, typecheck, unit tests, and e2e tests pass, with real external integration results reported separately and honestly.
- No Phase 2 feature is introduced.
