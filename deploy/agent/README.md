# Agent installation, standalone releases and Gateway reconciliation

The Linux installer embeds the current metric ingestion endpoint in
`GATEWAY_URL_DEFAULT`:

```text
https://opsgrid-ingest.bravecliff-c4215c1b.southeastasia.azurecontainerapps.io/api/v1/write
```

This is **not** the enrollment API. `--api-base-url` still points at the separate
control-plane API, which provides `POST /api/v1/agent-enrollment`.

## First installation

Run the source entry point with its adjacent `lib/linux` modules and `alloy/linux.config.alloy.template`. Released installers are assembled standalone scripts; their adjacent template is still required:

```bash
sudo bash deploy/agent/install.sh --api-base-url https://YOUR_ENROLLMENT_API_HOST
```

On a terminal the installer asks for the enrollment token without echoing it.
Automation can pass `--enrollment-token`, but should avoid putting real tokens in
shell history or logs. Enrollment produces the legitimate AGT credential needed
by the Gateway; a credential from a local mock/test enrollment will receive 401.

The installer safely reuses a valid Grafana Alloy package/vendor service instead
of reinstalling it. It renders the Gateway URL into the Alloy template, validates
config, and starts the service. Successful activation is not proof of Gateway
acceptance or upstream metric visibility.

## Run again on an installed VM

```bash
sudo bash deploy/agent/install.sh
```

When a credential already exists (even if a token was passed), the default is:

1. Validate the installed Alloy/vendor service and local credential permissions.
2. Snapshot the existing config/credential/service state.
3. Reconcile the URL in the managed `prometheus.remote_write "ingestion"` component
   with the Gateway URL embedded in this version of the script.
4. If unchanged and Alloy is active, leave config, credential and service alone.
5. If changed, preserve every other config line and the credential, validate,
   atomically apply, and restart/start Alloy. Local failure rolls back prior state.

This path does **not** call enrollment or install packages. It intentionally fails
closed on an unsafe credential, missing config, or ambiguous ingestion component
(multiple blocks/endpoints/URLs), rather than replacing arbitrary custom config.

If URL is unchanged but Alloy is inactive, the script tries to activate it. Gateway
HTTP errors do not roll back a syntactically valid local config; check remote-write
status separately. The script does not add a scheduler or push changes to VMs.

## Linux baseline v1 metrics profile

New installations use **linux-baseline-v1**: 30-second scraping, 11 explicit Unix
collectors and a metric allowlist before remote write. It retains the nine Phase 2
API metric families, operational diagnostics and scrape health. Filesystem pseudo
mounts and network loopback are dropped only within those metric families. Kept
metric names and labels are unchanged; Windows configuration is unchanged.

To upgrade an already enrolled VM, run the updated installer **with its adjacent
Linux template**, without an enrollment token:

```bash
sudo bash deploy/agent/install.sh --apply-profile linux-baseline-v1
```

This explicit profile path preserves the current Gateway and credential. Optional
`--gateway-url` changes the Gateway in the same transaction. It never enrolls or
installs packages, and cannot be combined with `--re-enroll`. Only the original
managed Linux config or this exact managed baseline is accepted; custom configs
fail closed, even if they contain a profile comment. An active equivalent config
is a byte-preserving no-op; validation/restart failures restore the previous state.

Back up config in a root-only directory before deployment. Do not delete Alloy's
WAL, credential, package or VM registration. Wait for fresh backend samples and
verify remote-write success, the retained API families and actual 30s sample
cadence. Instant-query cardinality may still include old samples during lookback;
measure `last_over_time(...[90s])` for actual recent samples instead. Series counts
vary by host/kernel/device count; roughly 104 is an estimate, not a fixed limit.

A normal tokenless rerun **without** `--apply-profile` still only reconciles the
Gateway; it does not upgrade an existing profile.

## Future Gateway changes

Change `GATEWAY_URL_DEFAULT` in the Linux runtime module, rebuild and verify the
standalone release, then publish the updated release assets together after review. Download/run the updated script on each VM. Existing VMs
retain the old URL until the updated script runs.

An optional per-invocation override works without a script release:

```bash
sudo bash deploy/agent/install.sh --gateway-url https://NEW_GATEWAY_HOST/
```

Base URLs and full `/api/v1/write` URLs are accepted; a trailing slash is normalized.
Public endpoints must use HTTPS. HTTP is allowed only for loopback tests. Userinfo,
queries, fragments, quotes, whitespace, invalid ports and other paths are rejected.
An override is not a persisted installer preference: a later run without it will
reconcile back to that script version's embedded default.

## Replace a mock, revoked or expired credential

Explicitly request re-enrollment with a **new, active** one-time token:

```bash
sudo bash deploy/agent/install.sh \
  --re-enroll \
  --api-base-url https://YOUR_ENROLLMENT_API_HOST
```

The token is prompted without echo on a terminal. This uses the normal enrollment
transaction and regenerated template, so customized Alloy config may be replaced.
Gateway reconciliation alone cannot turn a mock AGT into a valid credential.

## Release launcher

After the updated launcher, installer and Linux template are released together,
fetch the current launcher to a local file (do not pipe downloaded code to a shell):

```bash
curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location \
  --output install-launcher.sh \
  https://get.opsgrid.hacmieu.com/linux
sudo bash ./install-launcher.sh
```

The launcher downloads the released installer/template, accepts runs without a
token, and forwards `--gateway-url`, `--api-base-url`, `--apply-profile`, `--re-enroll`, and optional
`--token`. First install/re-enrollment still requires the real enrollment API.
Do not expect these new options/behavior from an older unrevised public release.
The `/windows` short URL resolves the matching Windows release launcher. These
short URLs select the published **latest GitHub release**, not the source branch.

## Modular source and synchronized standalone build

Keep the source entry points, platform responsibility modules, launcher scripts and
Alloy templates together when working in the checkout. Do not upload a thin source
entry point as a release installer: the release launchers expect complete scripts
and validate their functions and final invocation structure.

Build both platforms from the repository root (Node.js, built-in modules only):

```bash
node deploy/agent/build-release.mjs
node deploy/agent/build-release.mjs --verify
```

The default output is the ignored `.superpowers/agent-refactor/release` directory.
The builder refuses the source tree and nonempty unowned destinations. The seven
release assets are the two standalone installers, two unchanged launchers, two
platform templates and the Windows profile template. Template copies also appear
under `alloy/` for checkout-style tests. `release-manifest.json` records source
provenance and asset hashes; `SHA256SUMS` records the release asset checksums.
`--verify` is read-only and refuses stale sources, altered assets, mismatched
metadata, unexpected files, symlinks and multiply hard-linked files. Destination
files are checked before any overwrite. Build output is deterministic without
wall-clock timestamps or machine-specific paths.

A per-platform gate can use `--platform linux` or `--platform windows` with a
separate `--output` directory. Its manifest is **not synchronized** and it is not a
complete release. After both OS suites pass, build and verify both platforms again
and rerun the existing suites against those exact standalone artifacts. Publish
all seven assets from that single verified output together, never source loaders
or independently assembled installers. The builder does **not** publish, stage,
commit or push anything. Hashes detect drift but are not a signature or publisher
attestation; the launchers do not currently verify these hashes.

## Enrollment failures and retained recovery snapshots

Enrollment is a single POST. A transport error or ambiguous server response may
mean that the one-use token has already been consumed. Do not automatically retry
or reuse that token; check registration and obtain a new token if appropriate.
Local configuration/identity/credential-target validation precedes enrollment,
but this is not a guarantee of successful remote Gateway ingestion.

On rollback failure the installer retains only protected **previous-state**
recovery snapshots and nonsecret filesystem/service metadata. New enrollment
payloads, response files, new credentials and validator transcripts are disposable;
they must not be retained with the originals. The log reports the recovery path,
not credential contents. Recovery material can contain the previous credential:
keep its restrictive root-only permissions or Windows SYSTEM/Administrators ACLs,
and use it only for controlled manual recovery. Never paste its contents into logs.

## Verification

```bash
systemctl is-active alloy.service
systemctl is-enabled alloy.service
curl --fail --silent http://127.0.0.1:12345/metrics \
  | grep -E 'prometheus_remote_storage_samples_(total|failed_total)|prometheus_scrape_targets_gauge'
sudo journalctl -u alloy.service --since '5 minutes ago' --no-pager
```

Do not print the credential or enrollment token. Look for a scrape target, increasing
sent samples, no new nonrecoverable failures, and Gateway acceptance. `/health` and
`/ready` alone do not prove a successful remote write; querying the metrics backend
is required to establish end-to-end visibility.

## Local regression tests

From the repository root, run the suite only in a disposable root Linux container:

```bash
docker run --rm \
  --mount "type=bind,source=$PWD,target=/work,readonly" \
  --workdir /work golang:1.27.1 \
  bash deploy/agent/tests/gateway-update.test.sh
```

The regression groups cover URL validation, exact no-op behavior, vendor
permissions, private config mode preservation, tokenless/obsolete-token reruns,
explicit re-enrollment, profile migration/refusal/no-op/rollback, launcher
forwarding/secret hygiene, single-attempt enrollment, pre-enrollment validation,
repository temp cleanup and protected recovery retention. Set
`OPSGRID_TEST_RELEASE_DIR` to a standalone output directory to run the same suite
against the generated installer rather than the source entry point. Additionally
run `python deploy/agent/tests/linux-baseline.test.py` for focused profile tests.
They exercise real installer filesystem/transaction helpers with mocked systemctl,
Alloy and enrollment responses; they do not establish live Gateway ingestion.

The existing Windows fixtures run under Windows PowerShell 5.1:

```powershell
powershell.exe -NoProfile -File deploy/agent/tests/windows-installer.test.ps1
powershell.exe -NoProfile -File deploy/agent/tests/windows-installer.test.ps1 -ProfileOnly
powershell.exe -NoProfile -File deploy/agent/tests/windows-launcher.test.ps1
python deploy/agent/tests/windows-baseline.test.py
```

Windows fixtures build standalone assets in owned temporary output by default.
Set `OPSGRID_TEST_RELEASE_DIR` to an already verified synchronized output to test
that exact set instead; supplied output is never deleted by fixture cleanup.
Administrator-only protected ACL/lock cases are explicitly not run without
elevation. SCM, enrollment and Windows Alloy execution remain fixture boundaries;
a passing fixture suite is not a live Windows install or Gateway acceptance test.
