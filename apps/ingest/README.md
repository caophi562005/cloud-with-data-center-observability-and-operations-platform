# OpsGrid Ingestion Gateway — Phase 2

Go data-plane service; it **does not store metrics**. Requires Go 1.27.1 or newer.

```text
Alloy VM → HTTPS/Bearer AGT → Gateway → selected none/Basic/Bearer → metrics backend
                              ├─ Redis: auth metadata cache only
                              └─ Neon/PostgreSQL: control-plane source of truth
```

## Configuration and local run

From `apps/ingest`, copy the [environment example](<.env.example>) to a local dotenv file and supply only the selected mode's private credentials.
Local dotenv loading is optional, git-ignored, and never overrides existing environment variables.
Production/container environments should inject environment variables or secrets directly;
no dotenv file is required or baked into the image. Never commit credentials.

Required for the gateway: `DATABASE_URL`, `REDIS_URL`, `METRICS_WRITE_URL`, and
credentials required by `METRICS_WRITE_AUTH_MODE`. Modes are `none|basic|bearer`;
only the mode is trimmed/lowercased. Absent/whitespace-only defaults to **Basic**;
unsupported explicit values fail startup validation, never silently select none.

| Write mode | Required credentials | Outbound Authorization |
| --- | --- | --- |
| `basic` | `METRICS_USERNAME` + `METRICS_WRITE_TOKEN` | Basic, token as password (Grafana uses its Metrics tenant username) |
| `bearer` | `METRICS_WRITE_TOKEN` only; username ignored | Bearer token |
| `none` | None; stale username/token ignored and discarded | No header |

Basic username must be nonblank without colon or ASCII controls; Basic token must
be nonblank without ASCII controls. Go preserves otherwise accepted Basic bytes,
including surrounding spaces; it does not trim/repair credentials. The API trims
Basic usernames and rejects surrounding token whitespace. Bearer tokens in either
client must be printable ASCII without whitespace/controls. Read/write tokens and
modes are independent, with no token fallback. Optional query configuration is
consumed only by the CLI, never by Gateway startup/writes.

`METRICS_WRITE_URL` is exact, never rewritten; existing write query strings survive.
All metrics URLs reject userinfo/fragments. Use HTTPS with certificate verification,
or HTTP only on `localhost`/literal loopback (e.g. `127.0.0.1`, `[::1]`), including
same-task sidecars. Plaintext Docker DNS names are not allowed. No redirects or TLS
verification bypass. Change backend configuration then restart; no hot reload.

Choose one of the separate [Grafana Basic, AMP localhost none, or HTTPS self-hosted none/Basic/Bearer recipes](<../api/README.md#backend-recipes--choose-one-replace-the-previous-selection>),
replacing the old selection rather than activating multiple recipes. The receiver
and query APIs must actually be enabled (including a vanilla Prometheus Remote Write
receiver). AMP requires a signing proxy, not unsigned application requests directly
to AMP. The [DEV/TEST sidecar contract](<../api/README.md#devtest-amp-sidecar-contract>)
covers one proxy per API/Gateway task, scoped TaskRole, temporary credentials discovered
by the proxy, fixed AMP host/region/service `aps`, TLS, logging, exposure, pinned flags,
lifecycle, resources and status propagation. [Terraform wiring](<../../infra/terraform/modules/ecs-ingest/main.tf>)
and [dated live deployment evidence](<../../.superpowers/sdd/2026-10-11-alert-rules/backend-live-verified.json>)
now exist; this documentation cleanup does not rerun deployment or prove a future configuration safe.

Use TLS connection URLs for Neon and hosted Redis; prefer a read-only DB role.
The gateway also sets PostgreSQL `default_transaction_read_only=on`.

| Optional setting | Default |
| --- | --- |
| `PORT` / `LOG_LEVEL` | `8080` / `info` |
| `AGENT_AUTH_CACHE_TTL_SECONDS` | `60` (1–3600) |
| `REMOTE_WRITE_TIMEOUT_SECONDS` | `10` (1–120) |
| `REMOTE_WRITE_MAX_BODY_BYTES` | `10485760` (maximum 64 MiB) |
| `RATE_LIMIT_REQUESTS_PER_SECOND` | `5` (0.001–10000) |
| `RATE_LIMIT_BURST` | `20` (1–100000) |

```sh
go run ./cmd/ingest
```

Terminate with SIGINT/SIGTERM: stop accepting traffic, drain for up to 15 seconds,
then close HTTP connections, Redis, PostgreSQL pool, and upstream idle connections.
Pool: maximum 8 connections; startup DB ping required; Redis outage is non-fatal.
Bind locally with care: public deployments must terminate **HTTPS** before the gateway.

## HTTP contract

- `GET /health`: process liveness, 200; no dependency lookup.
- `GET /ready`: PostgreSQL ping with a 2-second deadline, 200 or 503. Upstream config
  is validated on startup; readiness does not perform metrics backend writes/probes.
- `POST /api/v1/write`: Alloy Remote Write URL, e.g. `https://INGEST_HOST/api/v1/write`.
  Requires `Authorization: Bearer AGT_...`, `Content-Type: application/x-protobuf`,
  `Content-Encoding: snappy`; Remote Write v1 (`0.1.0`). v2 is not accepted.
- Every response has a safe reused/generated `X-Request-ID`; structured JSON logs.

The **complete unchanged UTF-8 AGT** is hashed once with SHA-256 to lowercase hex,
matching NestJS `SecretService`. Lookup uses quoted Prisma tables `"Agent"`, `"Vm"`,
`"Organization"` and **`"Agent"."credentialHash"`**, NOT enrollment `tokenHash`.
JOIN requires the agent's VM and organization to exist and organization IDs to agree.
Only `ACTIVE` agent credentials are accepted; VM `DISCONNECTED` is not revocation.
Missing/invalid/revoked/inactive credentials all receive generic 401.

Redis key: `opsgrid:agent-auth:<sha256-hex>`, JSON agentId/vmId/organizationId/status.
Miss/read/write failure falls back to Neon; cache operations are bounded to 250 ms,
DB auth lookup to 3 seconds. A cold Redis startup ping has a 5-second budget for
DNS/TLS/authentication; failure still allows DB fallback. Revocation or mapping changes may take **up to cache TTL**
to take effect; do not share cache namespaces with untrusted writers.
Redis never caches metrics. There are no database writes in this service.

Each series has client `agent_id`, `vm_id`, `organization_id` labels removed, including
all duplicates, then replaced with authenticated metadata and sorted. Metric name and
other valid labels are preserved. Structural checks reject missing names/data, invalid
legacy Prometheus label names and duplicate non-trusted labels; native histograms and
exemplars are preserved. Compressed, Snappy-decoded and normalized protobuf sizes are
bounded. A pre-decode allocation guard limits each request to 10,000 series, 100 labels
per series/exemplar, 200,000 nested records and 1,000,000 scalar fields/bucket values;
violations return 413 before generated protobuf slice allocations.

Rate limiting is per **agent ID**, not IP: in-process token buckets with idle cleanup.
Replicas do not share limits. Forwarding is synchronous with a reused timeout-bound
HTTP client, selected upstream auth and Remote Write headers (`0.1.0`,
`User-Agent: opsgrid-ingest/1`). Default timeout is 10 seconds (1–120), connection cap
64 and response drain 16 KiB. Redirects are never followed.
Alloy owns WAL/retry; configure Alloy `retry_on_http_429 = true` for rate-limit retries.

| Status | Meaning |
| --- | --- |
| 204 | Selected metrics upstream returned 2xx; write accepted, not query visibility |
| 400 | Invalid protocol/payload/series, or upstream 400 |
| 401 | Invalid/inactive credential |
| 413 | Compressed/decoded body too large, or upstream 413 |
| 422 | Upstream rejected metric semantics |
| 429 | Per-agent or upstream rate limit (`Retry-After`) |
| 502 | Upstream network/timeout/5xx/redirect/auth/config failure; no false ACK |
| 503 | Authentication dependency unavailable; readiness dependency failure |

No raw credentials, URL-bearing dependency errors, Authorization headers, metric
payloads or upstream response bodies are logged or returned.

## Tests and container

The following are reference commands from `apps/ingest`, **not executions by this
documentation task**. Runtime regression selection explicitly excludes smoke/CLI/image
packages; full `go test ./...` or race `./...` would include their prohibited bodies.
Do not execute those suites under the current no-smoke authorization.

```sh
# Eight NON-SMOKE packages only
GOPROXY=off GOTOOLCHAIN=local go test -count=1 ./internal/auth ./internal/cache ./internal/config ./internal/ratelimit ./internal/remotewrite ./internal/repository/postgres ./internal/server ./internal/upstream
# Compile all packages, zero test bodies; NOT smoke runtime verification
GOPROXY=off GOTOOLCHAIN=local go test -count=1 -run '^$' ./...
go vet ./...
gofmt -l . # read-only; no broad autofix
go build -o /YOUR/PRIVATE/OUTPUT/ingest ./cmd/ingest
```

Prior [non-smoke runtime evidence](<../../.superpowers/sdd/2026-10-08-portable-metrics-backend/final-go-runtime-checkpoint.md>)
records 77 top-level/394 subtest pass events across those eight packages (including
grouping nodes, not 471 independent cases). The [static/build receipt](<../../.superpowers/sdd/2026-10-08-portable-metrics-backend/final-go-static-checkpoint.md>)
records compile-only exit 0: 11 packages `[no tests to run]`, one `[no test files]`,
zero bodies executed; vet/build exited 0 and built binaries were **never executed**.
All smoke/CLI/image bodies remain **NOT RUN**, not runtime passes. Race was not run
(`CGO_ENABLED=0` with no supported C compiler); no dependency installation
or module/lockfile change is authorized. Existing style execution belongs to parent
Task8; no new documentation validator is required.

Container build/run/publish/redeployment are prospective, separately authorized work,
not verification performed here. Multi-stage static binary, minimal CA-enabled
non-root runtime; Docker `EXPOSE` is 8080. If overriding `PORT`, adjust the mapping.
Unit tests use doubles and local HTTP/TCP fixtures, not live dependencies or a
writable production database.

### Test the published container image (Windows/Docker Desktop)

The [image smoke runner](<tests/image-smoke/run.ps1>) is intended to test
the **exact published digest**, not a rebuilt gateway binary. **NOT RUN for this
implementation: image/smoke bodies and image/network writes are prohibited.** The
command below is only a future operator reference after separate authorization;
none of its coverage is claimed as measured here. It requires Docker, Go and the
`postgres:17-alpine`, `redis:7-alpine`, `golang:1.27.1` fixture images.

```powershell
./tests/image-smoke/run.ps1
```

The runner compiles only the [fixture/client](<tests/image-smoke/main.go>), creates
uniquely labelled disposable containers and a dedicated bridge, and binds test
ports only to `127.0.0.1`. A shared network namespace provides a truly loopback
mock Remote Write endpoint. It never reads the production dotenv file or real
AGT/Grafana/DB/Redis credentials. Synthetic credentials and minimal contract tables
exist only in the temporary PostgreSQL fixture; the gateway gets a SELECT-only
role, and PostgreSQL storage is tmpfs. All test containers, network and temporary
binaries are removed in `finally`; downloaded images remain cached locally.

Intended fixture coverage (bodies NOT RUN): nonroot/read-only runtime, health/readiness, missing/unknown/revoked
credentials, malformed protocol/payload, valid Snappy/protobuf forwarding and
trusted-label overwrite, upstream 500/429 handling, body limit, cached auth while
DB is paused, Redis outage including cold-start DB fallback, dual dependency
failure, per-agent rate limit, graceful SIGTERM and synthetic-secret log checks.

When separately authorized and actually run, this is **container integration
verification with local fixtures**, not proof of VM/Alloy → production gateway →
backend query visibility. End-to-end verification still requires legitimately
enrolled AGT credentials and separately selected query auth as described below.
No image capability, production success or AWS integration is established here.

## Step 6 smoke verification — static semantics, NOT RUN

The following is a future operator command, **not authorized for execution in this
implementation**. It performs a write; no smoke CLI/binary or fixture body was run.

```sh
go run ./cmd/metrics-smoke
```

Only `METRICS_WRITE_URL` and the selected write mode's credentials are required;
no DB/Redis or AGT credential. Basic needs shared `METRICS_USERNAME` plus
`METRICS_WRITE_TOKEN`, Bearer needs only the write token, none needs neither.
Static source writes one `opsgrid_step6_smoke_test = 1` sample at current UTC time,
with `source="metrics-smoke"` and unique `smoke_id`. CLI diagnostics show key presence
and normalized modes (`basic|bearer|none` or fixed `INVALID`), never raw mode/credential
values or complete URLs. The backend-neutral outcome labels are exactly:

```text
Metrics Remote Write: PASS|FAIL
Metrics Query-back: PASS|FAIL|NOT VERIFIED
```

These are possible labels, **not a transcript of a successful run**. HTTP status and
fixed safe reasons are reported separately. Invalid write config fails before any
request; rejected writes/transport failures exit 1. Accepted upstream 2xx gives write
PASS only, not query visibility or VM/Gateway tenant-security verification.

Optional query-back uses independent `METRICS_QUERY_AUTH_MODE` and
`METRICS_QUERY_TOKEN`, never the write token. Basic needs the shared username; Bearer
ignores it; none sends no Authorization even with stale credentials. Two Basic
directions in this one CLI share a username, so differing Basic usernames cannot be
represented together. Use a Prometheus base (e.g. Grafana `/api/prom`) or an exact
`/api/v1/query` endpoint, including a trailing slash. Joining retains base prefixes
and escaped paths without double-appending. No userinfo, query strings or fragments;
same HTTPS/localhost/literal-loopback policy, no redirects.

- **Absent/blank query mode + incomplete legacy Basic query fields:** no query
  attempt, query `NOT VERIFIED`. An accepted write still exits 0. Leave query mode
  commented/blank beside the blank URL/token in the example; do not activate Basic
  there merely to show the default. A complete legacy Basic query is validated.
- **Nonblank explicit query mode:** validates its URL and mode-specific credentials,
  even when incomplete/invalid. Validation becomes `QueryError`; after an accepted
  write, query is `FAIL`, no query request is sent, and CLI exits 1. An earlier failed
  write remains a write failure; it does not establish a query result.
- **Valid configured query:** polls for up to 30 seconds, every 5 seconds, and checks
  this run's metric/source/id/value/timestamp. Query failure exits 1 independently
  of write PASS; both PASS or write PASS + legacy NOT VERIFIED exit 0.

The API is different: omit all API query keys to disable it; partial API query
configuration fails startup, and its URL must be a base, not an exact endpoint.
See [API auth/URL documentation](<../api/README.md#portable-metrics-backend-phase-2>).
The [Task6 approval](<../../.superpowers/sdd/2026-10-08-portable-metrics-backend/task-6-review.md>)
is static only; all smoke/CLI/image bodies remain NOT RUN and runtime NOT VERIFIED.

### Environment-key migration and published images

Current source uses `METRICS_WRITE_AUTH_MODE` / `METRICS_QUERY_AUTH_MODE`, shared
`METRICS_USERNAME` only for Basic, and independent `METRICS_WRITE_TOKEN` /
`METRICS_QUERY_TOKEN` when required by the selected mode. Legacy
`METRICS_WRITE_USERNAME` / `METRICS_WRITE_PASSWORD` and
`METRICS_QUERY_USERNAME` / `METRICS_QUERY_PASSWORD` are **not aliases**.

Current [image-runner fixtures](<tests/image-smoke/runner_test.go>) have
already migrated to canonical keys; the runner does **not** intentionally preserve
legacy fixture names. The fixtures were compiled, not executed. Canonical source
fixtures do not prove that a pinned historical published digest supports these keys
or new auth modes. An existing deployed binary is unchanged by local source/env
changes and may need its historical contract. Verify the exact image's capability
before a separately authorized build/publish/redeployment and matching integration
run; no such upgrade, image execution or live backend verification occurred here.

End-to-end VM → gateway verification requires a legitimately enrolled plaintext AGT;
never invent credentials, reverse hashes, bypass auth or alter enrollment to test it.
