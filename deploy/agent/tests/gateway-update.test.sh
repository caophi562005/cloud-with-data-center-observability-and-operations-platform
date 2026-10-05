#!/usr/bin/env bash
# Run in a disposable root Linux container; no network or package installs:
# docker run --rm --mount type=bind,source="$PWD",target=/work,readonly \
#   --workdir /work golang:1.27.1 bash deploy/agent/tests/gateway-update.test.sh
set -Eeuo pipefail
set +x
umask 077

HERE="$(cd -- "${BASH_SOURCE[0]%/*}" && pwd -P)"
ASSET_ROOT="${OPSGRID_TEST_RELEASE_DIR:-${HERE%/tests}}"
INSTALLER="$ASSET_ROOT/install.sh"
LAUNCHER="$ASSET_ROOT/install-launcher.sh"
TEMPLATE="$ASSET_ROOT/alloy/linux.config.alloy.template"
DEFAULT_URL='https://opsgrid-ingest.bravecliff-c4215c1b.southeastasia.azurecontainerapps.io/api/v1/write'
OLD_URL='https://old-gateway.example.test/api/v1/write'
NEW_URL='https://new-gateway.example.test/api/v1/write'
if [[ ${EUID:-1} != 0 || ! -f /.dockerenv ]]; then
  printf '[opsgrid-agent] Tests require a disposable root Docker container.\n' >&2
  exit 1
fi
ROOT="$(mktemp -d /tmp/opsgrid-gateway-tests.XXXXXX)"
: > "$ROOT/directories"
finish() {
  local directory
  while IFS= read -r directory; do
    case "$directory" in
      /etc/alloy/.opsgrid-gateway-test.*|/etc/opsgrid-agent/.opsgrid-gateway-test.*)
        rm -rf -- "$directory" ;;
      *) return 1 ;;
    esac
  done < "$ROOT/directories"
  rm -rf -- "$ROOT"
}
trap finish EXIT

bad() { printf '[opsgrid-agent] FAIL: %s\n' "$*" >&2; exit 1; }
eq() { [[ "$1" == "$2" ]] || bad "$3"; }
has() { grep -Fq -- "$2" "$1" || bad "$3"; }
lacks() { if grep -Fq -- "$2" "$1"; then bad "$3"; fi; }
rejects() {
  local status=0
  (trap - EXIT; "$@") > "$CASE_ROOT/rejected.log" 2>&1 || status=$?
  ((status != 0)) || bad 'unsafe input was accepted'
}

fixture() {
  # Sourcing enables errexit, disables xtrace, fixes PATH, and installs EXIT.
  # Unit subshells must disable that trap; integration children restore it.
  source "$INSTALLER"
  trap - EXIT
  CASE_ROOT="$ROOT/case-$COUNT"
  mkdir -m 700 "$CASE_ROOT" "$CASE_ROOT/bin" "$CASE_ROOT/state"
  local suffix="${ROOT##*.}.$COUNT"
  AGENT_CREDENTIAL_FILE="/etc/opsgrid-agent/.opsgrid-gateway-test.$suffix/agent.credential"
  ALLOY_CONFIG_FILE="/etc/alloy/.opsgrid-gateway-test.$suffix/config.alloy"
  mkdir -p /etc/opsgrid-agent /etc/alloy
  mkdir -m 700 "${AGENT_CREDENTIAL_FILE%/*}" "${ALLOY_CONFIG_FILE%/*}"
  printf '%s\n' "${AGENT_CREDENTIAL_FILE%/*}" "${ALLOY_CONFIG_FILE%/*}" >> "$ROOT/directories"
  printf '%s' 'AGT_TEST_existing_not_a_secret' > "$AGENT_CREDENTIAL_FILE"
  chmod 600 "$AGENT_CREDENTIAL_FILE"
  cat > "$ALLOY_CONFIG_FILE" <<EOF
// Preserve this custom configuration and brace-looking comments { }
local.file "agent_credential" {
  filename = "$AGENT_CREDENTIAL_FILE"
  is_secret = true
}
prometheus.remote_write "custom" {
  endpoint {
    url = "https://unrelated.example.test/api/v1/write"
  }
}
prometheus.remote_write "ingestion" {
  endpoint {
    url = "$OLD_URL" // retained comment
    authorization {
      type = "Bearer"
      credentials = local.file.agent_credential.content
    }
  }
}
EOF
  chmod 640 "$ALLOY_CONFIG_FILE"
  cp "$ALLOY_CONFIG_FILE" "$CASE_ROOT/original.config"
  cp "$AGENT_CREDENTIAL_FILE" "$CASE_ROOT/original.credential"
  printf '%s\n' active > "$CASE_ROOT/state/active"
  printf '%s\n' enabled > "$CASE_ROOT/state/enabled"
  : > "$CASE_ROOT/state/calls"
  export TEST_STATE="$CASE_ROOT/state" TEST_CONFIG="$ALLOY_CONFIG_FILE"
  export TEST_CREDENTIAL="$AGENT_CREDENTIAL_FILE"
  export TEST_SERVICE="$CASE_ROOT/alloy.service" TEST_ALLOY="$CASE_ROOT/bin/alloy"
  cat > "$TEST_SERVICE" <<EOF
[Service]
User=root
Group=root
ExecStart=$TEST_ALLOY run $ALLOY_CONFIG_FILE
EOF
  cat > "$CASE_ROOT/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$TEST_STATE/calls"
case "$1" in
  show)
    case "$*" in
      *--property=FragmentPath*) printf '%s\n' "$TEST_SERVICE" ;;
      *--property=ExecStart*) printf '{ path=%s ; }\n' "$TEST_ALLOY" ;;
      *--property=LoadState*) printf 'loaded\n' ;;
      *' -p User -p Group '*) printf 'User=%s\nGroup=%s\n' "${TEST_USER:-root}" "${TEST_GROUP:-root}" ;;
      *) exit 91 ;;
    esac ;;
  cat) cat "$TEST_SERVICE" ;;
  is-active|is-enabled)
    if [[ "$1" == is-active ]]; then state="$(<"$TEST_STATE/active")"; want=active
    else state="$(<"$TEST_STATE/enabled")"; want=enabled; fi
    if [[ "$*" != *--quiet* ]]; then printf '%s\n' "$state"; fi
    [[ "$state" == "$want" ]] ;;
  restart)
    cp "$TEST_CONFIG" "$TEST_STATE/applied.config"
    cp "$TEST_CREDENTIAL" "$TEST_STATE/applied.credential"
    if [[ -f "$TEST_STATE/fail-restart-once" ]]; then
      rm "$TEST_STATE/fail-restart-once"
      printf 'failed\n' > "$TEST_STATE/active"
      exit 1
    fi
    printf 'active\n' > "$TEST_STATE/active" ;;
  stop) printf 'inactive\n' > "$TEST_STATE/active" ;;
  start) printf 'active\n' > "$TEST_STATE/active" ;;
  enable)
    printf 'enabled\n' > "$TEST_STATE/enabled"
    if [[ "$*" == *--now* ]]; then printf 'active\n' > "$TEST_STATE/active"; fi ;;
  disable) printf 'disabled\n' > "$TEST_STATE/enabled" ;;
  *) exit 92 ;;
esac
STUB
  cat > "$TEST_ALLOY" <<'STUB'
#!/usr/bin/env bash
set -eu
[[ $# == 2 && "$1" == validate && -f "$2" ]] || exit 93
cp "$2" "$TEST_STATE/validated.config"
# Simulate the real parser rejecting an identifier split by whitespace.
if grep -q 'is_secret = t rue' "$2"; then exit 1; fi
[[ ! -f "$TEST_STATE/fail-validation" ]]
STUB
  chmod 700 "$CASE_ROOT/bin/systemctl" "$TEST_ALLOY"
  # Only OS/external boundaries are substituted. Installer transactions,
  # credential validation, config rendering, service flow and rollback are real.
  systemctl() { "$CASE_ROOT/bin/systemctl" "$@"; }
  curl() { bad 'unexpected network/enrollment request'; }
  jq() { bad 'unexpected enrollment JSON processing'; }
  gpg() { bad 'unexpected repository key installation'; }
  check_ca_certificates() { :; }
  install_alloy_official() { bad 'unexpected package installation'; }
  INSTALL_LOCK_FILE="$CASE_ROOT/install.lock"
  PRIVATE_INSTALL_LOCK_FILE="$CASE_ROOT/private/install.lock"
  ALLOY_BINARY_PATH="$TEST_ALLOY"
  ALLOY_RUNTIME_USER=root
  ALLOY_RUNTIME_GROUP=root
  ALLOY_RUNTIME_ROOT=1
}

COUNT=0
run() {
  local name="$1" status=0
  shift
  if [[ -n "${OPSGRID_TEST_FILTER:-}" && "$name" != *"$OPSGRID_TEST_FILTER"* ]]; then return 0; fi
  COUNT=$((COUNT + 1))
  # Do not run tests as an if/! condition: that silently disables Bash errexit.
  set +e
  (set -Eeuo pipefail; fixture; "$@") > "$ROOT/test-$COUNT.log" 2>&1
  status=$?
  set -e
  if ((status)); then
    cat "$ROOT/test-$COUNT.log" >&2
    bad "$name (exit $status)"
  fi
  printf '[opsgrid-agent] PASS: %s\n' "$name"
}

urls() {
  parse_args
  validate_gateway_url
  eq "$GATEWAY_URL" "$DEFAULT_URL" 'embedded Azure Gateway default'
  eq "$RE_ENROLL" 0 'rerun must be the default'
  eq "$ENROLLMENT_TOKEN" '' 'token must be optional at argument parsing'
  local input want
  while IFS='|' read -r input want; do
    parse_args --gateway-url "$input"
    validate_gateway_url
    eq "$GATEWAY_URL" "$want" 'Gateway normalization'
  done <<'CASES'
https://gateway.example.test|https://gateway.example.test/api/v1/write
https://gateway.example.test/|https://gateway.example.test/api/v1/write
https://gateway.example.test/api/v1/write|https://gateway.example.test/api/v1/write
https://gateway.example.test/api/v1/write/|https://gateway.example.test/api/v1/write
https://gateway.example.test:443/|https://gateway.example.test:443/api/v1/write
http://localhost:8080|http://localhost:8080/api/v1/write
http://127.0.0.1:8080/|http://127.0.0.1:8080/api/v1/write
http://[::1]:8080/api/v1/write/|http://[::1]:8080/api/v1/write
CASES
  for input in '' 'http://public.example.test' 'https://user:pass@gateway.example.test' \
    'https://gateway.example.test?x=1' 'https://gateway.example.test/api/v1/write?x=1' \
    'https://gateway.example.test/#frag' 'https://gateway.example.test/other' \
    'https://gateway.example.test:0' 'https://gateway.example.test:65536' \
    'https://gateway.example.test:123456' 'https://gateway.example.test:abc' \
    'https://gateway.example.test:"443"' 'https://gateway.example.test/"' \
    "https://gateway.example.test/'" 'https://gateway.example.test/$(touch /tmp/injected)' \
    'https://gateway.example.test/;echo injected' 'https://gateway.example.test/\\' \
    $'https://gateway.example.test\nurl="injected"'; do
    GATEWAY_URL="$input"
    rejects validate_gateway_url
    has "$CASE_ROOT/rejected.log" '[opsgrid-agent]' 'URL errors must use stable prefix'
    if [[ -n "$input" ]]; then
      lacks "$CASE_ROOT/rejected.log" "$input" 'rejected URL must not be echoed'
    fi
  done
}

rendering() {
  resolve_script_paths
  ENROLLED_CREDENTIAL='AGT_TEST_fresh_not_a_secret'
  parse_args
  render_config_atomic
  has "$TASK4_CONFIG_STAGE" "url = \"$DEFAULT_URL\"" 'default must reach rendered Alloy config'
  has "$TASK4_CONFIG_STAGE" "filename  = \"$AGENT_CREDENTIAL_FILE\"" 'credential file reference'
  lacks "$TASK4_CONFIG_STAGE" '__GATEWAY_URL__' 'Gateway placeholder must be fully rendered'
  lacks "$TASK4_CONFIG_STAGE" '__CREDENTIAL_FILE__' 'credential placeholder must be fully rendered'
  lacks "$TASK4_CONFIG_STAGE" 'AGT_' 'render must not inline credentials'
  task4_cleanup_temps
  local bad_template="$CASE_ROOT/bad.template"
  sed '/__GATEWAY_URL__/d' "$TEMPLATE" > "$bad_template"
  LINUX_TEMPLATE_FILE="$bad_template"
  rejects render_config_atomic
  cp "$TEMPLATE" "$bad_template"
  printf '\n// __GATEWAY_URL__\n' >> "$bad_template"
  rejects render_config_atomic
}

staging() {
  TASK4_SNAPSHOT_CONFIG_CONTENT="$CASE_ROOT/original.config"
  GATEWAY_URL="$NEW_URL"
  stage_gateway_update
  sed 's|https://old-gateway.example.test/api/v1/write|https://new-gateway.example.test/api/v1/write|' \
    "$CASE_ROOT/original.config" > "$CASE_ROOT/expected.config"
  cmp -s "$TASK4_CONFIG_STAGE" "$CASE_ROOT/expected.config" || bad 'staging must change only ingestion URL'
  cmp -s "$ALLOY_CONFIG_FILE" "$CASE_ROOT/original.config" || bad 'staging must not apply early'
  task4_cleanup_temps
  local malformed="$CASE_ROOT/malformed.config"
  TASK4_SNAPSHOT_CONFIG_CONTENT="$malformed"
  cat "$CASE_ROOT/original.config" "$CASE_ROOT/original.config" > "$malformed"
  rejects stage_gateway_update
  sed '/    authorization {/i\  endpoint {\n    url = "https://second.example.test/api/v1/write"\n  }' \
    "$CASE_ROOT/original.config" > "$malformed"
  rejects stage_gateway_update
  sed '/    url = "https:\/\/old-gateway/d' "$CASE_ROOT/original.config" > "$malformed"
  rejects stage_gateway_update
  sed '/    url = "https:\/\/old-gateway/a\    url = "https://second.example.test/api/v1/write"' \
    "$CASE_ROOT/original.config" > "$malformed"
  rejects stage_gateway_update
  sed 's/"ingestion"/"not_ingestion"/' "$CASE_ROOT/original.config" > "$malformed"
  rejects stage_gateway_update
  sed '$d' "$CASE_ROOT/original.config" > "$malformed"
  rejects stage_gateway_update
  sed 's|url = "https://old-gateway.example.test/api/v1/write".*|url = sys.env("CUSTOM_URL")|' \
    "$CASE_ROOT/original.config" > "$malformed"
  rejects stage_gateway_update
}

unchanged() {
  if [[ "${1:-}" == no-newline ]]; then
    local content
    content="$(<"$ALLOY_CONFIG_FILE")"
    printf '%s' "$content" > "$ALLOY_CONFIG_FILE"
  fi
  local before_config before_credential
  before_config="$(stat -c '%i:%u:%g:%a:%s:%Y:%Z' "$ALLOY_CONFIG_FILE")"
  before_credential="$(stat -c '%i:%u:%g:%a:%s:%Y:%Z' "$AGENT_CREDENTIAL_FILE")"
  (trap cleanup EXIT; main --gateway-url "$OLD_URL") > "$CASE_ROOT/run.log" 2>&1
  eq "$(stat -c '%i:%u:%g:%a:%s:%Y:%Z' "$ALLOY_CONFIG_FILE")" "$before_config" 'same URL must not rewrite config'
  eq "$(stat -c '%i:%u:%g:%a:%s:%Y:%Z' "$AGENT_CREDENTIAL_FILE")" "$before_credential" 'same URL must not touch credential'
  cmp -s "$AGENT_CREDENTIAL_FILE" "$CASE_ROOT/original.credential" || bad 'same URL credential bytes'
  has "$CASE_ROOT/run.log" 'Gateway URL is unchanged' 'unchanged status'
  if grep -Eq '^(restart|start|stop|enable|disable) ' "$TEST_STATE/calls"; then
    bad 'same URL must not mutate service'
  fi
}

rerun() {
  # With no token and with an obsolete supplied token, neither enrollment nor
  # installation is permitted. Real main drives real reconciliation to default.
  local token_mode="$1" before_credential
  before_credential="$(stat -c '%i:%u:%g:%a:%s:%Y:%Z' "$AGENT_CREDENTIAL_FILE")"
  local args=()
  if [[ "$token_mode" == obsolete ]]; then args=(--enrollment-token TEST_obsolete_not_a_secret); fi
  (trap cleanup EXIT; main "${args[@]}") > "$CASE_ROOT/run.log" 2>&1
  has "$ALLOY_CONFIG_FILE" "$DEFAULT_URL" 'rerun must reconcile embedded Gateway'
  has "$TEST_STATE/validated.config" "$DEFAULT_URL" 'staged change must be validated'
  has "$TEST_STATE/applied.config" "$DEFAULT_URL" 'changed URL must be applied before restart'
  eq "$(grep -c '^restart alloy.service$' "$TEST_STATE/calls")" 1 'changed URL restart count'
  eq "$(stat -c '%i:%u:%g:%a:%s:%Y:%Z' "$AGENT_CREDENTIAL_FILE")" "$before_credential" 'rerun must preserve credential metadata'
  cmp -s "$AGENT_CREDENTIAL_FILE" "$CASE_ROOT/original.credential" || bad 'rerun credential bytes'
  has "$ALLOY_CONFIG_FILE" 'https://unrelated.example.test/api/v1/write' 'custom config preserved'
  lacks "$CASE_ROOT/run.log" TEST_obsolete_not_a_secret 'obsolete token must not leak'
  lacks "$CASE_ROOT/run.log" AGT_TEST_ 'credential must not leak'
}

private_mode() {
  local mode="$1"
  chmod "$mode" "$ALLOY_CONFIG_FILE"
  rerun none
  eq "$(stat -c '%a' "$ALLOY_CONFIG_FILE")" "$mode" 'Gateway update must preserve private config mode'
}

vendor_layout() {
  local mode="$1" credential_metadata config_metadata
  if ! getent group alloy >/dev/null; then groupadd --system alloy; fi
  if ! id -u alloy >/dev/null 2>&1; then
    useradd --system --gid alloy --no-create-home alloy
  fi
  export TEST_USER=alloy TEST_GROUP=alloy
  chown root:alloy "${AGENT_CREDENTIAL_FILE%/*}" "$AGENT_CREDENTIAL_FILE" "${ALLOY_CONFIG_FILE%/*}"
  chmod 750 "${AGENT_CREDENTIAL_FILE%/*}"
  chmod 640 "$AGENT_CREDENTIAL_FILE"
  chmod "$mode" "${ALLOY_CONFIG_FILE%/*}"
  chmod 644 "$ALLOY_CONFIG_FILE"
  credential_metadata="$(stat -c '%i:%u:%g:%a:%s:%Y:%Z' "$AGENT_CREDENTIAL_FILE")"
  config_metadata="$(stat -c '%u:%g:%a' "${ALLOY_CONFIG_FILE%/*}")"
  (trap cleanup EXIT; main --gateway-url "$NEW_URL") > "$CASE_ROOT/run.log" 2>&1
  has "$ALLOY_CONFIG_FILE" "$NEW_URL" 'vendor layout Gateway reconciliation'
  eq "$(stat -c '%i:%u:%g:%a:%s:%Y:%Z' "$AGENT_CREDENTIAL_FILE")" "$credential_metadata" 'vendor credential must not change'
  eq "$(stat -c '%u:%g:%a' "${ALLOY_CONFIG_FILE%/*}")" "$config_metadata" 'vendor config directory metadata must not change'
  cmp -s "$AGENT_CREDENTIAL_FILE" "$CASE_ROOT/original.credential" || bad 'vendor credential bytes'
  has "$TEST_STATE/calls" 'restart alloy.service' 'vendor layout must reach apply flow'
}

fresh_enrollment() {
  # Model the external enrollment response only; credential write/render/apply
  # and failure cleanup remain the actual installer implementation.
  post_enrollment() {
    eq "$ENROLLMENT_TOKEN" TEST_fresh_not_a_secret 'explicit re-enroll must consume supplied token'
    printf 'enrolled\n' > "$CASE_ROOT/enrolled"
    ENROLLED_CREDENTIAL='AGT_TEST_fresh_not_a_secret'
  }
}

reenroll() {
  fresh_enrollment
  (trap cleanup EXIT; main --re-enroll --enrollment-token TEST_fresh_not_a_secret \
    --gateway-url https://new-gateway.example.test/) > "$CASE_ROOT/run.log" 2>&1
  [[ -f "$CASE_ROOT/enrolled" ]] || bad 'explicit re-enroll must use fresh enrollment path'
  eq "$(<"$AGENT_CREDENTIAL_FILE")" AGT_TEST_fresh_not_a_secret 'fresh credential must replace old credential'
  has "$ALLOY_CONFIG_FILE" "$NEW_URL" 'fresh override must reach rendered config'
  lacks "$ALLOY_CONFIG_FILE" AGT_TEST_ 'fresh config must reference credential file'
  lacks "$CASE_ROOT/run.log" TEST_fresh_not_a_secret 'fresh token must not leak'
  lacks "$CASE_ROOT/run.log" AGT_TEST_ 'fresh credential must not leak'
}

failure_rollback() {
  local mode="$1" status=0 before_config before_credential untouched_config untouched_credential
  if [[ "$mode" == staging ]]; then
    sed 's/"ingestion"/"not_ingestion"/' "$CASE_ROOT/original.config" > "$ALLOY_CONFIG_FILE"
    cp "$ALLOY_CONFIG_FILE" "$CASE_ROOT/original.config"
  fi
  untouched_config="$(stat -c '%i:%u:%g:%a:%s:%Y:%Z' "$ALLOY_CONFIG_FILE")"
  untouched_credential="$(stat -c '%i:%u:%g:%a:%s:%Y:%Z' "$AGENT_CREDENTIAL_FILE")"
  before_config="$(stat -c '%u:%g:%a' "$ALLOY_CONFIG_FILE")"
  before_credential="$(stat -c '%u:%g:%a' "$AGENT_CREDENTIAL_FILE")"
  local args=(--gateway-url "$NEW_URL") expected=50
  case "$mode" in
    validation) touch "$TEST_STATE/fail-validation"; expected=40 ;;
    staging) expected=40 ;;
    restart) touch "$TEST_STATE/fail-restart-once" ;;
    reenroll)
      fresh_enrollment
      touch "$TEST_STATE/fail-restart-once"
      args+=(--re-enroll --enrollment-token TEST_fresh_not_a_secret) ;;
  esac
  # This is the real EXIT trap, not a manual call to a mocked rollback helper.
  (trap cleanup EXIT; main "${args[@]}") > "$CASE_ROOT/run.log" 2>&1 || status=$?
  eq "$status" "$expected" 'stable primary failure exit code'
  cmp -s "$ALLOY_CONFIG_FILE" "$CASE_ROOT/original.config" || bad 'EXIT rollback must restore exact config bytes'
  cmp -s "$AGENT_CREDENTIAL_FILE" "$CASE_ROOT/original.credential" || bad 'EXIT rollback must restore exact credential bytes'
  eq "$(stat -c '%u:%g:%a' "$ALLOY_CONFIG_FILE")" "$before_config" 'rollback config metadata'
  eq "$(stat -c '%u:%g:%a' "$AGENT_CREDENTIAL_FILE")" "$before_credential" 'rollback credential metadata'
  eq "$(<"$TEST_STATE/active")" active 'rollback service active state'
  eq "$(<"$TEST_STATE/enabled")" enabled 'rollback service enabled state'
  if [[ "$mode" == validation || "$mode" == staging ]]; then
    eq "$(stat -c '%i:%u:%g:%a:%s:%Y:%Z' "$ALLOY_CONFIG_FILE")" "$untouched_config" 'rejected stage must not rewrite config'
    eq "$(stat -c '%i:%u:%g:%a:%s:%Y:%Z' "$AGENT_CREDENTIAL_FILE")" "$untouched_credential" 'rejected stage must not touch credential'
    if grep -Eq '^(restart|start|stop|enable|disable) ' "$TEST_STATE/calls"; then
      bad 'rejected stage must not mutate service'
    fi
  else
    has "$TEST_STATE/calls" 'stop alloy.service' 'rollback must quiesce service'
    has "$TEST_STATE/calls" 'start alloy.service' 'rollback must restore active service'
  fi
  lacks "$CASE_ROOT/run.log" 'rollback failed' 'rollback must be proven restored'
  if [[ "$mode" != validation && "$mode" != staging ]]; then
    has "$TEST_STATE/applied.config" "$NEW_URL" 'failure must happen after actual config apply'
  fi
  if [[ "$mode" == reenroll ]]; then
    eq "$(<"$TEST_STATE/applied.credential")" AGT_TEST_fresh_not_a_secret 'failed reenroll must have written fresh credential before rollback'
  fi
  lacks "$CASE_ROOT/run.log" TEST_fresh_not_a_secret 'failure token must not leak'
  lacks "$CASE_ROOT/run.log" AGT_TEST_ 'failure credential must not leak'
  local leftover
  for leftover in "${ALLOY_CONFIG_FILE%/*}"/.opsgrid-agent-* "${AGENT_CREDENTIAL_FILE%/*}"/.opsgrid-agent-*; do
    [[ ! -e "$leftover" ]] || bad 'rollback left staged artifacts'
  done
}

launcher() {
  local assets="$CASE_ROOT/assets" capture="$CASE_ROOT/args" status=0
  mkdir "$assets"
  cp "$TEMPLATE" "$assets/linux.config.alloy.template"
  cat > "$assets/install.sh" <<'STUB'
#!/usr/bin/env bash
set +x
: > "$TEST_CAPTURE"
if (($#)); then printf '%s\n' "$@" > "$TEST_CAPTURE"; fi
exit "${TEST_INSTALLER_EXIT:-0}"
STUB
  cat > "$CASE_ROOT/bin/curl" <<'STUB'
#!/usr/bin/env bash
set -eu
output='' url=''
while (($#)); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
[[ -n "$output" && -n "$url" ]] || exit 94
printf '%s\n' "$url" >> "$TEST_DOWNLOADS"
cp "$TEST_ASSETS/${url##*/}" "$output"
STUB
  chmod 700 "$CASE_ROOT/bin/curl"
  export TEST_ASSETS="$assets" TEST_CAPTURE="$capture" TEST_DOWNLOADS="$CASE_ROOT/downloads"
  PATH="$CASE_ROOT/bin:$PATH" bash -x "$LAUNCHER" > "$CASE_ROOT/launcher.log" 2>&1
  [[ ! -s "$capture" ]] || bad 'launcher must forward no implicit token or Gateway'
  eq "$(wc -l < "$TEST_DOWNLOADS")" 2 'launcher must download both assets'
  PATH="$CASE_ROOT/bin:$PATH" bash -x "$LAUNCHER" --token TEST_launch_not_a_secret \
    --api-base-url https://api.example.test --gateway-url https://gateway.example.test/ \
    --re-enroll > "$CASE_ROOT/launcher.log" 2>&1
  printf '%s\n' --api-base-url https://api.example.test --gateway-url https://gateway.example.test/ \
    --re-enroll --enrollment-token TEST_launch_not_a_secret > "$CASE_ROOT/expected.args"
  cmp -s "$capture" "$CASE_ROOT/expected.args" || bad 'launcher must forward exact overrides, re-enroll and mapped token'
  lacks "$CASE_ROOT/launcher.log" TEST_launch_not_a_secret 'launcher must suppress caller xtrace token'
  export TEST_INSTALLER_EXIT=40
  PATH="$CASE_ROOT/bin:$PATH" bash "$LAUNCHER" --token=TEST_equal_not_a_secret \
    > "$CASE_ROOT/launcher.log" 2>&1 || status=$?
  eq "$status" 40 'launcher must propagate installer failure'
  eq "$(<"$capture")" $'--enrollment-token\nTEST_equal_not_a_secret' 'equals-style token forwarding'
  lacks "$CASE_ROOT/launcher.log" TEST_equal_not_a_secret 'launcher failure token must not leak'
  status=0
  PATH="$CASE_ROOT/bin:$PATH" bash "$LAUNCHER" --gateway-url \
    > "$CASE_ROOT/launcher.log" 2>&1 || status=$?
  eq "$status" 10 'launcher missing override value must fail'
}

# Profile updates must exercise the real installer, not a re-enrollment shortcut.
legacy_profile_fixture() {
  cat > "$ALLOY_CONFIG_FILE" <<EOF
local.file "agent_credential" {
  filename = "$AGENT_CREDENTIAL_FILE"
  is_secret = true
}
prometheus.exporter.unix "host" {
}
prometheus.scrape "host" {
  targets = prometheus.exporter.unix.host.targets
  forward_to = [prometheus.remote_write.ingestion.receiver]
  scrape_interval = "15s"
}
prometheus.remote_write "ingestion" {
  endpoint {
    url = "$OLD_URL"
    authorization {
      type = "Bearer"
      credentials = local.file.agent_credential.content
    }
  }
}
EOF
  cp "$ALLOY_CONFIG_FILE" "$CASE_ROOT/original.config"
}

profile_apply() {
  local mode="${1:-preserve}" before_credential
  legacy_profile_fixture
  before_credential="$(stat -c '%i:%u:%g:%a:%s:%Y:%Z' "$AGENT_CREDENTIAL_FILE")"
  local args=(--apply-profile linux-baseline-v1) want="$OLD_URL"
  if [[ "$mode" == override ]]; then args+=(--gateway-url "$NEW_URL"); want="$NEW_URL"; fi
  (trap cleanup EXIT; main "${args[@]}") > "$CASE_ROOT/run.log" 2>&1
  has "$ALLOY_CONFIG_FILE" 'opsgrid.metrics_profile = linux-baseline-v1' 'profile must be applied'
  has "$ALLOY_CONFIG_FILE" 'scrape_interval = "30s"' 'profile must collect every 30 seconds'
  has "$ALLOY_CONFIG_FILE" "$want" 'profile must preserve existing Gateway unless overridden'
  has "$TEST_STATE/validated.config" 'opsgrid.metrics_profile = linux-baseline-v1' 'profile must validate before apply'
  eq "$(grep -c '^restart alloy.service$' "$TEST_STATE/calls")" 1 'profile must restart once'
  eq "$(stat -c '%i:%u:%g:%a:%s:%Y:%Z' "$AGENT_CREDENTIAL_FILE")" "$before_credential" 'profile must not touch credential'
  cmp -s "$AGENT_CREDENTIAL_FILE" "$CASE_ROOT/original.credential" || bad 'profile credential bytes'
  eq "$(stat -c '%a' "$ALLOY_CONFIG_FILE")" 640 'profile must preserve config mode'
  lacks "$ALLOY_CONFIG_FILE" AGT_ 'profile must not inline credential'
  lacks "$CASE_ROOT/run.log" AGT_TEST_ 'profile must not leak credential'
}

profile_noop() {
  profile_apply
  # Harmless comments/formatting are supported without hiding custom components.
  printf '\n// operator annotation\n' >> "$ALLOY_CONFIG_FILE"
  local before="$(stat -c '%i:%u:%g:%a:%s:%Y:%Z' "$ALLOY_CONFIG_FILE")"
  cp "$ALLOY_CONFIG_FILE" "$CASE_ROOT/applied.config"
  : > "$TEST_STATE/calls"
  (trap cleanup EXIT; main --apply-profile linux-baseline-v1) > "$CASE_ROOT/second.log" 2>&1
  eq "$(stat -c '%i:%u:%g:%a:%s:%Y:%Z' "$ALLOY_CONFIG_FILE")" "$before" 'same profile must not rewrite config'
  cmp -s "$ALLOY_CONFIG_FILE" "$CASE_ROOT/applied.config" || bad 'same profile bytes must remain unchanged'
  if grep -Eq '^(restart|start|stop|enable|disable) ' "$TEST_STATE/calls"; then bad 'same profile must not restart'; fi
}

profile_rejection() {
  local mode="$1" status=0 args=(--apply-profile linux-baseline-v1)
  case "$mode" in
    custom) printf '// opsgrid.metrics_profile = linux-baseline-v1\n' >> "$ALLOY_CONFIG_FILE" ;;
    split-token)
      legacy_profile_fixture
      sed -i 's/is_secret = true/is_secret = t rue/' "$ALLOY_CONFIG_FILE"
      ;;
    unknown) args=(--apply-profile arbitrary-profile) ;;
    conflict) args+=(--re-enroll --enrollment-token TEST_fresh_not_a_secret) ;;
    missing-value) args=(--apply-profile) ;;
    missing-agent) rm -- "$AGENT_CREDENTIAL_FILE" ;;
    tampered)
      legacy_profile_fixture
      sed -i 's/scrape_interval = "15s"/scrape_interval = "5s"/' "$ALLOY_CONFIG_FILE" ;;
  esac
  cp "$ALLOY_CONFIG_FILE" "$CASE_ROOT/before-reject.config"
  (trap cleanup EXIT; main "${args[@]}") > "$CASE_ROOT/run.log" 2>&1 || status=$?
  ((status != 0)) || bad 'unsafe profile invocation must fail'
  cmp -s "$ALLOY_CONFIG_FILE" "$CASE_ROOT/before-reject.config" || bad 'rejected profile must preserve config'
  if grep -Eq '^(restart|start|stop|enable|disable) ' "$TEST_STATE/calls"; then bad 'rejected profile must preserve service'; fi
  lacks "$CASE_ROOT/run.log" TEST_fresh_not_a_secret 'rejected profile token must not leak'
}

profile_failure() {
  local mode="$1" status=0 expected=40
  legacy_profile_fixture
  if [[ "$mode" == validation ]]; then touch "$TEST_STATE/fail-validation"
  else touch "$TEST_STATE/fail-restart-once"; expected=50; fi
  (trap cleanup EXIT; main --apply-profile linux-baseline-v1) > "$CASE_ROOT/run.log" 2>&1 || status=$?
  eq "$status" "$expected" 'profile stable failure exit'
  cmp -s "$ALLOY_CONFIG_FILE" "$CASE_ROOT/original.config" || bad 'profile failure must restore exact previous config'
  cmp -s "$AGENT_CREDENTIAL_FILE" "$CASE_ROOT/original.credential" || bad 'profile failure must preserve credential'
  eq "$(stat -c '%a' "$ALLOY_CONFIG_FILE")" 640 'profile rollback must preserve permissions'
  eq "$(<"$TEST_STATE/active")" active 'profile failure must restore service'
  lacks "$CASE_ROOT/run.log" 'rollback failed' 'profile rollback must succeed'
}

profile_launcher() {
  launcher
  unset TEST_INSTALLER_EXIT
  PATH="$CASE_ROOT/bin:$PATH" bash "$LAUNCHER" --apply-profile linux-baseline-v1 > "$CASE_ROOT/profile-launcher.log" 2>&1
  eq "$(<"$TEST_CAPTURE")" $'--apply-profile\nlinux-baseline-v1' 'launcher must forward profile without token'
}

# These probes catch repeated single-use POSTs, validation after consumption,
# lost parent-shell temp registrations, and destruction of failed-rollback data.
enrollment_transport() {
  local outcome="$1" status=0
  ENROLLMENT_TOKEN=TEST_transport_not_a_secret
  jq() {
    case "$1" in
      -n) printf '{"token":"TEST_transport_not_a_secret"}\n' ;;
      -e) return 0 ;;
      -er) printf 'AGT_TEST_transport_not_a_secret\n' ;;
      *) return 96 ;;
    esac
  }
  curl() {
    printf 'POST\n' >> "$CASE_ROOT/posts"
    local output=''
    while (($#)); do
      case "$1" in
        --output) output="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    printf '{"status":"ACTIVE","agentId":"agent","organizationId":"org","vmId":"vm","credential":"AGT_TEST_transport_not_a_secret"}' > "$output"
    case "$outcome" in
      curl*) printf '000'; return "${outcome#curl}" ;;
      *) printf '%s' "$outcome" ;;
    esac
  }
  sleep() { :; }
  (trap cleanup EXIT; post_enrollment) > "$CASE_ROOT/run.log" 2>&1 || status=$?
  if [[ "$outcome" == 201 ]]; then eq "$status" 0 'successful enrollment'
  else eq "$status" 30 'ambiguous enrollment stable exit'; fi
  eq "$(wc -l < "$CASE_ROOT/posts")" 1 'single-use enrollment must issue exactly one POST'
  lacks "$CASE_ROOT/run.log" TEST_transport_not_a_secret 'transport token/credential must not leak'
}

enrollment_prevalidation() {
  local mode="$1" status=0
  fresh_enrollment
  cp "$TEMPLATE" "$CASE_ROOT/template"
  resolve_script_paths() { SCRIPT_DIR="$ASSET_ROOT"; LINUX_TEMPLATE_FILE="$CASE_ROOT/template"; }
  case "$mode" in
    missing) rm "$CASE_ROOT/template" ;;
    placeholders) printf '// missing placeholders\n' > "$CASE_ROOT/template" ;;
    secret) printf '\n// AGT_TEST_inline_not_a_secret\n' >> "$CASE_ROOT/template" ;;
    syntax) sed -i 's/is_secret = true/is_secret = t rue/' "$CASE_ROOT/template" ;;
    identity) export TEST_USER=opsgrid_missing_test_user TEST_GROUP=root ;;
    credential-link) rm "$AGENT_CREDENTIAL_FILE"; ln -s "$CASE_ROOT/original.credential" "$AGENT_CREDENTIAL_FILE" ;;
    config-link) rm "$ALLOY_CONFIG_FILE"; ln -s "$CASE_ROOT/original.config" "$ALLOY_CONFIG_FILE" ;;
  esac
  (trap cleanup EXIT; main --re-enroll --enrollment-token TEST_fresh_not_a_secret) > "$CASE_ROOT/run.log" 2>&1 || status=$?
  ((status != 0)) || bad 'invalid local state must fail'
  [[ ! -e "$CASE_ROOT/enrolled" ]] || bad 'local validation must precede single-use enrollment'
  lacks "$CASE_ROOT/run.log" TEST_fresh_not_a_secret 'prevalidation token must not leak'
  if grep -Eq '^(restart|start|stop|enable|disable) ' "$TEST_STATE/calls"; then bad 'prevalidation must not mutate service'; fi
}

fresh_package_failure() {
  local failure_phase="$1" package_effect="$2" status=0
  rm -- "$AGENT_CREDENTIAL_FILE" "$ALLOY_CONFIG_FILE"
  printf 'inactive\n' > "$TEST_STATE/active"
  printf 'disabled\n' > "$TEST_STATE/enabled"
  # Hide the unit until the simulated package install. Real installation
  # detection captures the absent pre-run files/service and directory metadata.
  systemctl() {
    if [[ ! -f "$CASE_ROOT/package-installed" ]]; then
      case "$1" in
        cat|show|is-active|is-enabled) return 1 ;;
      esac
    fi
    "$CASE_ROOT/bin/systemctl" "$@"
  }
  install_alloy_official() {
    touch "$CASE_ROOT/package-installed"
    if [[ "$package_effect" != service ]]; then
      cp "$CASE_ROOT/original.config" "$ALLOY_CONFIG_FILE"
      chmod 640 "$ALLOY_CONFIG_FILE"
    fi
    if [[ "$package_effect" != config ]]; then
      printf 'active\n' > "$TEST_STATE/active"
      printf 'enabled\n' > "$TEST_STATE/enabled"
    fi
  }
  jq() {
    [[ "$1" == -n ]] || return 96
    printf '{"token":"TEST_fresh_package_not_a_secret"}\n'
  }
  curl() {
    printf 'POST\n' >> "$CASE_ROOT/posts"
    # An ambiguous send/receive failure may have consumed the token server-side.
    printf '000'
    return 28
  }
  if [[ "$failure_phase" == validation ]]; then touch "$TEST_STATE/fail-validation"; fi
  (trap cleanup EXIT; main --enrollment-token TEST_fresh_package_not_a_secret) > "$CASE_ROOT/run.log" 2>&1 || status=$?
  if [[ "$failure_phase" == validation ]]; then
    eq "$status" 40 'fresh package validation failure stable exit'
    [[ ! -e "$CASE_ROOT/posts" ]] || bad 'fresh package validation must precede POST'
  else
    eq "$status" 30 'fresh package ambiguous enrollment stable exit'
    eq "$(wc -l < "$CASE_ROOT/posts")" 1 'fresh package ambiguous POST must not retry'
  fi
  [[ -f "$CASE_ROOT/package-installed" ]] || bad 'fresh package fixture must install'
  [[ ! -e "$AGENT_CREDENTIAL_FILE" && ! -L "$AGENT_CREDENTIAL_FILE" ]] || bad 'fresh package failure must restore absent credential'
  [[ ! -e "$ALLOY_CONFIG_FILE" && ! -L "$ALLOY_CONFIG_FILE" ]] || bad 'fresh package failure must remove package-created config'
  eq "$(<"$TEST_STATE/active")" inactive 'fresh package failure must stop newly created service'
  eq "$(<"$TEST_STATE/enabled")" disabled 'fresh package failure must disable newly created service'
  lacks "$CASE_ROOT/run.log" 'rollback failed' 'fresh package rollback must verify baseline'
  lacks "$CASE_ROOT/run.log" TEST_fresh_package_not_a_secret 'fresh package token must not leak'
}

repo_temporary_cleanup() {
  local mode="$1" artifact="${ALLOY_CONFIG_FILE%/*}/repository.fixture"
  printf 'original\n' > "$artifact"
  begin_repo_transaction
  prepare_repo_artifact "$artifact" || bad 'repository snapshot preparation'
  write_atomic_artifact "$artifact" updated 644 || bad 'repository staged write'
  if [[ "$mode" == commit ]]; then
    repo_transaction_commit || bad 'repository commit'
    eq "$(<"$artifact")" updated 'committed repository content'
  else
    repo_transaction_rollback || bad 'repository rollback'
    eq "$(<"$artifact")" original 'rolled-back repository content'
  fi
  local leftover
  for leftover in "${ALLOY_CONFIG_FILE%/*}"/.opsgrid-agent-install.*; do
    [[ ! -e "$leftover" ]] || bad 'repository cleanup lost temporary registration'
  done
}

repository_recovery() {
  local recovery_artifact_kind="$1" recovery_operation="$2" status=0 recovery_backup='' recovery_metadata='' recovery_temporary=''
  local recovery_artifact="${ALLOY_CONFIG_FILE%/*}/recovery.$recovery_artifact_kind"
  local success_artifact="${ALLOY_CONFIG_FILE%/*}/success.fixture"
  local unchanged_artifact="${ALLOY_CONFIG_FILE%/*}/unchanged.fixture"
  printf 'original-%s\n' "$recovery_artifact_kind" > "$recovery_artifact"
  chmod 640 "$recovery_artifact"
  cp "$recovery_artifact" "$CASE_ROOT/expected.original"
  printf 'original-success\n' > "$success_artifact"
  printf 'original-unchanged\n' > "$unchanged_artifact"
  mv() {
    if [[ -f "$CASE_ROOT/restore-phase" && ( "$recovery_operation" == mv || "$recovery_operation" == metadata ) && "${@: -1}" == "$recovery_artifact" ]]; then return 1; fi
    command mv "$@"
  }
  chmod() {
    if [[ -f "$CASE_ROOT/restore-phase" && "$recovery_operation" == chmod && "$1" == 640 ]] && cmp -s "${@: -1}" "$CASE_ROOT/expected.original"; then return 1; fi
    command chmod "$@"
  }
  chown() {
    if [[ -f "$CASE_ROOT/restore-phase" && "$recovery_operation" == chown ]] && cmp -s "${@: -1}" "$CASE_ROOT/expected.original"; then return 1; fi
    command chown "$@"
  }
  printf() {
    if [[ -f "$CASE_ROOT/restore-phase" && "$recovery_operation" == metadata && "$1" == 'artifact_path=%q'* ]]; then return 1; fi
    command printf "$@"
  }
  (
    trap cleanup EXIT
    begin_repo_transaction
    prepare_repo_artifact "$recovery_artifact"
    prepare_repo_artifact "$success_artifact"
    prepare_repo_artifact "$unchanged_artifact"
    write_atomic_artifact "$recovery_artifact" updated-failed 644
    write_atomic_artifact "$success_artifact" updated-success 644
    printf '%s' "${REPO_ARTIFACT_BACKUPS[0]}" > "$CASE_ROOT/expected.backup"
    make_artifact_temp "$recovery_artifact" temporary
    printf '%s' TEST_repository_staging_not_a_secret > "$temporary"
    create_temp_root
    printf '%s' "$TEMP_ROOT" > "$CASE_ROOT/temp-root"
    ENROLLMENT_REQUEST_FILE="$TEMP_ROOT/request.probe"
    printf '%s' TEST_repository_request_not_a_secret > "$ENROLLMENT_REQUEST_FILE"
    track_temp_file "$ENROLLMENT_REQUEST_FILE"
    touch "$CASE_ROOT/restore-phase"
    fail 'enrollment failed' 30
  ) > "$CASE_ROOT/run.log" 2>&1 || status=$?
  eq "$status" 30 'repository restore failure retains primary exit'
  has "$CASE_ROOT/run.log" 'rollback failed' 'repository restore failure must be explicit'
  recovery_backup="$(<"$CASE_ROOT/expected.backup")"
  [[ -f "$recovery_backup" && ! -L "$recovery_backup" ]] || bad 'failed repository restore must retain sole original'
  cmp -s "$recovery_backup" "$CASE_ROOT/expected.original" || bad 'repository recovery original content'
  eq "$(stat -c '%u:%g:%a' "$recovery_backup")" 0:0:600 'repository recovery original remains root-only'
  recovery_metadata="$recovery_backup.recovery.meta"
  [[ -f "$recovery_metadata" && ! -L "$recovery_metadata" ]] || bad 'repository recovery metadata must remain'
  eq "$(stat -c '%u:%g:%a' "$recovery_metadata")" 0:0:600 'repository recovery metadata root-only'
  if [[ "$recovery_operation" == metadata ]]; then
    has "$CASE_ROOT/run.log" 'recovery metadata could not be written; original retained' 'metadata write failure must be explicit'
    has "$CASE_ROOT/run.log" "Repository recovery backup retained at: $recovery_backup" 'metadata failure must log safe original path'
    [[ ! -s "$recovery_metadata" ]] || bad 'failed metadata fixture must not write payloads'
  else
    has "$recovery_metadata" "$recovery_artifact" 'repository recovery target metadata'
    has "$recovery_metadata" 'mode=640' 'repository recovery original mode metadata'
  fi
  eq "$(<"$success_artifact")" original-success 'other repository artifact must restore'
  eq "$(<"$unchanged_artifact")" original-unchanged 'unchanged repository artifact must remain'
  for recovery_temporary in "${ALLOY_CONFIG_FILE%/*}"/.opsgrid-agent-install.*; do
    [[ ! -e "$recovery_temporary" || "$recovery_temporary" == "$recovery_backup" || "$recovery_temporary" == "$recovery_metadata" ]] || bad 'retain only failed repository original and metadata'
  done
  [[ ! -e "$(<"$CASE_ROOT/temp-root")" ]] || bad 'repository recovery must not retain enrollment temporary root'
  lacks "$CASE_ROOT/run.log" TEST_repository_ 'repository recovery must not log request/staging payloads'
  lacks "$recovery_metadata" TEST_repository_ 'repository recovery metadata must not contain payloads'
}

rollback_recovery() {
  local recovery_failure_mode="${1:-stop}" status=0 snapshot='' temp_root=''
  # Inject external failures only after apply; the snapshot/restore flow is real.
  systemctl() {
    if [[ "$1" == "$recovery_failure_mode" && ( "$recovery_failure_mode" == stop || "$recovery_failure_mode" == start ) ]]; then return 1; fi
    "$CASE_ROOT/bin/systemctl" "$@"
  }
  mv() {
    if [[ "$recovery_failure_mode" == file && "$*" == *'.opsgrid-agent-restore.'* ]]; then return 1; fi
    command mv "$@"
  }
  touch "$TEST_STATE/fail-restart-once"
  fresh_enrollment
  post_enrollment() {
    create_temp_root
    ENROLLMENT_REQUEST_FILE="$TEMP_ROOT/enrollment-request.probe"
    ENROLLMENT_RESPONSE_FILE="$TEMP_ROOT/enrollment-response.probe"
    printf '%s' TEST_fresh_not_a_secret > "$ENROLLMENT_REQUEST_FILE"
    printf '%s' AGT_TEST_fresh_not_a_secret > "$ENROLLMENT_RESPONSE_FILE"
    track_temp_file "$ENROLLMENT_REQUEST_FILE"
    track_temp_file "$ENROLLMENT_RESPONSE_FILE"
    ENROLLED_CREDENTIAL=AGT_TEST_fresh_not_a_secret
  }
  (
    trap cleanup EXIT
    main --re-enroll --enrollment-token TEST_fresh_not_a_secret
  ) > "$CASE_ROOT/run.log" 2>&1 || status=$?
  eq "$status" 50 'failed restore retains primary exit'
  if ! grep -Fq 'rollback failed' "$CASE_ROOT/run.log"; then cat "$CASE_ROOT/run.log"; bad 'failed restore must be explicit'; fi
  snapshot="$(sed -n 's/.*Recovery snapshot retained at: //p' "$CASE_ROOT/run.log")"
  [[ -n "$snapshot" && -d "$snapshot" ]] || bad 'failed rollback must retain protected recovery snapshot'
  case "$snapshot" in /tmp/opsgrid-agent.*/task4-state.*) ;; *) bad 'unexpected recovery snapshot path' ;; esac
  temp_root="${snapshot%/*}"
  eq "$(stat -c '%u:%g:%a' "$temp_root")" 0:0:700 'recovery parent root-only'
  eq "$(stat -c '%u:%g:%a' "$snapshot")" 0:0:700 'recovery snapshot root-only'
  cmp -s "$snapshot/credential.content" "$CASE_ROOT/original.credential" || bad 'recoverable previous credential'
  cmp -s "$snapshot/config.content" "$CASE_ROOT/original.config" || bad 'recoverable previous config'
  [[ -f "$snapshot/recovery.meta" ]] || bad 'recovery metadata must describe directories and service state'
  local file
  for file in "$temp_root"/* "$temp_root"/.[!.]* "$temp_root"/..?*; do
    [[ ! -e "$file" || "$file" == "$snapshot" ]] || bad 'recovery must not retain enrollment/raw temporary data'
  done
  lacks "$CASE_ROOT/run.log" TEST_fresh_not_a_secret 'recovery token must not leak'
  lacks "$CASE_ROOT/run.log" AGT_TEST_ 'recovery credential must not leak'
  rm -rf -- "$temp_root"
}

for outcome in curl28 curl52 curl55 curl56 408 429 500 503 201; do
  run "single-use enrollment $outcome performs one POST" enrollment_transport "$outcome"
done
for mode in missing placeholders secret syntax identity credential-link config-link; do
  run "enrollment prevalidation $mode never consumes token" enrollment_prevalidation "$mode"
done
for failure_phase in validation ambiguous; do
  for package_effect in config service both; do
    run "fresh package $package_effect rollback after $failure_phase failure" fresh_package_failure "$failure_phase" "$package_effect"
  done
done
run 'repository temporary cleanup after commit' repo_temporary_cleanup commit
run 'repository temporary cleanup after rollback' repo_temporary_cleanup rollback
for artifact_kind in list gpg; do
  for recovery_operation in mv chmod chown metadata; do
    run "failed repository $artifact_kind $recovery_operation restore preserves original" repository_recovery "$artifact_kind" "$recovery_operation"
  done
done
for mode in stop file start; do
  run "failed rollback $mode preserves only protected recovery snapshot" rollback_recovery "$mode"
done
run 'Gateway default, normalization and unsafe URL rejection' urls
run 'render exactly one Gateway placeholder without credential leaks' rendering
run 'stage only ingestion URL and reject ambiguous configs' staging
run 'same URL preserves credential/config and never restarts service' unchanged
run 'same URL preserves missing final newline without restarting' unchanged no-newline
run 'changed Gateway preserves private mode 600' private_mode 600
run 'changed Gateway preserves private mode 640' private_mode 640
run 'non-root vendor root:alloy 750 config directory reconciles' vendor_layout 750
run 'non-root vendor root:alloy 770 config directory reconciles' vendor_layout 770
run 'tokenless existing-agent rerun skips enrollment/install and applies default' rerun none
run 'obsolete-token rerun skips enrollment/install without leaking token' rerun obsolete
run 'explicit re-enroll consumes fresh token and applies override' reenroll
run 'staging failure leaves healthy service and files untouched' failure_rollback staging
run 'validation failure leaves healthy service and files untouched' failure_rollback validation
run 'restart failure uses real EXIT rollback' failure_rollback restart
run 'failed re-enroll restores previous config and credential' failure_rollback reenroll
run 'launcher optional token, exact forwarding, failure propagation and no leaks' launcher
run 'Linux profile upgrades legacy config and preserves Gateway/credential' profile_apply
run 'Linux profile accepts explicit Gateway override' profile_apply override
run 'Linux profile reapply is exact no-op' profile_noop
run 'Linux profile refuses arbitrary custom config despite marker' profile_rejection custom
run 'Linux profile rejects unknown profile' profile_rejection unknown
run 'Linux profile refuses re-enrollment combination' profile_rejection conflict
run 'Linux profile requires argument' profile_rejection missing-value
run 'Linux profile requires installed agent without enrolling' profile_rejection missing-agent
run 'Linux profile refuses invalid split-token legacy config' profile_rejection split-token
run 'Linux profile refuses modified legacy scrape' profile_rejection tampered
run 'Linux profile validation failure does not change config' profile_failure validation
run 'Linux profile restart failure restores old config' profile_failure restart
run 'Linux launcher forwards explicit profile update without token' profile_launcher
printf '[opsgrid-agent] %s regression groups passed.\n' "$COUNT"
