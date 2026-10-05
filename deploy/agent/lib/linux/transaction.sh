# [opsgrid-agent] Linux transaction definitions; loaded by install.sh.
# Loading this module does not install, enroll, or change service state.

TASK4_TXN_ACTIVE=0
TASK4_TXN_COMMITTED=0
TASK4_ROLLBACK_DONE=0
TASK4_SNAPSHOT_READY=0
TASK4_SNAPSHOT_ROOT=''
TASK4_SNAPSHOT_CREDENTIAL_CONTENT=''
TASK4_SNAPSHOT_CONFIG_CONTENT=''
TASK4_SNAPSHOT_CREDENTIAL_EXISTS=0
TASK4_SNAPSHOT_CONFIG_EXISTS=0
TASK4_SNAPSHOT_CREDENTIAL_MODE=''
TASK4_SNAPSHOT_CREDENTIAL_UID=''
TASK4_SNAPSHOT_CREDENTIAL_GID=''
TASK4_SNAPSHOT_CONFIG_MODE=''
TASK4_SNAPSHOT_CONFIG_UID=''
TASK4_SNAPSHOT_CONFIG_GID=''
TASK4_SNAPSHOT_SERVICE_PRESENT=0
TASK4_SNAPSHOT_SERVICE_ACTIVE=0
TASK4_SNAPSHOT_SERVICE_ENABLED=0
TASK4_ORIGINAL_SERVICE_PRESENT=0
TASK4_ORIGINAL_SERVICE_ACTIVE=0
TASK4_ORIGINAL_SERVICE_ENABLED=0
TASK4_SERVICE_MUTATED=0
TASK4_CREDENTIAL_CHANGED=0
TASK4_CONFIG_CHANGED=0
TASK4_CREDENTIAL_DIR_PRE_EXISTS=0
TASK4_CREDENTIAL_DIR_PRE_MODE=''
TASK4_CREDENTIAL_DIR_PRE_UID=''
TASK4_CREDENTIAL_DIR_PRE_GID=''
TASK4_CREDENTIAL_DIR_CHANGED=0
TASK4_CONFIG_DIR_PRE_EXISTS=0
TASK4_CONFIG_DIR_PRE_MODE=''
TASK4_CONFIG_DIR_PRE_UID=''
TASK4_CONFIG_DIR_PRE_GID=''
TASK4_CONFIG_DIR_CHANGED=0
TASK4_CONFIG_DIR_CREATED=0
TASK4_CREDENTIAL_DIR_CREATED=0
PRE_TASK4_ROLLBACK_DONE=0
TASK4_CREDENTIAL_STAGE=''
TASK4_CONFIG_STAGE=''
TASK4_TEMP_FILES=()

task4_capture_directory_metadata() {
  local directory="$1"
  local kind="$2"
  local metadata=''
  local uid=''
  local gid=''
  local mode=''

  if [[ -L "$directory" || ( -e "$directory" && ! -d "$directory" ) ]]; then
    return 1
  fi
  if [[ -d "$directory" ]]; then
    if ! metadata="$(stat -c '%u:%g:%a' -- "$directory" 2>/dev/null)"; then
      return 1
    fi
    IFS=: read -r uid gid mode <<< "$metadata"
    if [[ "$kind" == 'credential' ]]; then
      TASK4_CREDENTIAL_DIR_PRE_EXISTS=1
      TASK4_CREDENTIAL_DIR_PRE_MODE="$mode"
      TASK4_CREDENTIAL_DIR_PRE_UID="$uid"
      TASK4_CREDENTIAL_DIR_PRE_GID="$gid"
    else
      TASK4_CONFIG_DIR_PRE_EXISTS=1
      TASK4_CONFIG_DIR_PRE_MODE="$mode"
      TASK4_CONFIG_DIR_PRE_UID="$uid"
      TASK4_CONFIG_DIR_PRE_GID="$gid"
    fi
    return 0
  fi
  if ! task4_validate_directory_parent "$directory"; then
    return 1
  fi
  if [[ "$kind" == 'credential' ]]; then
    TASK4_CREDENTIAL_DIR_PRE_EXISTS=0
    TASK4_CREDENTIAL_DIR_PRE_MODE=''
    TASK4_CREDENTIAL_DIR_PRE_UID=''
    TASK4_CREDENTIAL_DIR_PRE_GID=''
  else
    TASK4_CONFIG_DIR_PRE_EXISTS=0
    TASK4_CONFIG_DIR_PRE_MODE=''
    TASK4_CONFIG_DIR_PRE_UID=''
    TASK4_CONFIG_DIR_PRE_GID=''
  fi
}

task4_snapshot_file() {
  local source_path="$1"
  local kind="$2"
  local metadata=''
  local uid=''
  local gid=''
  local mode=''
  local exists=0
  local content_path="$TASK4_SNAPSHOT_ROOT/$kind.content"
  local metadata_path="$TASK4_SNAPSHOT_ROOT/$kind.meta"

  if [[ -L "$source_path" || ( -e "$source_path" && ! -f "$source_path" ) ]]; then
    return 1
  fi
  if [[ -f "$source_path" ]]; then
    exists=1
    if ! metadata="$(stat -c '%u:%g:%a' -- "$source_path" 2>/dev/null)"; then
      return 1
    fi
    IFS=: read -r uid gid mode <<< "$metadata"
    if ! cp -- "$source_path" "$content_path" >/dev/null 2>&1 || ! chmod 600 -- "$content_path" >/dev/null 2>&1; then
      return 1
    fi
  fi
  if ! printf '%s\n%s\n%s\n%s\n' "$exists" "$uid" "$gid" "$mode" > "$metadata_path"; then
    return 1
  fi
  if ! chmod 600 -- "$metadata_path" >/dev/null 2>&1; then
    return 1
  fi
  if [[ "$kind" == 'credential' ]]; then
    TASK4_SNAPSHOT_CREDENTIAL_EXISTS="$exists"
    TASK4_SNAPSHOT_CREDENTIAL_CONTENT="$content_path"
    TASK4_SNAPSHOT_CREDENTIAL_UID="$uid"
    TASK4_SNAPSHOT_CREDENTIAL_GID="$gid"
    TASK4_SNAPSHOT_CREDENTIAL_MODE="$mode"
  else
    TASK4_SNAPSHOT_CONFIG_EXISTS="$exists"
    TASK4_SNAPSHOT_CONFIG_CONTENT="$content_path"
    TASK4_SNAPSHOT_CONFIG_UID="$uid"
    TASK4_SNAPSHOT_CONFIG_GID="$gid"
    TASK4_SNAPSHOT_CONFIG_MODE="$mode"
  fi
}

task4_capture_service_state() {
  local current_present=0
  local current_active=0
  local current_enabled=0

  if ! task4_read_service_flags; then
    return 1
  fi
  current_present="$TASK4_CURRENT_SERVICE_PRESENT"
  current_active="$TASK4_CURRENT_SERVICE_ACTIVE"
  current_enabled="$TASK4_CURRENT_SERVICE_ENABLED"

  TASK4_SNAPSHOT_SERVICE_PRESENT="$current_present"
  TASK4_SNAPSHOT_SERVICE_ACTIVE="$current_active"
  TASK4_SNAPSHOT_SERVICE_ENABLED="$current_enabled"
  if (( ALLOY_PRE_RUN_CAPTURED )); then
    TASK4_ORIGINAL_SERVICE_PRESENT="$ALLOY_PRE_RUN_SERVICE_PRESENT"
    TASK4_ORIGINAL_SERVICE_ACTIVE="$ALLOY_PRE_RUN_SERVICE_ACTIVE"
    TASK4_ORIGINAL_SERVICE_ENABLED="$ALLOY_PRE_RUN_SERVICE_ENABLED"
  else
    TASK4_ORIGINAL_SERVICE_PRESENT="$current_present"
    TASK4_ORIGINAL_SERVICE_ACTIVE="$current_active"
    TASK4_ORIGINAL_SERVICE_ENABLED="$current_enabled"
  fi
}

task4_write_recovery_metadata() {
  # Only previous-state paths/metadata, never token or enrollment payload values.
  declare -p AGENT_CREDENTIAL_FILE ALLOY_CONFIG_FILE \
    TASK4_SNAPSHOT_CREDENTIAL_EXISTS TASK4_SNAPSHOT_CREDENTIAL_UID TASK4_SNAPSHOT_CREDENTIAL_GID TASK4_SNAPSHOT_CREDENTIAL_MODE \
    TASK4_SNAPSHOT_CONFIG_EXISTS TASK4_SNAPSHOT_CONFIG_UID TASK4_SNAPSHOT_CONFIG_GID TASK4_SNAPSHOT_CONFIG_MODE \
    TASK4_CREDENTIAL_DIR_PRE_EXISTS TASK4_CREDENTIAL_DIR_PRE_UID TASK4_CREDENTIAL_DIR_PRE_GID TASK4_CREDENTIAL_DIR_PRE_MODE \
    TASK4_CONFIG_DIR_PRE_EXISTS TASK4_CONFIG_DIR_PRE_UID TASK4_CONFIG_DIR_PRE_GID TASK4_CONFIG_DIR_PRE_MODE \
    TASK4_ORIGINAL_SERVICE_PRESENT TASK4_ORIGINAL_SERVICE_ACTIVE TASK4_ORIGINAL_SERVICE_ENABLED \
    > "$TASK4_SNAPSHOT_ROOT/recovery.meta" || return 1
  chmod 600 -- "$TASK4_SNAPSHOT_ROOT/recovery.meta" >/dev/null 2>&1
}

snapshot_state() {
  local credential_dir="${AGENT_CREDENTIAL_FILE%/*}"
  local config_dir="${ALLOY_CONFIG_FILE%/*}"

  create_temp_root
  TASK4_TXN_ACTIVE=0
  TASK4_TXN_COMMITTED=0
  TASK4_ROLLBACK_DONE=0
  TASK4_SNAPSHOT_READY=0
  TASK4_CREDENTIAL_CHANGED=0
  TASK4_CONFIG_CHANGED=0
  TASK4_SERVICE_MUTATED=0
  TASK4_CREDENTIAL_DIR_CHANGED=0
  TASK4_CONFIG_DIR_CHANGED=0
  TASK4_CREDENTIAL_DIR_CREATED=0
  TASK4_CONFIG_DIR_CREATED=0
  TASK4_TEMP_FILES=()
  TASK4_SNAPSHOT_CREDENTIAL_EXISTS=0
  TASK4_SNAPSHOT_CONFIG_EXISTS=0
  TASK4_SNAPSHOT_CREDENTIAL_CONTENT=''
  TASK4_SNAPSHOT_CONFIG_CONTENT=''

  if ! TASK4_SNAPSHOT_ROOT="$(mktemp -d -- "$TEMP_ROOT/task4-state.XXXXXX" 2>/dev/null)"; then
    return 1
  fi
  if ! chmod 700 -- "$TASK4_SNAPSHOT_ROOT" >/dev/null 2>&1; then
    return 1
  fi
  if [[ -L "$TASK4_SNAPSHOT_ROOT" ]] || ! realpath -e -- "$TASK4_SNAPSHOT_ROOT" >/dev/null 2>&1; then
    return 1
  fi
  if ! task4_capture_directory_metadata "$credential_dir" credential; then
    return 1
  fi
  if ! task4_capture_directory_metadata "$config_dir" config; then
    return 1
  fi
  if ! task4_snapshot_file "$AGENT_CREDENTIAL_FILE" credential; then
    return 1
  fi
  if ! task4_snapshot_file "$ALLOY_CONFIG_FILE" config; then
    return 1
  fi
  if (( ALLOY_PRE_RUN_CAPTURED )); then
    if (( ! ALLOY_PRE_RUN_CREDENTIAL_EXISTS )); then
      TASK4_SNAPSHOT_CREDENTIAL_EXISTS=0
      TASK4_SNAPSHOT_CREDENTIAL_CONTENT=''
      TASK4_SNAPSHOT_CREDENTIAL_UID=''
      TASK4_SNAPSHOT_CREDENTIAL_GID=''
      TASK4_SNAPSHOT_CREDENTIAL_MODE=''
    fi
    if (( ! ALLOY_PRE_RUN_CONFIG_EXISTS )); then
      TASK4_SNAPSHOT_CONFIG_EXISTS=0
      TASK4_SNAPSHOT_CONFIG_CONTENT=''
      TASK4_SNAPSHOT_CONFIG_UID=''
      TASK4_SNAPSHOT_CONFIG_GID=''
      TASK4_SNAPSHOT_CONFIG_MODE=''
    fi
    TASK4_CREDENTIAL_DIR_PRE_EXISTS="$ALLOY_PRE_RUN_CREDENTIAL_DIR_EXISTS"
    TASK4_CREDENTIAL_DIR_PRE_UID="$ALLOY_PRE_RUN_CREDENTIAL_DIR_UID"
    TASK4_CREDENTIAL_DIR_PRE_GID="$ALLOY_PRE_RUN_CREDENTIAL_DIR_GID"
    TASK4_CREDENTIAL_DIR_PRE_MODE="$ALLOY_PRE_RUN_CREDENTIAL_DIR_MODE"
    TASK4_CONFIG_DIR_PRE_EXISTS="$ALLOY_PRE_RUN_CONFIG_DIR_EXISTS"
    TASK4_CONFIG_DIR_PRE_UID="$ALLOY_PRE_RUN_CONFIG_DIR_UID"
    TASK4_CONFIG_DIR_PRE_GID="$ALLOY_PRE_RUN_CONFIG_DIR_GID"
    TASK4_CONFIG_DIR_PRE_MODE="$ALLOY_PRE_RUN_CONFIG_DIR_MODE"
  fi
  if ! task4_capture_service_state || ! task4_write_recovery_metadata; then
    return 1
  fi
  TASK4_SNAPSHOT_READY=1
  TASK4_TXN_ACTIVE=1
}

task4_restore_file() {
  local target="$1"
  local snapshot_content="$2"
  local exists="$3"
  local uid="$4"
  local gid="$5"
  local mode="$6"
  local directory="${target%/*}"
  local temporary=''

  if (( exists )); then
    # Snapshot paths are private implementation state. Reject an empty or
    # escaped path rather than restoring from an arbitrary caller-controlled
    # file if state becomes corrupted.
    if [[ -z "$TASK4_SNAPSHOT_ROOT" || "$snapshot_content" != "$TASK4_SNAPSHOT_ROOT/"* || ! -f "$snapshot_content" ]]; then
      return 1
    fi
    if [[ -L "$target" || ( -e "$target" && ! -f "$target" ) ]]; then
      return 1
    fi
    if [[ ! -d "$directory" || -L "$directory" ]]; then
      return 1
    fi
    if ! temporary="$(mktemp -- "$directory/.opsgrid-agent-restore.XXXXXX" 2>/dev/null)"; then
      return 1
    fi
    if ! task4_track_temp "$temporary" || ! cp -- "$snapshot_content" "$temporary" >/dev/null 2>&1; then
      rm -f -- "$temporary" >/dev/null 2>&1 || true
      return 1
    fi
    if ! chmod "$mode" -- "$temporary" >/dev/null 2>&1 || ! chown "$uid:$gid" -- "$temporary" >/dev/null 2>&1; then
      rm -f -- "$temporary" >/dev/null 2>&1 || true
      return 1
    fi
    if ! mv -f -- "$temporary" "$target" >/dev/null 2>&1; then
      return 1
    fi
  else
    if [[ -L "$target" ]]; then
      return 1
    fi
    if [[ -f "$target" ]]; then
      rm -f -- "$target" >/dev/null 2>&1 || return 1
    elif [[ -e "$target" ]]; then
      return 1
    fi
  fi
}

task4_verify_file_state() {
  local target="$1"
  local snapshot_content="$2"
  local exists="$3"
  local uid="$4"
  local gid="$5"
  local mode="$6"
  local metadata=''

  if (( ! exists )); then
    [[ ! -e "$target" && ! -L "$target" ]]
    return $?
  fi
  if [[ -z "$TASK4_SNAPSHOT_ROOT" || "$snapshot_content" != "$TASK4_SNAPSHOT_ROOT/"* || ! -f "$snapshot_content" ]]; then
    return 1
  fi
  if [[ -L "$target" || ! -f "$target" ]]; then
    return 1
  fi
  if ! cmp -s -- "$snapshot_content" "$target"; then
    return 1
  fi
  if ! metadata="$(stat -c '%u:%g:%a' -- "$target" 2>/dev/null)"; then
    return 1
  fi
  [[ "$metadata" == "$uid:$gid:$mode" ]]
}

task4_restore_directories() {
  local result=0
  local directory="${AGENT_CREDENTIAL_FILE%/*}"

  if (( TASK4_CREDENTIAL_DIR_PRE_EXISTS )); then
    if [[ -L "$directory" || ! -d "$directory" ]] || ! chmod "$TASK4_CREDENTIAL_DIR_PRE_MODE" -- "$directory" >/dev/null 2>&1 || ! chown "$TASK4_CREDENTIAL_DIR_PRE_UID:$TASK4_CREDENTIAL_DIR_PRE_GID" -- "$directory" >/dev/null 2>&1; then
      result=1
    fi
  elif [[ -d "$directory" && ! -L "$directory" ]]; then
    rmdir -- "$directory" >/dev/null 2>&1 || result=1
  elif [[ -L "$directory" ]]; then
    result=1
  fi

  directory="${ALLOY_CONFIG_FILE%/*}"
  if (( TASK4_CONFIG_DIR_PRE_EXISTS )); then
    if [[ -L "$directory" || ! -d "$directory" ]] || ! chmod "$TASK4_CONFIG_DIR_PRE_MODE" -- "$directory" >/dev/null 2>&1 || ! chown "$TASK4_CONFIG_DIR_PRE_UID:$TASK4_CONFIG_DIR_PRE_GID" -- "$directory" >/dev/null 2>&1; then
      result=1
    fi
  elif [[ -d "$directory" && ! -L "$directory" ]]; then
    rmdir -- "$directory" >/dev/null 2>&1 || result=1
  elif [[ -L "$directory" ]]; then
    result=1
  fi
  return "$result"
}

task4_verify_directory_state() {
  local directory="$1"
  local exists="$2"
  local uid="$3"
  local gid="$4"
  local mode="$5"
  local metadata=''

  if (( ! exists )); then
    [[ ! -e "$directory" && ! -L "$directory" ]]
    return $?
  fi
  if [[ -L "$directory" || ! -d "$directory" ]]; then
    return 1
  fi
  if ! metadata="$(stat -c '%u:%g:%a' -- "$directory" 2>/dev/null)"; then
    return 1
  fi
  [[ "$metadata" == "$uid:$gid:$mode" ]]
}

task4_verify_service_state() {
  if ! task4_read_service_flags; then
    return 1
  fi
  # A fresh official package may retain its unit because package rollback does
  # not uninstall the package, but its state must be provably stopped/disabled.
  if (( TASK4_ORIGINAL_SERVICE_PRESENT )); then
    (( TASK4_CURRENT_SERVICE_PRESENT == 1 )) || return 1
  else
    if (( TASK4_CURRENT_SERVICE_ACTIVE != 0 || TASK4_CURRENT_SERVICE_ENABLED != 0 )); then
      return 1
    fi
  fi
  if (( TASK4_CURRENT_SERVICE_ACTIVE != TASK4_ORIGINAL_SERVICE_ACTIVE || TASK4_CURRENT_SERVICE_ENABLED != TASK4_ORIGINAL_SERVICE_ENABLED )); then
    return 1
  fi
  return 0
}

task4_quiesce_service_for_restore() {
  if ! task4_service_present_now; then
    return 0
  fi
  if ! systemctl stop alloy.service >/dev/null 2>&1; then
    return 1
  fi
  if systemctl is-active --quiet alloy.service >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

task4_restore_service_state() {
  local result=0

  if (( TASK4_ORIGINAL_SERVICE_PRESENT )); then
    if ! task4_service_present_now; then
      return 1
    fi
    if (( TASK4_ORIGINAL_SERVICE_ENABLED )); then
      systemctl enable alloy.service >/dev/null 2>&1 || result=1
    else
      systemctl disable alloy.service >/dev/null 2>&1 || result=1
    fi
    if (( TASK4_ORIGINAL_SERVICE_ACTIVE )); then
      if ! task4_read_service_flags; then
        result=1
      elif (( TASK4_CURRENT_SERVICE_ACTIVE )); then
        systemctl restart alloy.service >/dev/null 2>&1 || result=1
      else
        systemctl start alloy.service >/dev/null 2>&1 || result=1
      fi
    else
      systemctl stop alloy.service >/dev/null 2>&1 || result=1
    fi
  else
    if task4_service_present_now; then
      systemctl stop alloy.service >/dev/null 2>&1 || result=1
      systemctl disable alloy.service >/dev/null 2>&1 || result=1
    fi
  fi
  return "$result"
}

restore_state() {
  local result=0
  local service_quiesced=1

  if (( ! TASK4_SNAPSHOT_READY )); then
    return 0
  fi
  if (( TASK4_ROLLBACK_DONE )); then
    if (( TASK4_TXN_ACTIVE )); then
      return 1
    fi
    return 0
  fi
  TASK4_ROLLBACK_DONE=1
  # Staging/validation can fail before any Task 4 mutation. A package install
  # before the snapshot can still create files or start/enable a new service.
  # Skip restoration only when the complete pre-run baseline is unchanged; this
  # keeps healthy existing reruns from restarting solely to discard a stage.
  if (( ! TASK4_SERVICE_MUTATED && ! TASK4_CREDENTIAL_CHANGED && ! TASK4_CONFIG_CHANGED && ! TASK4_CREDENTIAL_DIR_CHANGED && ! TASK4_CONFIG_DIR_CHANGED )) &&
    task4_verify_file_state "$AGENT_CREDENTIAL_FILE" "$TASK4_SNAPSHOT_CREDENTIAL_CONTENT" "$TASK4_SNAPSHOT_CREDENTIAL_EXISTS" "$TASK4_SNAPSHOT_CREDENTIAL_UID" "$TASK4_SNAPSHOT_CREDENTIAL_GID" "$TASK4_SNAPSHOT_CREDENTIAL_MODE" &&
    task4_verify_file_state "$ALLOY_CONFIG_FILE" "$TASK4_SNAPSHOT_CONFIG_CONTENT" "$TASK4_SNAPSHOT_CONFIG_EXISTS" "$TASK4_SNAPSHOT_CONFIG_UID" "$TASK4_SNAPSHOT_CONFIG_GID" "$TASK4_SNAPSHOT_CONFIG_MODE" &&
    task4_verify_directory_state "${AGENT_CREDENTIAL_FILE%/*}" "$TASK4_CREDENTIAL_DIR_PRE_EXISTS" "$TASK4_CREDENTIAL_DIR_PRE_UID" "$TASK4_CREDENTIAL_DIR_PRE_GID" "$TASK4_CREDENTIAL_DIR_PRE_MODE" &&
    task4_verify_directory_state "${ALLOY_CONFIG_FILE%/*}" "$TASK4_CONFIG_DIR_PRE_EXISTS" "$TASK4_CONFIG_DIR_PRE_UID" "$TASK4_CONFIG_DIR_PRE_GID" "$TASK4_CONFIG_DIR_PRE_MODE" &&
    task4_verify_service_state; then
    if ! task4_cleanup_temps; then
      return 1
    fi
    TASK4_TXN_ACTIVE=0
    return 0
  fi
  # Never replace a credential/config file while Alloy may still be consuming it.
  # If quiescing fails, fail closed: keep persistent files/directories untouched.
  if ! task4_quiesce_service_for_restore; then
    service_quiesced=0
    result=1
  fi
  if (( service_quiesced )); then
    if ! task4_restore_file "$AGENT_CREDENTIAL_FILE" "$TASK4_SNAPSHOT_CREDENTIAL_CONTENT" "$TASK4_SNAPSHOT_CREDENTIAL_EXISTS" "$TASK4_SNAPSHOT_CREDENTIAL_UID" "$TASK4_SNAPSHOT_CREDENTIAL_GID" "$TASK4_SNAPSHOT_CREDENTIAL_MODE"; then
      result=1
    fi
    if ! task4_restore_file "$ALLOY_CONFIG_FILE" "$TASK4_SNAPSHOT_CONFIG_CONTENT" "$TASK4_SNAPSHOT_CONFIG_EXISTS" "$TASK4_SNAPSHOT_CONFIG_UID" "$TASK4_SNAPSHOT_CONFIG_GID" "$TASK4_SNAPSHOT_CONFIG_MODE"; then
      result=1
    fi
    if ! task4_restore_service_state; then
      result=1
    fi
  fi
  # Remove staged artifacts before removing directories created by this transaction.
  if ! task4_cleanup_temps; then
    result=1
  fi
  if (( service_quiesced )); then
    if ! task4_restore_directories; then
      result=1
    fi
    if ! task4_verify_file_state "$AGENT_CREDENTIAL_FILE" "$TASK4_SNAPSHOT_CREDENTIAL_CONTENT" "$TASK4_SNAPSHOT_CREDENTIAL_EXISTS" "$TASK4_SNAPSHOT_CREDENTIAL_UID" "$TASK4_SNAPSHOT_CREDENTIAL_GID" "$TASK4_SNAPSHOT_CREDENTIAL_MODE"; then
      result=1
    fi
    if ! task4_verify_file_state "$ALLOY_CONFIG_FILE" "$TASK4_SNAPSHOT_CONFIG_CONTENT" "$TASK4_SNAPSHOT_CONFIG_EXISTS" "$TASK4_SNAPSHOT_CONFIG_UID" "$TASK4_SNAPSHOT_CONFIG_GID" "$TASK4_SNAPSHOT_CONFIG_MODE"; then
      result=1
    fi
    if ! task4_verify_directory_state "${AGENT_CREDENTIAL_FILE%/*}" "$TASK4_CREDENTIAL_DIR_PRE_EXISTS" "$TASK4_CREDENTIAL_DIR_PRE_UID" "$TASK4_CREDENTIAL_DIR_PRE_GID" "$TASK4_CREDENTIAL_DIR_PRE_MODE"; then
      result=1
    fi
    if ! task4_verify_directory_state "${ALLOY_CONFIG_FILE%/*}" "$TASK4_CONFIG_DIR_PRE_EXISTS" "$TASK4_CONFIG_DIR_PRE_UID" "$TASK4_CONFIG_DIR_PRE_GID" "$TASK4_CONFIG_DIR_PRE_MODE"; then
      result=1
    fi
    if ! task4_verify_service_state; then
      result=1
    fi
  fi
  if (( result == 0 )); then
    TASK4_TXN_ACTIVE=0
  fi
  return "$result"
}

apply_and_restart() {
  local metadata=''
  local config_mode="${1:-644}"
  case "$config_mode" in
    600|640|644) ;;
    *) return 1 ;;
  esac

  if [[ -z "$TASK4_CONFIG_STAGE" || ! -f "$TASK4_CONFIG_STAGE" || -L "$TASK4_CONFIG_STAGE" ]]; then
    return 1
  fi
  if [[ -L "$ALLOY_CONFIG_FILE" || ( -e "$ALLOY_CONFIG_FILE" && ! -f "$ALLOY_CONFIG_FILE" ) ]]; then
    return 1
  fi
  if ! mv -f -- "$TASK4_CONFIG_STAGE" "$ALLOY_CONFIG_FILE" >/dev/null 2>&1; then
    return 1
  fi
  TASK4_CONFIG_CHANGED=1
  TASK4_CONFIG_STAGE=''
  if [[ -L "$ALLOY_CONFIG_FILE" || ! -f "$ALLOY_CONFIG_FILE" ]]; then
    return 1
  fi
  if ! chown root:root -- "$ALLOY_CONFIG_FILE" >/dev/null 2>&1 || ! chmod "$config_mode" -- "$ALLOY_CONFIG_FILE" >/dev/null 2>&1; then
    return 1
  fi
  if ! metadata="$(stat -c '%u:%g:%a' -- "$ALLOY_CONFIG_FILE" 2>/dev/null)" || [[ "$metadata" != "0:0:$config_mode" ]]; then
    return 1
  fi

  TASK4_SERVICE_MUTATED=1
  if (( TASK4_ORIGINAL_SERVICE_ACTIVE )); then
    systemctl restart alloy.service >/dev/null 2>&1
  else
    systemctl enable --now alloy.service >/dev/null 2>&1
  fi
}

task4_commit() {
  # Task 4 staged files are cleaned while its transaction is still active,
  # before repository durability is committed. This finalization only flips
  # in-memory state and therefore cannot fail after repo_transaction_commit.
  if (( ! TASK4_TXN_ACTIVE )); then
    return 0
  fi
  TASK4_TXN_COMMITTED=1
  TASK4_TXN_ACTIVE=0
  TASK4_SNAPSHOT_READY=0
  return 0
}

rollback_pre_task4_state() {
  local result=0
  local unit_exists=0
  local path=''

  if (( PRE_TASK4_ROLLBACK_DONE )); then
    return 0
  fi
  if (( ! ALLOY_PRE_RUN_CAPTURED )); then
    return 0
  fi
  PRE_TASK4_ROLLBACK_DONE=1

  # A failed package install/enrollment can leave a newly-created unit active
  # before Task 4 takes its snapshot. Restore the pre-run service baseline.
  if (( ALLOY_PRE_RUN_SERVICE_PRESENT == 0 )); then
    if systemctl cat alloy.service >/dev/null 2>&1 || [[ "$(systemctl show alloy.service --property=LoadState --value 2>/dev/null)" == 'loaded' ]]; then
      unit_exists=1
      if systemctl stop alloy.service >/dev/null 2>&1; then :; else result=1; fi
      if systemctl disable alloy.service >/dev/null 2>&1; then :; else result=1; fi
      systemctl reset-failed alloy.service >/dev/null 2>&1 || true
      systemctl daemon-reload >/dev/null 2>&1 || result=1
    fi
    if (( unit_exists )) && systemctl is-active --quiet alloy.service >/dev/null 2>&1; then
      result=1
    fi
    if (( unit_exists )) && systemctl is-enabled --quiet alloy.service >/dev/null 2>&1; then
      result=1
    fi
  fi

  if (( ALLOY_PRE_RUN_CONFIG_EXISTS == 0 )) && [[ -e "$ALLOY_CONFIG_FILE" || -L "$ALLOY_CONFIG_FILE" ]]; then
    if [[ -L "$ALLOY_CONFIG_FILE" || ! -f "$ALLOY_CONFIG_FILE" ]] || ! rm -f -- "$ALLOY_CONFIG_FILE" >/dev/null 2>&1 || [[ -e "$ALLOY_CONFIG_FILE" || -L "$ALLOY_CONFIG_FILE" ]]; then
      result=1
    fi
  fi
  if (( ALLOY_PRE_RUN_CREDENTIAL_EXISTS == 0 )) && [[ -e "$AGENT_CREDENTIAL_FILE" || -L "$AGENT_CREDENTIAL_FILE" ]]; then
    if [[ -L "$AGENT_CREDENTIAL_FILE" || ! -f "$AGENT_CREDENTIAL_FILE" ]] || ! rm -f -- "$AGENT_CREDENTIAL_FILE" >/dev/null 2>&1 || [[ -e "$AGENT_CREDENTIAL_FILE" || -L "$AGENT_CREDENTIAL_FILE" ]]; then
      result=1
    fi
  fi
  for path in "$ALLOY_CONFIG_FILE" "$AGENT_CREDENTIAL_FILE"; do
    if [[ -e "$path" && ! -f "$path" ]]; then
      result=1
    fi
  done
  return "$result"
}

cleanup() {
  local exit_code=$?
  local created_file=''
  local rollback_failed=0
  local cleanup_failed=0
  local preserve_snapshot=0

  trap - EXIT

  # Task 4 owns the persistent credential/config/service state. It must be
  # restored before repository artifacts, so a failed install never leaves a
  # running service pointed at a partially rolled-back package configuration.
  if (( exit_code != 0 )); then
    if (( TASK4_TXN_ACTIVE )); then
      if ! restore_state; then
        rollback_failed=1
      fi
    elif ! rollback_pre_task4_state; then
      rollback_failed=1
      log 'Error: pre-Task4 rollback failed' >&2
    fi
    if ! repo_transaction_rollback; then
      rollback_failed=1
    fi
  elif (( TASK4_TXN_ACTIVE )); then
    # A successful exit with an open Task 4 transaction is an internal failure:
    # fail closed instead of silently committing an incomplete transaction.
    if ! restore_state; then
      rollback_failed=1
    fi
    if ! repo_transaction_rollback; then
      rollback_failed=1
    fi
    exit_code=50
  else
    if ! repo_transaction_commit; then
      rollback_failed=1
      exit_code=50
    fi
  fi

  if (( rollback_failed )); then
    log 'Error: rollback failed; local state could not be proven restored' >&2
    # Preserve a primary stable failure code when one already exists. A
    # rollback failure on an otherwise-successful path becomes service failure.
    if (( exit_code == 0 )); then
      exit_code=50
    fi
  fi

  # A commit cannot roll back package artifacts, but its backup/temp cleanup is
  # retryable after the transaction is closed; never silently discard the list.
  if (( REPO_TXN_COMMITTED )) && (( ${#REPO_TXN_TEMP_FILES[@]} > 0 )); then
    if ! remove_repo_transaction_temps; then
      cleanup_failed=1
    fi
  fi

  # A failed Task 4 restore must retain its previous-state snapshot for manual
  # recovery. Keep only this canonical root-only subtree, never the entire temp
  # root (which can contain a raw token, enrollment response or fresh credential).
  if (( rollback_failed && TASK4_SNAPSHOT_READY && TASK4_TXN_ACTIVE )) &&
    [[ "$TASK4_SNAPSHOT_ROOT" == "$TEMP_ROOT"/task4-state.* && ! -L "$TEMP_ROOT" && ! -L "$TASK4_SNAPSHOT_ROOT" ]] &&
    [[ "$(realpath -e -- "$TEMP_ROOT" 2>/dev/null)" == "$TEMP_ROOT" && "$(realpath -e -- "$TASK4_SNAPSHOT_ROOT" 2>/dev/null)" == "$TASK4_SNAPSHOT_ROOT" ]] &&
    [[ "$(stat -c '%u:%g:%a' -- "$TEMP_ROOT" 2>/dev/null)" == 0:0:700 && "$(stat -c '%u:%g:%a' -- "$TASK4_SNAPSHOT_ROOT" 2>/dev/null)" == 0:0:700 ]]; then
    preserve_snapshot=1
    log "Recovery snapshot retained at: $TASK4_SNAPSHOT_ROOT" >&2
  fi

  # Only temporary files under this invocation's root may be removed. Persistent
  # credential/config paths are never registered here, so rollback cannot delete
  # the previous state.
  if (( TEMP_ROOT_CREATED )) && [[ "$TEMP_ROOT" == /tmp/opsgrid-agent.* ]]; then
    for created_file in "${TEMP_FILES[@]}"; do
      if [[ "$created_file" == "$TEMP_ROOT/"* && -e "$created_file" ]]; then
        if ! rm -f -- "$created_file" >/dev/null 2>&1 || [[ -e "$created_file" || -L "$created_file" ]]; then
          cleanup_failed=1
        fi
      fi
    done
    if (( preserve_snapshot )); then
      for created_file in "$TEMP_ROOT"/* "$TEMP_ROOT"/.[!.]* "$TEMP_ROOT"/..?*; do
        [[ "$created_file" == "$TASK4_SNAPSHOT_ROOT" ]] && continue
        [[ -e "$created_file" || -L "$created_file" ]] || continue
        if ! rm -rf -- "$created_file" >/dev/null 2>&1 || [[ -e "$created_file" || -L "$created_file" ]]; then
          cleanup_failed=1
        fi
      done
    elif [[ -e "$TEMP_ROOT" || -L "$TEMP_ROOT" ]]; then
      if ! rm -rf -- "$TEMP_ROOT" >/dev/null 2>&1 || [[ -e "$TEMP_ROOT" || -L "$TEMP_ROOT" ]]; then
        cleanup_failed=1
      fi
    fi
  fi
  if (( cleanup_failed )); then
    log 'Error: temporary secret cleanup failed' >&2
    if (( exit_code == 0 )); then
      exit_code=50
    fi
  fi

  if [[ -n "${LOCK_FD:-}" ]]; then
    flock -u "$LOCK_FD" >/dev/null 2>&1 || true
    eval "exec ${LOCK_FD}>&-" 2>/dev/null || true
    LOCK_FD=''
  fi
  if [[ -n "${PRIVATE_LOCK_FD:-}" ]]; then
    flock -u "$PRIVATE_LOCK_FD" >/dev/null 2>&1 || true
    eval "exec ${PRIVATE_LOCK_FD}>&-" 2>/dev/null || true
    PRIVATE_LOCK_FD=''
  fi

  unset ENROLLMENT_TOKEN ENROLLED_CREDENTIAL ENROLLMENT_REQUEST_FILE ENROLLMENT_RESPONSE_FILE ENROLLMENT_STATUS_FILE
  return "$exit_code"
}

# Existing credentials must be safe and usable by the vendor service. This is
# local validation only: Gateway authentication still requires a real enrollment.
