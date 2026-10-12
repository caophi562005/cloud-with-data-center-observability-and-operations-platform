# [opsgrid-agent] Linux reconciliation definitions; loaded by install.sh.
# Loading this module does not install, enroll, or change service state.



validate_existing_agent() {
  local directory="${AGENT_CREDENTIAL_FILE%/*}"
  local config_directory="${ALLOY_CONFIG_FILE%/*}"
  local expected_gid='0' metadata='' content='' size=''
  local LC_ALL=C
  if [[ -L "$AGENT_CREDENTIAL_FILE" || ! -f "$AGENT_CREDENTIAL_FILE" || -L "$ALLOY_CONFIG_FILE" || ! -f "$ALLOY_CONFIG_FILE" ]]; then
    return 1
  fi
  # Validate ancestors as root-owned, but use service-aware permissions for
  # the existing leaf directories (root:alloy 0750/0770 are vendor layouts).
  if ! secure_artifact_directory "${directory%/*}" || ! secure_artifact_directory "${config_directory%/*}"; then
    return 1
  fi
  if [[ -L "$directory" || ! -d "$directory" ]] || [[ "$(realpath -e -- "$directory")" != "$directory" ]]; then
    return 1
  fi
  if ! secure_alloy_config_directory "${ALLOY_CONFIG_FILE%/*}" && ! secure_artifact_directory "${ALLOY_CONFIG_FILE%/*}"; then
    return 1
  fi
  if (( ! ALLOY_RUNTIME_ROOT )); then
    expected_gid="$(getent group "$ALLOY_RUNTIME_GROUP" | cut -d: -f3)" || return 1
    [[ -n "$expected_gid" ]] || return 1
  fi
  metadata="$(stat -c '%u:%g:%a' -- "$directory")" || return 1
  case "$metadata" in
    "0:$expected_gid:750") ;;
    '0:0:700') (( ALLOY_RUNTIME_ROOT )) || return 1 ;;
    *) return 1 ;;
  esac
  metadata="$(stat -c '%u:%g:%a' -- "$AGENT_CREDENTIAL_FILE")" || return 1
  case "$metadata" in
    "0:$expected_gid:640") ;;
    '0:0:600') (( ALLOY_RUNTIME_ROOT )) || return 1 ;;
    *) return 1 ;;
  esac
  metadata="$(stat -c '%u:%g:%a' -- "$ALLOY_CONFIG_FILE")" || return 1
  case "$metadata" in
    '0:0:644') ;;
    '0:0:640'|'0:0:600') (( ALLOY_RUNTIME_ROOT )) || return 1 ;;
    *) return 1 ;;
  esac
  size="$(stat -c '%s' -- "$AGENT_CREDENTIAL_FILE")" || return 1
  (( size >= 5 && size <= 512 )) || return 1
  # read preserves trailing newlines; byte-count comparison rejects NUL bytes.
  IFS= read -r -d '' content < "$AGENT_CREDENTIAL_FILE" || true
  [[ ${#content} -eq size && "$content" =~ ^AGT_[A-Za-z0-9_-]+$ ]]
}

reconcile_profile() {
  if ! get_alloy_runtime_group || ! validate_existing_agent || ! resolve_script_paths; then
    fail 'existing agent state is unsafe or incomplete; profile was not changed' 40
  fi
  if ! snapshot_state || ! stage_profile_update || ! validate_alloy_config; then
    fail 'profile config is unmanaged or invalid; no profile change was applied' 40
  fi
  if cmp -s -- "$TASK4_CONFIG_STAGE" "$ALLOY_CONFIG_FILE" && systemctl is-active --quiet alloy.service; then
    log 'Linux metrics profile is unchanged; Alloy is active. Credential and service were not changed.'
  else
    if ! apply_and_restart "$TASK4_SNAPSHOT_CONFIG_MODE" || ! wait_for_service; then
      fail 'service failed' 50
    fi
    log 'Linux baseline v1 applied (30s scrape). Existing credential and selected Gateway were preserved.'
  fi
  if ! task4_cleanup_temps; then
    fail 'service failed' 50
  fi
  task4_commit
}

reconcile_gateway() {
  if ! get_alloy_runtime_group || ! validate_existing_agent; then
    fail 'existing agent state is unsafe or incomplete; Gateway was not changed' 40
  fi
  if ! snapshot_state || ! stage_gateway_update || ! validate_alloy_config; then
    fail 'config validation failed' 40
  fi
  if cmp -s -- "$TASK4_CONFIG_STAGE" "$ALLOY_CONFIG_FILE" && systemctl is-active --quiet alloy.service; then
    log 'Gateway URL is unchanged; Alloy is active. Credential and service were not changed.'
  else
    if ! apply_and_restart "$TASK4_SNAPSHOT_CONFIG_MODE" || ! wait_for_service; then
      fail 'service failed' 50
    fi
    log 'Gateway configuration applied; Alloy is active. Existing credential was preserved.'
  fi
  if ! task4_cleanup_temps; then
    fail 'service failed' 50
  fi
  task4_commit
}
