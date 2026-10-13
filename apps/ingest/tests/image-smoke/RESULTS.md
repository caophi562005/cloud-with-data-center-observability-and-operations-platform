# Published ingest image — local container verification

Date: 2026-10-03. Docker Desktop engine: 29.1.3.

Tested the existing published image by immutable digest, without rebuilding or
repushing the gateway:

```text
public.ecr.aws/h5u5b6t3/opsgrid-ingest@sha256:88f8400e5224f029b61923513b2002f0ad10705bb954f827f8b12c736f81b487
```

## Observed results

| Check | Result |
| --- | --- |
| Image/runtime | Linux/amd64; nonroot; read-only root filesystem; all capabilities dropped; no-new-privileges |
| Existing private runtime configuration | Container starts; `/health` 200; `/ready` 200; unauthenticated write 401 |
| Missing / unknown / revoked fixture credential | 401 |
| Wrong protocol / malformed Snappy | 400 |
| Valid local fixture Remote Write | 204; upstream decodes Snappy/protobuf; Basic Auth and Remote Write headers correct |
| Trusted identity labels | Spoofed/duplicate identity labels replaced by authenticated IDs; metric/value and other label preserved; labels sorted |
| Upstream 500 / 429 | 502 (no false ACK) / 429 with `Retry-After: 3` |
| Body over configured test limit | 413 |
| PostgreSQL paused | Health 200; readiness 503; cached identity still writes 204; cache miss 503 |
| Redis stopped and gateway restarted | Starts despite cache outage; readiness 200; DB fallback write 204 |
| Both auth dependencies unavailable | 503 |
| Per-agent rate limit | 429 with `Retry-After: 1` after exhausting the configured burst |
| SIGTERM | Exit 0, for both existing-config and fixture runs |
| Log inspection | Synthetic credential values absent from captured gateway logs |
| Go regressions | `go vet ./...` and `go test -count=1 ./...` passed |

The [runner](run.ps1) uses a disposable PostgreSQL 17 fixture, Redis 7 fixture and
[local upstream/client](main.go). The gateway receives a SELECT-only fixture DB
role; seed writes touch only the disposable tmpfs database. Test ports bind only
to loopback. Temporary containers, networks and compiled fixture binaries were
removed; fixture images remain in the local Docker cache.

## Boundary

This establishes successful local runtime and integration behavior for this image,
not production readiness/load capacity or full VM/Alloy → Grafana query visibility.
No real agent credential was used, no metrics were sent to Grafana, and no AWS
resources, image tag or Git staging/commit were changed. The positive write cases
use synthetic local identities and a mock metrics upstream. A true live agent
round trip still needs a legitimately enrolled AGT and explicit query credentials.

An initial harness run could not expose ports on an internal Docker Desktop
network; the runner was corrected to use a dedicated bridge. This was a fixture
networking issue, not an ingest image failure. Expected Redis pool warnings occurred
while deliberately disabling Redis; DB fallback continued to pass.
