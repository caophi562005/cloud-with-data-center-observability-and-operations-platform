# OpsGrid API

## Description

OpsGrid's NestJS API manages Cognito authentication, organization-scoped authorization, VM inventory/enrollment and tenant-bound metrics queries. Production metrics use the portable backend contract below; deployment is managed separately through the project's ECS/Terraform configuration.

## Project setup

```bash
$ pnpm install
```

## Compile and run the project

```bash
# development
$ pnpm run start

# watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Run tests

```bash
# unit tests
$ pnpm run test

# e2e tests
$ pnpm run test:e2e

# test coverage
$ pnpm run test:cov
```

## Deployment

The project builds an immutable API image from [Dockerfile](<Dockerfile>) and deploys it through [the DEV/TEST Terraform root](<../../infra/terraform/environments/dev/test/main.tf>). Review a fresh full plan before an authorized rollout. Build/test success alone is not deployment evidence; the `nest deploy` template command is not the project's validated deployment path.

## Observability

The API uses structured redacted logging and reads VM metrics through its portable Prometheus query client. It does not register NestJS Observe or claim its tracing, alerting or SLA features. See the backend configuration and security contract below.

## Framework reference

[NestJS documentation](https://docs.nestjs.com) describes the underlying framework, not additional services installed in this project.

## Portable metrics backend (Phase 2)

This section describes the project metrics contract. Start with the commented query example in [API environment example](<.env.example>). Gateway write and optional CLI query configuration are described in the [ingest README](<../ingest/README.md>).

### Query configuration and authentication

Omit **all four** API query keys (`METRICS_QUERY_URL`, `METRICS_QUERY_AUTH_MODE`, `METRICS_USERNAME`, `METRICS_QUERY_TOKEN`) to disable metrics querying. Partial configuration is a startup validation error, not a silently disabled client. An empty query URL is invalid; do not copy the CLI's blank optional query keys into the API. A blank mode alone defaults to Basic and does not enable querying, but a nonblank mode or supplied credential requires a valid URL and the selected mode's required fields.

Both `METRICS_QUERY_AUTH_MODE` and Gateway `METRICS_WRITE_AUTH_MODE` accept `none`, `basic`, or `bearer`. Only modes are trimmed/lowercased; absent or whitespace-only mode means **Basic**, never none. Unsupported explicit modes fail validation.

| Selected mode | Required credentials for that direction | Outbound Authorization |
| --- | --- | --- |
| `none` | None; URL and explicit mode still required | No header; stale username/tokens are ignored and excluded from selected auth |
| `basic` | `METRICS_USERNAME` and that direction's token | Basic username/token-as-password |
| `bearer` | That direction's token; username ignored | Bearer token |

Query uses only `METRICS_QUERY_TOKEN`; write uses only `METRICS_WRITE_TOKEN`. Neither falls back to the other, and read/write modes are independent. Use read-scoped and write-scoped credentials respectively. The single shared `METRICS_USERNAME` means the optional CLI cannot represent two different Basic usernames at once; separately deployed API/Gateway processes can inject different usernames.

Basic usernames must be nonblank, without `:` or ASCII controls. The API trims its Basic username and rejects empty tokens, surrounding token whitespace and ASCII controls. Go preserves otherwise accepted Basic credential bytes (nonblank, no ASCII controls); it does not repair them. Bearer tokens must be nonblank printable ASCII without whitespace or controls. None validates neither stale credential; Bearer ignores stale usernames. Never log configuration, credential values/headers, complete upstream URLs, PromQL or raw upstream errors/bodies.

### URLs, transport and backend selection

- `METRICS_QUERY_URL` is a Prometheus **base**, not an exact `/api/v1/query` endpoint. The API appends `/api/v1/query` or `/api/v1/query_range`, retaining base prefixes/escaped paths. The optional CLI alone also accepts an exact instant-query endpoint, including trailing slashes.
- `METRICS_WRITE_URL` is the **exact** Remote Write receiver URL and is never rewritten. Existing Go write query strings are retained; API/CLI query URLs reject query strings. All metrics URLs reject embedded credentials and fragments.
- Use HTTPS with certificate verification. Plain HTTP is allowed only for `localhost` or a literal loopback address such as `127.0.0.1` or `[::1]`; plaintext Docker DNS names and arbitrary hosts are not allowed. Never disable TLS verification to make a recipe work. Redirects are not followed on either direction.
- Select a backend via URL/mode/credentials, then restart the process with the matching configuration. This is not hot reload. An older image does not gain these modes through environment changes; use an immutable compatible build and the appropriate deployment approval. The recipes below are configuration examples, not rollout evidence.
- The backend or trusted reverse proxy must expose the Prometheus query API and accept Remote Write; a vanilla Prometheus deployment needs its Remote Write receiver enabled. A configured URL is not evidence of a working backend.

API transport retains its 5,000 ms total deadline, 2,000,000-byte response ceiling, series/sample caps, success-only cache/singleflight and existing DTO/status contracts. Backend selection does not bypass tenant/active-agent authorization, trusted-label normalization, payload limits or rate limiting. Only already normalized Gateway bytes are forwarded unchanged; upstream 2xx is an accepted write, not proof of query visibility or tenant isolation.

### Backend recipes — choose one, replace the previous selection

All values are placeholders, not verified deployments. Each independent block shows API query keys plus Gateway write keys (also usable by the optional CLI). Inject only the appropriate direction into each service; do **not** combine recipes or add unused Basic credentials to a query-disabled API. None ignores leftover credentials, but clear unused secrets operationally.

#### Grafana Cloud — Basic

```dotenv
METRICS_QUERY_URL=https://YOUR-GRAFANA-METRICS-HOST/api/prom
METRICS_QUERY_AUTH_MODE=basic
METRICS_WRITE_URL=https://YOUR-GRAFANA-METRICS-HOST/api/prom/push
METRICS_WRITE_AUTH_MODE=basic
METRICS_USERNAME=YOUR_METRICS_TENANT_ID
METRICS_QUERY_TOKEN=YOUR_READ_ACCESS_POLICY_TOKEN
METRICS_WRITE_TOKEN=YOUR_WRITE_ACCESS_POLICY_TOKEN
```

Existing complete configurations without either mode variable remain Basic.

#### AMP — same-task localhost SigV4 proxy, application auth none

```dotenv
METRICS_QUERY_URL=http://127.0.0.1:8005/workspaces/ws-xxxxxxxx
METRICS_QUERY_AUTH_MODE=none
METRICS_WRITE_URL=http://127.0.0.1:8005/workspaces/ws-xxxxxxxx/api/v1/remote_write
METRICS_WRITE_AUTH_MODE=none
```

No application username, token, AWS key, signing service or metrics region is required. The application sends unsigned localhost requests; only the proxy signs the HTTPS request to AMP. Direct unsigned requests to AMP do not become authorized through `none`. This recipe requires the deferred integration checklist below.

#### HTTPS self-hosted — none

```dotenv
METRICS_QUERY_URL=https://prometheus.internal
METRICS_QUERY_AUTH_MODE=none
METRICS_WRITE_URL=https://prometheus.internal/api/v1/write
METRICS_WRITE_AUTH_MODE=none
```

Use only an appropriately protected/trusted backend. None removes application Authorization; it does not replace network access control or tenancy checks.

#### HTTPS self-hosted — Basic reverse proxy

```dotenv
METRICS_QUERY_URL=https://metrics.internal/prometheus
METRICS_QUERY_AUTH_MODE=basic
METRICS_WRITE_URL=https://metrics.internal/prometheus/api/v1/write
METRICS_WRITE_AUTH_MODE=basic
METRICS_USERNAME=YOUR_PROXY_USERNAME
METRICS_QUERY_TOKEN=YOUR_PROXY_READ_PASSWORD
METRICS_WRITE_TOKEN=YOUR_PROXY_WRITE_PASSWORD
```

The proxy must actually accept the configured username and independent passwords; do not assume a Grafana access-policy token works elsewhere.

#### HTTPS self-hosted — Bearer reverse proxy

```dotenv
METRICS_QUERY_URL=https://metrics.internal/prometheus
METRICS_QUERY_AUTH_MODE=bearer
METRICS_WRITE_URL=https://metrics.internal/prometheus/api/v1/write
METRICS_WRITE_AUTH_MODE=bearer
METRICS_QUERY_TOKEN=YOUR_PROXY_READ_BEARER_TOKEN
METRICS_WRITE_TOKEN=YOUR_PROXY_WRITE_BEARER_TOKEN
```

No username is required. Mixed write/query modes are also supported, with independent tokens.

<a id="deferred-devtest-amp-sidecar-checklist"></a>

### DEV/TEST AMP sidecar contract

AMP wiring now exists in the [shared proxy module](<../../infra/terraform/modules/ecs-amp-proxy/main.tf>), [API module](<../../infra/terraform/modules/ecs-api/main.tf>) and [Gateway module](<../../infra/terraform/modules/ecs-ingest/main.tf>). The [dated Rules rollout receipt](<../../.superpowers/sdd/2026-10-11-alert-rules/backend-live-verified.json>) records a deployed configuration, not a fresh check performed by this documentation update. The following requirements remain applicable to later rollouts.

- Colocate a loopback proxy in **each** API or Gateway Fargate task that calls AMP. Same-task containers share localhost; an API task cannot use a proxy in a separate Gateway task.
- Fix the upstream to the actual AMP workspace host, region and signing service `aps`; for example host `aps-workspaces.ap-southeast-1.amazonaws.com`, region `ap-southeast-1`. Preserve `/workspaces/<id>/api/v1/...` paths and verified upstream HTTPS. No application-side Host override or AWS signing/credential discovery is added.
- Use **TaskRole, not merely ExecutionRole**. Scope `aps:QueryMetrics` for query tasks and `aps:RemoteWrite` for write tasks to the intended workspace. The protected Rules API additionally needs `aps:ListRules` on that same workspace. Do not grant unrelated series/labels/metadata APIs. ECS temporary credentials are discovered/refreshed by the proxy only; no static keys in application config. IAM privileges are task-wide, not a sidecar-only security boundary.
- Bind only to localhost, never an ALB/public ingress port. Keep TLS verification; disable verbose signing/failed-body logging and do not use unsigned-payload mode.
- Keep the immutable proxy digest and source-verified arguments (`--port 127.0.0.1:8005`, `--host`, `--region`, `--name aps`, `--upstream-url-scheme https`). [Proxy research](<../../.superpowers/sdd/2026-10-08-amp-wiring/proxy-research.md>) records provenance and upstream limitations; it does not validate arbitrary future image substitutions.
- Separately authorize and validate task lifecycle/startup/readiness, DNS/egress/networking, resource budgets, credential refresh and upstream failure/status propagation. Signing failure must not become a false write ACK. `START` dependency ordering alone is not readiness or recovery proof.

Official references for continued verification: [AWS SigV4 Proxy](https://github.com/awslabs/aws-sigv4-proxy), [proxy flags source](https://github.com/awslabs/aws-sigv4-proxy/blob/master/cmd/aws-sigv4-proxy/main.go), [AMP APIs/signing](https://docs.aws.amazon.com/prometheus/latest/userguide/AMP-compatible-APIs.html), [ECS Task Role](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html), [Fargate networking](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html).

### Evidence boundaries

The recorded [API checkpoint](<../../.superpowers/sdd/2026-10-08-portable-metrics-backend/final-api-verification-checkpoint.md>) reports 596 unit tests across 50 files plus 11 VM metrics e2e tests passed; typecheck/build exited 0. Whole-API formatting **failed** on 80 unchanged baseline warnings and an unmatched Prisma glob; feature-scoped formatting passed. No broad unrelated formatting is implied.

The [Go runtime checkpoint](<../../.superpowers/sdd/2026-10-08-portable-metrics-backend/final-go-runtime-checkpoint.md>) reports eight non-smoke packages with 77 top-level/394 subtest pass events (grouping events, not 471 independent cases). The [static checkpoint](<../../.superpowers/sdd/2026-10-08-portable-metrics-backend/final-go-static-checkpoint.md>) records all-package compile-only, vet and builds, not smoke passes. **All smoke/CLI/image bodies were NOT RUN; binaries were never executed.** The [Task6 review](<../../.superpowers/sdd/2026-10-08-portable-metrics-backend/task-6-review.md>) is static approval only. These are prior receipts, not checks rerun by this documentation task and not AWS/deployment verification. Manual documentation/source consistency replaces executable RED here; existing style execution is left to parent Task8.
