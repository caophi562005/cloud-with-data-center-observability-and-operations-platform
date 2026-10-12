# [opsgrid-agent] Linux filesystem definitions; loaded by install.sh.
# Loading this module does not install, enroll, or change service state.

INSTALL_LOCK_FILE='/run/lock/opsgrid-agent-install.lock'
PRIVATE_INSTALL_LOCK_FILE='/run/opsgrid-agent/opsgrid-agent-install.lock'
LOCK_FD=''
PRIVATE_LOCK_FD=''
TEMP_ROOT=''
TEMP_ROOT_CREATED=0
TEMP_FILES=()

acquire_lock() {
  local private_lock_dir=''
  local private_lock_file="$PRIVATE_INSTALL_LOCK_FILE"
  local lock_dir=''
  local lock_file="$INSTALL_LOCK_FILE"
  local lock_metadata=''
  local lock_uid=''
  local lock_gid=''
  local lock_mode=''

  # The private lock is authoritative and lives below /run, whose parent is
  # root-controlled. This avoids relying on permissions of shared /run/lock.
  private_lock_dir="${private_lock_file%/*}"
  if [[ -L "$private_lock_dir" ]]; then
    fail 'preflight failed: private lock directory is a symlink'
  fi
  if [[ ! -d "$private_lock_dir" ]]; then
    if ! mkdir -p -- "$private_lock_dir" 2>/dev/null; then
      fail 'preflight failed: private lock directory unavailable'
    fi
    if ! chmod 700 -- "$private_lock_dir" 2>/dev/null; then
      fail 'preflight failed: private lock directory permissions could not be set'
    fi
  else
    if ! lock_metadata="$(stat -c '%u:%g:%a' -- "$private_lock_dir" 2>/dev/null)"; then
      fail 'preflight failed: private lock directory metadata unavailable'
    fi
    IFS=: read -r lock_uid lock_gid lock_mode <<< "$lock_metadata"
    if [[ "$lock_uid" != '0' || "$lock_gid" != '0' || "$lock_mode" != '700' ]]; then
      fail 'preflight failed: private lock directory is not root-only'
    fi
  fi

  if [[ -L "$private_lock_file" ]]; then
    fail 'preflight failed: private lock file is a symlink'
  fi
  if [[ -e "$private_lock_file" && ! -O "$private_lock_file" ]]; then
    fail 'preflight failed: private lock file is not root-owned'
  fi
  if ! { exec {PRIVATE_LOCK_FD}>>"$private_lock_file"; } 2>/dev/null; then
    fail 'preflight failed: private lock file unavailable'
  fi
  if ! chmod 600 -- "$private_lock_file" 2>/dev/null; then
    fail 'preflight failed: private lock file permissions could not be set'
  fi
  if ! flock -n "$PRIVATE_LOCK_FD" >/dev/null 2>&1; then
    fail 'installation lock is already held'
  fi

  # Also acquire the documented compatibility lock path. The private lock
  # remains authoritative if shared /run/lock permits replacement by a group.
  lock_dir="${lock_file%/*}"
  if [[ "$lock_dir" == "$lock_file" || -z "$lock_dir" ]]; then
    lock_dir='.'
  fi
  if [[ -L "$lock_dir" ]]; then
    fail 'preflight failed: lock directory is a symlink'
  fi
  if [[ ! -d "$lock_dir" ]]; then
    if ! mkdir -p -- "$lock_dir" 2>/dev/null; then
      fail 'preflight failed: lock directory unavailable'
    fi
    if ! chmod 700 -- "$lock_dir" 2>/dev/null; then
      fail 'preflight failed: lock directory permissions could not be set'
    fi
  elif [[ ! -O "$lock_dir" ]]; then
    fail 'preflight failed: lock directory is not root-owned'
  else
    if ! lock_metadata="$(stat -c '%u:%g:%a' -- "$lock_dir" 2>/dev/null)"; then
      fail 'preflight failed: lock directory metadata unavailable'
    fi
    IFS=: read -r lock_uid lock_gid lock_mode <<< "$lock_metadata"
    if [[ "$lock_uid" != '0' || "$lock_gid" != '0' || -z "$lock_mode" ]]; then
      fail 'preflight failed: lock directory is not root-controlled'
    fi
    # A shared lock directory may retain group access only for root's group;
    # other-write is accepted only with sticky semantics. The private lock
    # above remains authoritative even if this compatibility path is replaced.
    if [[ "${lock_mode: -1}" =~ [2367] && "$lock_mode" != 1* ]]; then
      fail 'preflight failed: lock directory permits unsafe replacement'
    fi
  fi

  if [[ -L "$lock_file" ]]; then
    fail 'preflight failed: lock file is a symlink'
  fi
  if [[ -e "$lock_file" && ! -O "$lock_file" ]]; then
    fail 'preflight failed: lock file is not root-owned'
  fi
  if ! { exec {LOCK_FD}>>"$lock_file"; } 2>/dev/null; then
    fail 'preflight failed: lock file unavailable'
  fi
  if ! chmod 600 -- "$lock_file" 2>/dev/null; then
    fail 'preflight failed: lock file permissions could not be set'
  fi
  if ! flock -n "$LOCK_FD" >/dev/null 2>&1; then
    fail 'installation lock is already held'
  fi
}

create_temp_root() {
  local root=''

  if ((TEMP_ROOT_CREATED)); then
    return 0
  fi
  if ! root="$(mktemp -d -- '/tmp/opsgrid-agent.XXXXXX' 2>/dev/null)"; then
    fail 'temporary directory unavailable' 50
  fi
  if ! chmod 700 -- "$root" 2>/dev/null; then
    rm -rf -- "$root" 2>/dev/null || true
    fail 'temporary directory permissions could not be set' 50
  fi
  if ! root="$(realpath -e -- "$root" 2>/dev/null)" || [[ "$root" != /tmp/opsgrid-agent.* ]]; then
    rm -rf -- "$root" 2>/dev/null || true
    fail 'temporary directory path rejected' 50
  fi
  TEMP_ROOT="$root"
  TEMP_ROOT_CREATED=1
}

track_temp_file() {
  local path="$1"
  local canonical_path=''

  if (( ! TEMP_ROOT_CREATED )) || [[ -z "$TEMP_ROOT" ]]; then
    fail 'internal temporary-file root is not initialized' 50
  fi
  if ! canonical_path="$(realpath -e -- "$path" 2>/dev/null)"; then
    fail 'internal temporary-file path is unavailable' 50
  fi
  case "$canonical_path" in
    "$TEMP_ROOT"/*) TEMP_FILES+=("$canonical_path") ;;
    *) fail 'internal temporary-file path rejected' 50 ;;
  esac
}

secure_artifact_directory() {
  local directory="$1"
  local canonical=''
  local metadata=''
  local uid=''
  local gid=''
  local mode=''
  local group_digit=''
  local other_digit=''

  if [[ -L "$directory" || ! -d "$directory" ]]; then
    return 1
  fi
  if ! canonical="$(realpath -e -- "$directory" 2>/dev/null)" || [[ "$canonical" != "$directory" ]]; then
    return 1
  fi
  if ! metadata="$(stat -c '%u:%g:%a' -- "$directory" 2>/dev/null)"; then
    return 1
  fi
  IFS=: read -r uid gid mode <<< "$metadata"
  if [[ "$uid" != '0' || "$gid" != '0' || ${#mode} -lt 3 ]]; then
    return 1
  fi
  group_digit="${mode: -2:1}"
  other_digit="${mode: -1}"
  if [[ "$group_digit" == [2367] || "$other_digit" == [2367] ]]; then
    return 1
  fi
  return 0
}

# The official Grafana Debian/RPM package creates /etc/alloy as root:alloy
# with mode 0770 so the vendor service can traverse its config directory. Keep
# accepting only that exact directory, the observed Alloy service group, and
# no permissions for other users; all other artifact directories retain the
# stricter root:root validation above.

secure_alloy_config_directory() {
  local directory="$1"
  local expected_group='root'
  local expected_gid='0'
  local canonical=''
  local metadata=''
  local uid=''
  local gid=''
  local mode=''
  local group_digit=''
  local other_digit=''

  if [[ "$directory" != "${ALLOY_CONFIG_FILE%/*}" || -L "$directory" || ! -d "$directory" ]]; then
    return 1
  fi
  if ! canonical="$(realpath -e -- "$directory" 2>/dev/null)" || [[ "$canonical" != "$directory" ]]; then
    return 1
  fi
  if (( ALLOY_RUNTIME_ROOT )); then
    secure_artifact_directory "$directory"
    return $?
  fi
  expected_group="$ALLOY_RUNTIME_GROUP"
  if [[ -z "$expected_group" || ! "$expected_group" =~ ^[A-Za-z0-9._-]+$ ]]; then
    return 1
  fi
  if ! expected_gid="$(getent group "$expected_group" | cut -d: -f3)" || [[ -z "$expected_gid" ]]; then
    return 1
  fi
  if ! metadata="$(stat -c '%u:%g:%a' -- "$directory" 2>/dev/null)"; then
    return 1
  fi
  IFS=: read -r uid gid mode <<< "$metadata"
  if [[ "$uid" != '0' || "$gid" != "$expected_gid" || ${#mode} -lt 3 ]]; then
    return 1
  fi
  group_digit="${mode: -2:1}"
  other_digit="${mode: -1}"
  if [[ "$group_digit" != [57] || "$other_digit" != '0' ]]; then
    return 1
  fi
  return 0
}

task4_validate_directory_parent() {
  local directory="$1"
  local parent=''

  if [[ -L "$directory" ]]; then
    return 1
  fi
  if [[ -d "$directory" ]]; then
    secure_artifact_directory "$directory"
    return $?
  fi
  if [[ -e "$directory" ]]; then
    return 1
  fi
  parent="${directory%/*}"
  if [[ "$parent" == "$directory" || -z "$parent" ]]; then
    parent='.'
  fi
  secure_artifact_directory "$parent"
}

task4_track_temp() {
  local temporary="$1"

  case "$temporary" in
    /etc/opsgrid-agent/*|/etc/alloy/*)
      TASK4_TEMP_FILES+=("$temporary")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

task4_cleanup_temps() {
  local temporary=''
  local result=0

  for temporary in "${TASK4_TEMP_FILES[@]}"; do
    if [[ -z "$temporary" ]]; then
      continue
    fi
    if [[ -L "$temporary" || ( -e "$temporary" && ! -f "$temporary" ) ]]; then
      result=1
      continue
    fi
    if [[ -e "$temporary" ]]; then
      if ! rm -f -- "$temporary" >/dev/null 2>&1 || [[ -e "$temporary" || -L "$temporary" ]]; then
        result=1
      fi
    fi
  done
  if (( result == 0 )); then
    TASK4_TEMP_FILES=()
    TASK4_CREDENTIAL_STAGE=''
    TASK4_CONFIG_STAGE=''
  fi
  return "$result"
}

task4_ensure_credential_directory() {
  local directory="${AGENT_CREDENTIAL_FILE%/*}"
  local metadata=''
  local uid=''
  local gid=''
  local mode=''
  local directory_group='root'
  local directory_mode='700'

  if [[ -L "$directory" || ( -e "$directory" && ! -d "$directory" ) ]]; then
    return 1
  fi
  if (( ! ALLOY_RUNTIME_ROOT )); then
    # A non-root Alloy process needs directory traversal in addition to the
    # credential file's group-read bit. Keep all other access disabled.
    directory_group="$ALLOY_RUNTIME_GROUP"
    directory_mode='750'
  fi
  if [[ -z "$directory_group" || ! "$directory_group" =~ ^[A-Za-z0-9._-]+$ ]]; then
    return 1
  fi
  if [[ ! -d "$directory" ]]; then
    if ! task4_validate_directory_parent "$directory"; then
      return 1
    fi
    if ! install -d -m "$directory_mode" -- "$directory" >/dev/null 2>&1 || ! chown "root:$directory_group" -- "$directory" >/dev/null 2>&1; then
      return 1
    fi
    TASK4_CREDENTIAL_DIR_CREATED=1
    TASK4_CREDENTIAL_DIR_CHANGED=1
  fi
  if [[ -L "$directory" || ! -d "$directory" ]]; then
    return 1
  fi
  if ! metadata="$(stat -c '%u:%g:%a' -- "$directory" 2>/dev/null)"; then
    return 1
  fi
  IFS=: read -r uid gid mode <<< "$metadata"
  if [[ "$uid" != '0' || "$gid" != "$(getent group "$directory_group" | cut -d: -f3)" ]]; then
    if ! chown "root:$directory_group" -- "$directory" >/dev/null 2>&1; then
      return 1
    fi
    TASK4_CREDENTIAL_DIR_CHANGED=1
  fi
  if [[ "$mode" != "$directory_mode" ]]; then
    if ! chmod "$directory_mode" -- "$directory" >/dev/null 2>&1; then
      return 1
    fi
    TASK4_CREDENTIAL_DIR_CHANGED=1
  fi
  if ! metadata="$(stat -c '%u:%g:%a' -- "$directory" 2>/dev/null)"; then
    return 1
  fi
  IFS=: read -r uid gid mode <<< "$metadata"
  [[ "$uid" == '0' && "$gid" == "$(getent group "$directory_group" | cut -d: -f3)" && "$mode" == "$directory_mode" ]]
}

task4_ensure_config_directory() {
  local directory="${ALLOY_CONFIG_FILE%/*}"
  local directory_group='root'
  local directory_mode='0755'

  if [[ -L "$directory" || ( -e "$directory" && ! -d "$directory" ) ]]; then
    return 1
  fi
  if [[ ! -d "$directory" ]]; then
    if ! task4_validate_directory_parent "$directory"; then
      return 1
    fi
    if (( ! ALLOY_RUNTIME_ROOT )); then
      directory_group="$ALLOY_RUNTIME_GROUP"
      directory_mode='0750'
    fi
    if ! install -d -m "$directory_mode" -- "$directory" >/dev/null 2>&1 || ! chown "root:$directory_group" -- "$directory" >/dev/null 2>&1; then
      return 1
    fi
    TASK4_CONFIG_DIR_CREATED=1
    TASK4_CONFIG_DIR_CHANGED=1
  fi
  secure_alloy_config_directory "$directory"
}
