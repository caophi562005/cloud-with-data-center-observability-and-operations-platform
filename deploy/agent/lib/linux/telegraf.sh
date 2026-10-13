# Native one-shot bootstrap. No collector/helper loop runs in this shell.
OPSGRID_RELEASE_COLLECTOR='telegraf'
TG_BUILD_ID='opsgrid-custom-6ab4b57bbaede19d'
TG_RELEASE_URL="https://github.com/caophi562005/cloud-with-data-center-observability-and-operations-platform/releases/download/${TG_BUILD_ID}"
TG_STATE='/etc/opsgrid-agent'
TG_BIN_DIR='/usr/local/lib/opsgrid-agent'
TG_BIN="${TG_BIN_DIR}/opsgrid-agent"
TG_UNIT='/etc/systemd/system/opsgrid-agent.service'
TG_MUTATED=0
TG_COMMITTED=0
TG_ENROLL_DISPATCHED=0
TG_OLD_ACTIVE=0
TG_OLD_ENABLED=0
TG_NATIVE_ACTIVE=0
TG_NATIVE_ENABLED=0
TG_UNIT_EXISTED=0
TG_BINARY_EXISTED=0
TG_PERMISSION_PATHS=()
TG_PERMISSION_VALUES=()

telegraf_validate_urls() {
  python3 - "$API_BASE_URL" "$GATEWAY_URL" <<'PY'
import sys, urllib.parse
for i, value in enumerate(sys.argv[1:]):
    u = urllib.parse.urlsplit(value)
    if (value != value.strip() or any(ord(c)<33 or ord(c)==127 for c in value) or
        '\\' in value or u.scheme != 'https' or not u.hostname or u.username is not None or
        u.password is not None or '?' in value or '#' in value or not (1 <= (u.port or 443) <= 65535)):
        raise SystemExit(1)
    if i == 0 and (u.path or value.endswith('/')):
        raise SystemExit(1)
    if i == 1 and u.path != '/api/v1/write':
        raise SystemExit(1)
PY
}

telegraf_safe_file() {
  local mode
  [[ ! -L "$1" && -f "$1" && "$(stat -c '%u:%h' -- "$1")" == '0:1' ]] || return 1
  mode="$(stat -c '%a' -- "$1")" || return 1
  (( (8#$mode & 0022) == 0 ))
}

telegraf_capture_permissions() {
  TG_PERMISSION_PATHS+=("$1")
  TG_PERMISSION_VALUES+=("$(stat -c '%u:%g:%a' -- "$1")")
}

telegraf_cleanup() {
  local rc=$? i uid gid mode rollback_failed=0 native_quiescent=0 native_state='' native_pid=''
  trap - EXIT
  ENROLLMENT_TOKEN=''
  unset OPSGRID_ENROLLMENT_TOKEN
  if ((TG_MUTATED && ! TG_COMMITTED)); then
    # Restoring files/permissions or resuming Alloy is safe only after proven native quiescence.
    if systemctl stop opsgrid-agent.service >/dev/null 2>&1 &&
       native_state="$(systemctl show -p ActiveState --value opsgrid-agent.service 2>/dev/null)" &&
       native_pid="$(systemctl show -p MainPID --value opsgrid-agent.service 2>/dev/null)" &&
       [[ "$native_state" == inactive || "$native_state" == failed ]] && [[ "$native_pid" == 0 ]]; then
      native_quiescent=1
    else
      rollback_failed=1
    fi
    systemctl disable opsgrid-agent.service >/dev/null 2>&1 || rollback_failed=1
    if ((native_quiescent)); then
      if ((TG_BINARY_EXISTED)); then
        cp -p -- "$TEMP_ROOT/native.previous" "$TG_BIN" || rollback_failed=1
      fi
      if ((TG_UNIT_EXISTED)); then
        cp -p -- "$TEMP_ROOT/unit.previous" "$TG_UNIT" || rollback_failed=1
      fi
      # Newly owned unit/binary remain for operator recovery with startup disabled.
      systemctl daemon-reload >/dev/null 2>&1 || rollback_failed=1
      if (( ! TG_ENROLL_DISPATCHED )); then
        for ((i=${#TG_PERMISSION_PATHS[@]}-1; i>=0; i--)); do
          IFS=: read -r uid gid mode <<< "${TG_PERMISSION_VALUES[i]}"
          chown "$uid:$gid" -- "${TG_PERMISSION_PATHS[i]}" && chmod "$mode" -- "${TG_PERMISSION_PATHS[i]}" || rollback_failed=1
        done
        if (( ! rollback_failed )); then
          if ((TG_NATIVE_ENABLED)); then systemctl enable opsgrid-agent.service >/dev/null 2>&1 || rollback_failed=1; fi
          if ((TG_NATIVE_ACTIVE)); then systemctl start opsgrid-agent.service >/dev/null 2>&1 || rollback_failed=1; fi
          if ((TG_OLD_ENABLED)); then systemctl enable alloy.service >/dev/null 2>&1 || rollback_failed=1; fi
          if ((TG_OLD_ACTIVE)); then systemctl start alloy.service >/dev/null 2>&1 || rollback_failed=1; fi
        fi
      else
        if [[ "$(systemctl show -p LoadState --value alloy.service)" != not-found ]]; then systemctl disable alloy.service >/dev/null 2>&1 || rollback_failed=1; fi
        log 'Enrollment may have committed remotely; protected identity/credential retained, native runtime quiescent, legacy collector not resumed. Operator recovery required; do not blindly retry a consumed code.' >&2
      fi
    else
      if [[ "$(systemctl show -p LoadState --value alloy.service)" != not-found ]]; then systemctl disable alloy.service >/dev/null 2>&1 || rollback_failed=1; fi
      log 'Native stop failed or quiescence is unknown; protected state retained, no files/permissions restored and no collectors resumed. Native runtime may still be live; operator recovery required.' >&2
    fi
  fi
  if ((rollback_failed)); then log 'Local activation rollback incomplete; operator recovery required.' >&2; ((rc != 0)) || rc=50; fi
  # Only the private directory created by create_temp_root is removed.
  if [[ -n "$TEMP_ROOT" && "$TEMP_ROOT" == /tmp/opsgrid-agent.* && ! -L "$TEMP_ROOT" ]]; then
    rm -rf -- "$TEMP_ROOT" || { ((rc != 0)) || rc=50; }
  fi
  exit "$rc"
}

telegraf_fetch() {
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error --location \
    --connect-timeout 15 --max-time 180 --output "$2" "$TG_RELEASE_URL/$1" 2>/dev/null
}

telegraf_main() {
  local bootstrap_token="${OPSGRID_ENROLLMENT_TOKEN:-}"
  unset OPSGRID_ENROLLMENT_TOKEN
  parse_args "$@"
  trap telegraf_cleanup EXIT
  if ((SHOW_HELP)); then
    log 'Usage: install.sh [--enrollment-token ENR_CODE] [--api-base-url HTTPS_ORIGIN] [--gateway-url HTTPS_WRITE_URL] [--re-enroll]'
    log 'Prefer temporary OPSGRID_ENROLLMENT_TOKEN or interactive input. Explicit token arguments may remain in shell history/initial process argv. Native/service argv never contain a token.'
    return 0
  fi
  [[ -z "$APPLY_PROFILE" ]] || fail 'legacy Alloy profile option is not supported for native Telegraf'
  [[ "$EUID" == 0 && "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || fail 'native release supports Linux AMD64 with root and systemd only'
  local command_name file name digest i
  for command_name in curl python3 sha256sum stat realpath flock systemctl install cp mv chmod chown mktemp; do
    command -v "$command_name" >/dev/null 2>&1 || fail 'required native bootstrap command unavailable'
  done
  telegraf_validate_urls || fail 'native API/write endpoints must use valid HTTPS pins'
  acquire_lock
  create_temp_root
  # The manifest is obtained independently from the fixed HTTPS release origin,
  # never trusted merely because a local binary has an adjacent receipt.
  telegraf_fetch release-manifest.json "$TEMP_ROOT/release-manifest.json" || fail 'trusted HTTPS release metadata unavailable' 20
  python3 - "$TEMP_ROOT/release-manifest.json" "$TG_BUILD_ID" > "$TEMP_ROOT/native-assets" <<'PY'
import json, sys
m=json.load(open(sys.argv[1]))
assert m['schemaVersion']==1 and m['collector']=='telegraf' and m['buildID']==sys.argv[2]
n=next(x for x in m['native'] if x['target']=='linux-amd64')
assert n['binary']=='opsgrid-agent-linux-amd64' and n['provenance']['customLifecycleImplemented'] is True
assert n['sha256']=='6f96523b7d44bb1283bbe5af3bc5a6241c013868a80cd4191549c51588966e56'
assert n['dependenciesLicense']=='LICENSE_OF_DEPENDENCIES.telegraf.md'
for name in (n['binary'],n['buildIdentity'],n['license'],n['metricsContract'],n['dependenciesLicense']):
    assert name in ('opsgrid-agent-linux-amd64','linux-amd64.build-identity.json','linux-amd64.LICENSE.telegraf','linux-amd64.metrics-contract.json','LICENSE_OF_DEPENDENCIES.telegraf.md')
    a=[a for a in m['assets'] if a['name']==name]
    assert len(a)==1 and len(a[0]['sha256'])==64 and all(c in '0123456789abcdef' for c in a[0]['sha256'])
    if name==n['binary']: assert a[0]['sha256']==n['sha256']
    print(name, a[0]['sha256'])
PY
  [[ $? == 0 ]] || fail 'native release metadata invalid' 20
  while read -r name digest; do
    telegraf_fetch "$name" "$TEMP_ROOT/$name" || fail 'native release asset download failed' 20
    [[ "$(sha256sum "$TEMP_ROOT/$name" | cut -d' ' -f1)" == "$digest" ]] || fail 'native release SHA256 mismatch' 20
  done < "$TEMP_ROOT/native-assets"
  secure_artifact_directory /etc && secure_artifact_directory /usr/local/lib && secure_artifact_directory /etc/systemd/system || fail 'owned native installation parent is unsafe' 20
  if [[ -e "$TG_STATE" || -L "$TG_STATE" ]]; then
    # Accept legacy root:alloy 0750 only at this exact root-owned path, then tighten it.
    # Shared parents retain strict root:root checks; untrusted writes are never accepted.
    [[ ! -L "$TG_STATE" && -d "$TG_STATE" && "$(realpath -e -- "$TG_STATE")" == "$TG_STATE" && "$(stat -c '%u' -- "$TG_STATE")" == 0 ]] || fail 'managed state directory is unsafe' 40
    local state_mode="$(stat -c '%a' -- "$TG_STATE")"
    (( (8#$state_mode & 0022) == 0 )) || fail 'managed state directory permits untrusted writes' 40
    task4_capture_directory_metadata "$TG_STATE" credential || fail 'state metadata unavailable' 40
    telegraf_capture_permissions "$TG_STATE"
  fi
  # Only known, root-owned state files may have their legacy Alloy permissions tightened.
  for file in "$TG_STATE"/* "$TG_STATE"/.[!.]* "$TG_STATE"/..?*; do
    [[ -e "$file" || -L "$file" ]] || continue
    case "${file##*/}" in agent.credential|identity.json|config-state.json|current.toml|candidate.toml|previous.toml|runtime.lock) ;;
      *) fail 'unknown managed state entry; operator review required' 40;; esac
    telegraf_safe_file "$file" || fail 'managed state file is unsafe' 40
    telegraf_capture_permissions "$file"
  done
  if [[ -e "$TG_BIN_DIR" || -L "$TG_BIN_DIR" ]]; then secure_artifact_directory "$TG_BIN_DIR" || fail 'native binary directory unsafe' 20; fi
  if [[ -e "$TG_BIN" || -L "$TG_BIN" ]]; then
    telegraf_safe_file "$TG_BIN" || fail 'existing native binary unsafe' 20
    [[ "$(sha256sum "$TG_BIN" | cut -d' ' -f1)" == '6f96523b7d44bb1283bbe5af3bc5a6241c013868a80cd4191549c51588966e56' ]] || fail 'unrecognized existing native binary; operator review required' 20
    cp -p -- "$TG_BIN" "$TEMP_ROOT/native.previous"
    TG_BINARY_EXISTED=1
  fi
  if [[ -e "$TG_UNIT" || -L "$TG_UNIT" ]]; then
    telegraf_safe_file "$TG_UNIT" && grep -Fxq '# OpsGrid managed native service' "$TG_UNIT" || fail 'unrecognized existing native service unit' 20
    cp -p -- "$TG_UNIT" "$TEMP_ROOT/unit.previous"
    TG_UNIT_EXISTED=1
  elif [[ "$(systemctl show -p LoadState --value opsgrid-agent.service)" != not-found ]]; then
    fail 'native service exists outside the owned unit path' 20
  fi
  cat > "$TEMP_ROOT/opsgrid-agent.service" <<'UNIT'
# OpsGrid managed native service
[Unit]
Description=OpsGrid native Telegraf collector
After=network-online.target
Wants=network-online.target
[Service]
Type=notify
NotifyAccess=main
User=root
Group=root
UMask=0077
ExecStart=/usr/local/lib/opsgrid-agent/opsgrid-agent --opsgrid-managed --state-dir /etc/opsgrid-agent
Restart=on-failure
RestartSec=10
TimeoutStartSec=120
TimeoutStopSec=120
[Install]
WantedBy=multi-user.target
UNIT
  if systemctl is-active --quiet alloy.service; then TG_OLD_ACTIVE=1; fi
  if systemctl is-enabled --quiet alloy.service; then TG_OLD_ENABLED=1; fi
  if systemctl is-active --quiet opsgrid-agent.service; then TG_NATIVE_ACTIVE=1; fi
  if systemctl is-enabled --quiet opsgrid-agent.service; then TG_NATIVE_ENABLED=1; fi
  TG_MUTATED=1
  # No overlapping delivery, including during explicit recovery or state hardening.
  if [[ "$(systemctl show -p LoadState --value alloy.service)" != not-found ]]; then systemctl stop alloy.service || fail 'cannot stop legacy Alloy' 50; fi
  if ((TG_UNIT_EXISTED)); then systemctl stop opsgrid-agent.service || fail 'cannot stop managed runtime' 50; fi
  install -d -o root -g root -m 700 "$TG_STATE" "$TG_BIN_DIR"
  for file in "${TG_PERMISSION_PATHS[@]}"; do
    [[ "$file" != "$TG_STATE" ]] || continue
    chown root:root -- "$file" && chmod 600 -- "$file" || fail 'managed state protection failed' 40
  done
  [[ ! -e "$TG_BIN_DIR/.opsgrid-agent.new" && ! -L "$TG_BIN_DIR/.opsgrid-agent.new" ]] || fail 'native staging target already exists; operator review required' 40
  install -o root -g root -m 700 "$TEMP_ROOT/opsgrid-agent-linux-amd64" "$TG_BIN_DIR/.opsgrid-agent.new"
  mv -f -- "$TG_BIN_DIR/.opsgrid-agent.new" "$TG_BIN"
  for name in linux-amd64.build-identity.json linux-amd64.LICENSE.telegraf linux-amd64.metrics-contract.json LICENSE_OF_DEPENDENCIES.telegraf.md; do
    [[ ! -e "$TG_BIN_DIR/$name" && ! -L "$TG_BIN_DIR/$name" ]] || telegraf_safe_file "$TG_BIN_DIR/$name" || fail 'unsafe native metadata target' 40
    install -o root -g root -m 600 "$TEMP_ROOT/$name" "$TG_BIN_DIR/$name"
  done
  install -o root -g root -m 644 "$TEMP_ROOT/opsgrid-agent.service" "$TG_UNIT"
  systemctl daemon-reload || fail 'native service preparation failed' 50
  local enroll_args=(opsgrid-enroll --api-url "$API_BASE_URL" --metrics-url "$GATEWAY_URL" --state-dir "$TG_STATE" --token-stdin)
  if ((RE_ENROLL)); then enroll_args+=(--re-enroll); fi
  if (( ! RE_ENROLL )) && [[ -e "$TG_STATE/identity.json" ]]; then
    "$TG_BIN" "${enroll_args[@]}" </dev/null || fail 'protected identity reuse failed; explicit operator recovery required' 30
  else
    if [[ -z "$ENROLLMENT_TOKEN" ]]; then ENROLLMENT_TOKEN="$bootstrap_token"; fi
    unset OPSGRID_ENROLLMENT_TOKEN
    if [[ -z "$ENROLLMENT_TOKEN" && -t 0 ]]; then read -r -s -p '[opsgrid-agent] One-use enrollment code: ' ENROLLMENT_TOKEN; printf '\n'; fi
    [[ "$ENROLLMENT_TOKEN" =~ ^ENR_[A-Za-z0-9_-]+$ && ${#ENROLLMENT_TOKEN} -le 256 ]] || fail 'bounded ENR code required' 10
    TG_ENROLL_DISPATCHED=1
    printf '%s' "$ENROLLMENT_TOKEN" | "$TG_BIN" "${enroll_args[@]}" || fail 'enrollment failed or outcome unknown; operator recovery required' 30
  fi
  ENROLLMENT_TOKEN=''
  unset OPSGRID_ENROLLMENT_TOKEN
  systemctl enable opsgrid-agent.service >/dev/null || fail 'native service enable failed' 50
  systemctl start opsgrid-agent.service || fail 'native service readiness failed' 50
  systemctl is-active --quiet opsgrid-agent.service || fail 'native service is not active' 50
  # Preserve Alloy installation/configuration; prevent it overlapping after reboot.
  if [[ "$(systemctl show -p LoadState --value alloy.service)" != not-found ]]; then
    systemctl disable alloy.service >/dev/null || fail 'cannot disable legacy Alloy startup' 50
  fi
  TG_COMMITTED=1
  log 'Native service startup confirmed; bootstrap exits. Metrics delivery/applied revision are not proven by service startup.'
}
