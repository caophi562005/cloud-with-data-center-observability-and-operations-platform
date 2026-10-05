# [opsgrid-agent] Linux repositories definitions; loaded by install.sh.
# Loading this module does not install, enroll, or change service state.

REPO_TXN_ACTIVE=0
REPO_TXN_COMMITTED=0
REPO_TXN_ROLLED_BACK=0
REPO_ARTIFACT_PATHS=()
REPO_ARTIFACT_BACKUPS=()
REPO_ARTIFACT_EXISTS=()
REPO_ARTIFACT_CHANGED=()
REPO_ARTIFACT_MODES=()
REPO_ARTIFACT_UIDS=()
REPO_ARTIFACT_GIDS=()
REPO_TXN_TEMP_FILES=()
REPO_RECOVERY_FILES=()
REPO_CREATED_DIRS=()
RPM_PRE_RUN_KEYS=''
RPM_IMPORTED_KEYS=()

ensure_artifact_directory() {
  local directory="$1"
  local parent=''

  if [[ -L "$directory" ]]; then
    return 1
  fi
  if [[ ! -e "$directory" ]]; then
    parent="${directory%/*}"
    if [[ "$parent" == "$directory" || -z "$parent" ]] || ! secure_artifact_directory "$parent"; then
      return 1
    fi
    if ! install -d -m 0755 -- "$directory" >/dev/null 2>&1; then
      return 1
    fi
    REPO_CREATED_DIRS+=("$directory")
  fi
  secure_artifact_directory "$directory"
}

make_artifact_temp() {
  local target_path="$1"
  local output_name="$2"
  local directory="${target_path%/*}"
  local artifact_temporary=''
  local canonical=''

  # Run in the parent shell: command substitution loses both registrations and
  # any directory created by ensure_artifact_directory.
  case "$output_name" in backup|temporary|keyring_temp) ;; *) return 1 ;; esac
  if ! ensure_artifact_directory "$directory"; then
    return 1
  fi
  if ! artifact_temporary="$(mktemp -- "$directory/.opsgrid-agent-install.XXXXXX" 2>/dev/null)"; then
    return 1
  fi
  if ! chmod 600 -- "$artifact_temporary" >/dev/null 2>&1; then
    rm -f -- "$artifact_temporary" >/dev/null 2>&1 || true
    return 1
  fi
  if ! canonical="$(realpath -e -- "$artifact_temporary" 2>/dev/null)" || [[ "$canonical" != "$artifact_temporary" ]] || [[ -L "$artifact_temporary" ]]; then
    rm -f -- "$artifact_temporary" >/dev/null 2>&1 || true
    return 1
  fi
  REPO_TXN_TEMP_FILES+=("$artifact_temporary")
  printf -v "$output_name" '%s' "$artifact_temporary"
}

begin_repo_transaction() {
  if ((REPO_TXN_ACTIVE)); then
    return 0
  fi
  REPO_TXN_ACTIVE=1
  REPO_TXN_COMMITTED=0
  REPO_TXN_ROLLED_BACK=0
  REPO_ARTIFACT_PATHS=()
  REPO_ARTIFACT_BACKUPS=()
  REPO_ARTIFACT_EXISTS=()
  REPO_ARTIFACT_CHANGED=()
  REPO_ARTIFACT_MODES=()
  REPO_ARTIFACT_UIDS=()
  REPO_ARTIFACT_GIDS=()
  REPO_TXN_TEMP_FILES=()
  REPO_RECOVERY_FILES=()
  REPO_CREATED_DIRS=()
  RPM_IMPORTED_KEYS=()
}

prepare_repo_artifact() {
  local artifact_path="$1"
  local directory="${artifact_path%/*}"
  local backup=''
  local metadata=''
  local uid=''
  local gid=''
  local mode=''

  if ! ensure_artifact_directory "$directory"; then
    return 1
  fi
  if [[ -L "$artifact_path" || ( -e "$artifact_path" && ! -f "$artifact_path" ) ]]; then
    return 1
  fi
  if [[ -e "$artifact_path" ]]; then
    if ! metadata="$(stat -c '%u:%g:%a' -- "$artifact_path" 2>/dev/null)"; then
      return 1
    fi
    IFS=: read -r uid gid mode <<< "$metadata"
    if ! make_artifact_temp "$artifact_path" backup; then
      return 1
    fi
    if ! cp -- "$artifact_path" "$backup" >/dev/null 2>&1 || ! chmod 600 -- "$backup" >/dev/null 2>&1; then
      rm -f -- "$backup" >/dev/null 2>&1 || true
      return 1
    fi
    REPO_ARTIFACT_BACKUPS+=("$backup")
    REPO_ARTIFACT_EXISTS+=(1)
    REPO_ARTIFACT_MODES+=("$mode")
    REPO_ARTIFACT_UIDS+=("$uid")
    REPO_ARTIFACT_GIDS+=("$gid")
  else
    REPO_ARTIFACT_BACKUPS+=('')
    REPO_ARTIFACT_EXISTS+=(0)
    REPO_ARTIFACT_MODES+=('')
    REPO_ARTIFACT_UIDS+=('')
    REPO_ARTIFACT_GIDS+=('')
  fi
  REPO_ARTIFACT_PATHS+=("$artifact_path")
  REPO_ARTIFACT_CHANGED+=(0)
}

mark_repo_artifact_changed() {
  local artifact_path="$1"
  local index=0

  for ((index = 0; index < ${#REPO_ARTIFACT_PATHS[@]}; index++)); do
    if [[ "${REPO_ARTIFACT_PATHS[$index]}" == "$artifact_path" ]]; then
      REPO_ARTIFACT_CHANGED[$index]=1
      return 0
    fi
  done
  return 1
}

atomic_replace_artifact() {
  local artifact_path="$1"
  local temporary="$2"
  local mode="$3"
  local directory="${artifact_path%/*}"
  local canonical=''

  if [[ -L "$artifact_path" ]] || [[ -L "$temporary" ]] || [[ ! -f "$temporary" ]]; then
    return 1
  fi
  if ! ensure_artifact_directory "$directory"; then
    return 1
  fi
  if ! canonical="$(realpath -e -- "$temporary" 2>/dev/null)" || [[ "$canonical" != "$temporary" ]]; then
    return 1
  fi
  if ! chmod "$mode" -- "$temporary" >/dev/null 2>&1; then
    return 1
  fi
  if ! mv -f -- "$temporary" "$artifact_path" >/dev/null 2>&1; then
    return 1
  fi
  if ! mark_repo_artifact_changed "$artifact_path"; then
    return 1
  fi
  if [[ -L "$artifact_path" || ! -f "$artifact_path" ]]; then
    return 1
  fi
}

write_atomic_artifact() {
  local artifact_path="$1"
  local content="$2"
  local mode="$3"
  local temporary=''

  if ! make_artifact_temp "$artifact_path" temporary; then
    return 1
  fi
  if ! printf '%s\n' "$content" > "$temporary"; then
    return 1
  fi
  atomic_replace_artifact "$artifact_path" "$temporary" "$mode"
}

capture_rpm_keys() {
  RPM_PRE_RUN_KEYS=''
  if [[ "$PACKAGE_MANAGER" == 'dnf' || "$PACKAGE_MANAGER" == 'yum' ]]; then
    RPM_PRE_RUN_KEYS="$(rpm -qa 'gpg-pubkey*' 2>/dev/null || true)"
  fi
}

rpm_key_was_preexisting() {
  local candidate="$1"
  local existing=''

  while IFS= read -r existing; do
    if [[ "$existing" == "$candidate" ]]; then
      return 0
    fi
  done <<< "$RPM_PRE_RUN_KEYS"
  return 1
}

record_new_rpm_keys() {
  local key_package=''

  while IFS= read -r key_package; do
    [[ -z "$key_package" ]] && continue
    if [[ "$key_package" =~ ^gpg-pubkey-[[:xdigit:]]+-[[:xdigit:]]+$ ]] && ! rpm_key_was_preexisting "$key_package"; then
      RPM_IMPORTED_KEYS+=("$key_package")
    fi
  done < <(rpm -qa 'gpg-pubkey*' 2>/dev/null || true)
}

remove_new_rpm_keys() {
  local key_package=''
  local result=0

  for key_package in "${RPM_IMPORTED_KEYS[@]}"; do
    if [[ "$key_package" =~ ^gpg-pubkey-[[:xdigit:]]+-[[:xdigit:]]+$ ]]; then
      if ! rpm -e --nodeps "$key_package" >/dev/null 2>&1; then
        result=1
      fi
      if rpm -q "$key_package" >/dev/null 2>&1; then
        result=1
      fi
    else
      result=1
    fi
  done
  RPM_IMPORTED_KEYS=()
  return "$result"
}

remove_repo_transaction_temps() {
  local temporary=''
  local recovery_file=''
  local preserve=0
  local result=0

  for temporary in "${REPO_TXN_TEMP_FILES[@]}"; do
    [[ -z "$temporary" ]] && continue
    preserve=0
    for recovery_file in "${REPO_RECOVERY_FILES[@]}"; do
      if [[ "$temporary" == "$recovery_file" ]]; then preserve=1; break; fi
    done
    (( preserve )) && continue
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
    REPO_TXN_TEMP_FILES=()
  fi
  return "$result"
}

remove_repo_created_dirs() {
  local directory=''
  local result=0

  for directory in "${REPO_CREATED_DIRS[@]}"; do
    [[ -z "$directory" ]] && continue
    if [[ -L "$directory" || ( -e "$directory" && ! -d "$directory" ) ]]; then
      result=1
      continue
    fi
    if [[ -d "$directory" ]]; then
      if ! rmdir -- "$directory" >/dev/null 2>&1 || [[ -e "$directory" || -L "$directory" ]]; then
        result=1
      fi
    fi
  done
  if (( result == 0 )); then
    REPO_CREATED_DIRS=()
  fi
  return "$result"
}

restore_repo_artifact() {
  local index="$1"
  local artifact_path="${REPO_ARTIFACT_PATHS[$index]}"
  local backup="${REPO_ARTIFACT_BACKUPS[$index]}"
  local mode="${REPO_ARTIFACT_MODES[$index]}"
  local uid="${REPO_ARTIFACT_UIDS[$index]}"
  local gid="${REPO_ARTIFACT_GIDS[$index]}"
  local temporary=''

  if [[ -z "$backup" || ! -f "$backup" || -L "$backup" || -L "$artifact_path" || ( -e "$artifact_path" && ! -f "$artifact_path" ) ]]; then
    return 1
  fi
  # The protected original is never chmod/chown'ed or moved. A separate copy
  # carries the destination permissions, so any failed restore retains evidence.
  if ! make_artifact_temp "$artifact_path" temporary || ! cp -- "$backup" "$temporary" >/dev/null 2>&1; then
    return 1
  fi
  if ! chmod "$mode" -- "$temporary" >/dev/null 2>&1 || ! chown "$uid:$gid" -- "$temporary" >/dev/null 2>&1 || ! mv -f -- "$temporary" "$artifact_path" >/dev/null 2>&1; then
    return 1
  fi
  if [[ -L "$artifact_path" || ! -f "$artifact_path" ]] || ! cmp -s -- "$backup" "$artifact_path"; then
    return 1
  fi
  [[ "$(stat -c '%u:%g:%a' -- "$artifact_path" 2>/dev/null)" == "$uid:$gid:$mode" ]]
}

preserve_repo_recovery() {
  local index="$1"
  local artifact_path="${REPO_ARTIFACT_PATHS[$index]}"
  local backup="${REPO_ARTIFACT_BACKUPS[$index]}"
  local metadata="$backup.recovery.meta"
  local canonical=''

  # Register the sole original first, even if writing metadata subsequently
  # fails. Cleanup must never destroy that original on a failed restore.
  [[ -n "$backup" ]] || return 1
  REPO_RECOVERY_FILES+=("$backup")
  if [[ "$backup" != "${artifact_path%/*}/.opsgrid-agent-install."* || -L "$backup" || ! -f "$backup" ]] ||
    ! secure_artifact_directory "${backup%/*}" ||
    ! canonical="$(realpath -e -- "$backup" 2>/dev/null)" || [[ "$canonical" != "$backup" ]] ||
    [[ "$(stat -c '%u:%g:%a' -- "$backup" 2>/dev/null)" != 0:0:600 ]]; then
    log 'Error: repository recovery original could not be verified' >&2
    return 1
  fi
  log "Repository recovery backup retained at: $backup" >&2
  # Only safe paths and previous permission metadata; no request/token payloads.
  # noclobber prevents an unexpected existing file or symlink from being replaced.
  if ! (umask 077; set -o noclobber; printf 'artifact_path=%q\nbackup_path=%q\nuid=%q\ngid=%q\nmode=%q\n' \
    "$artifact_path" "$backup" "${REPO_ARTIFACT_UIDS[$index]}" "${REPO_ARTIFACT_GIDS[$index]}" "${REPO_ARTIFACT_MODES[$index]}" > "$metadata") 2>/dev/null; then
    log 'Error: repository recovery metadata could not be written; original retained' >&2
    return 1
  fi
  REPO_RECOVERY_FILES+=("$metadata")
  if [[ -L "$metadata" || ! -f "$metadata" || "$(stat -c '%u:%g:%a' -- "$metadata" 2>/dev/null)" != 0:0:600 ]]; then
    log 'Error: repository recovery metadata could not be verified; original retained' >&2
    return 1
  fi
  log "Repository recovery metadata retained at: $metadata" >&2
}

repo_transaction_rollback() {
  local index=0
  local artifact_path=''
  local result=0

  if (( ! REPO_TXN_ACTIVE || REPO_TXN_ROLLED_BACK || REPO_TXN_COMMITTED )); then
    return 0
  fi
  REPO_TXN_ROLLED_BACK=1
  for ((index = ${#REPO_ARTIFACT_PATHS[@]} - 1; index >= 0; index--)); do
    if [[ "${REPO_ARTIFACT_CHANGED[$index]:-0}" != 1 ]]; then
      continue
    fi
    artifact_path="${REPO_ARTIFACT_PATHS[$index]}"
    if [[ "${REPO_ARTIFACT_EXISTS[$index]}" == 1 ]]; then
      if ! restore_repo_artifact "$index"; then
        result=1
        if ! preserve_repo_recovery "$index"; then
          result=1
        fi
      fi
    else
      if [[ -L "$artifact_path" || ( -e "$artifact_path" && ! -f "$artifact_path" ) ]]; then
        result=1
        continue
      fi
      if [[ -f "$artifact_path" ]]; then
        if ! rm -f -- "$artifact_path" >/dev/null 2>&1; then
          result=1
          continue
        fi
      fi
      if [[ -e "$artifact_path" || -L "$artifact_path" ]]; then
        result=1
      fi
    fi
  done
  if ! remove_new_rpm_keys; then
    result=1
  fi
  if ! remove_repo_transaction_temps; then
    result=1
  fi
  if ! remove_repo_created_dirs; then
    result=1
  fi
  if (( result == 0 )); then
    REPO_TXN_ACTIVE=0
  fi
  return "$result"
}

repo_transaction_commit() {
  if (( ! REPO_TXN_ACTIVE || REPO_TXN_COMMITTED )); then
    return 0
  fi
  # Do not delete rollback backups while the caller still has a live EXIT trap.
  # They remain in the transaction's artifact directories until this commit point
  # is irrevocable; cleanup is best-effort after commit, so a later failure cannot
  # lose recovery data.
  REPO_CREATED_DIRS=()
  RPM_IMPORTED_KEYS=()
  REPO_TXN_COMMITTED=1
  REPO_TXN_ACTIVE=0
  if ! remove_repo_transaction_temps; then
    log 'Warning: committed repository transaction temporary cleanup failed' >&2
  fi
  return 0
}

install_alloy_official() {
  local key_file=''
  local keyring_file='/etc/apt/keyrings/grafana.gpg'
  local apt_repo_file='/etc/apt/sources.list.d/grafana.list'
  local rpm_repo_file='/etc/yum.repos.d/grafana.repo'
  local keyring_temp=''
  local apt_repo_content='deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main'
  local rpm_repo_content='[grafana]
name=Grafana
baseurl=https://rpm.grafana.com
repo_gpgcheck=1
enabled=1
gpgcheck=1
gpgkey=https://rpm.grafana.com/gpg.key
sslverify=1
type=rpm-md'
  local apt_source_options=()
  local rpm_install_options=()

  begin_repo_transaction
  create_temp_root
  if ! key_file="$(mktemp -- "$TEMP_ROOT/grafana-key.XXXXXX" 2>/dev/null)"; then
    fail 'temporary file unavailable' 50
  fi
  if ! chmod 600 -- "$key_file" >/dev/null 2>&1; then
    fail 'temporary file permissions could not be set' 50
  fi
  track_temp_file "$key_file"

  case "$PACKAGE_MANAGER" in
    apt-get)
      if ! prepare_repo_artifact "$keyring_file" || ! prepare_repo_artifact "$apt_repo_file"; then
        alloy_install_failed
      fi
      if ! curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
        --output "$key_file" 'https://apt.grafana.com/gpg.key' >/dev/null 2>&1; then
        alloy_install_failed
      fi
      if ! make_artifact_temp "$keyring_file" keyring_temp; then
        alloy_install_failed
      fi
      if ! gpg --batch --yes --dearmor --output "$keyring_temp" "$key_file" >/dev/null 2>&1; then
        alloy_install_failed
      fi
      if ! atomic_replace_artifact "$keyring_file" "$keyring_temp" 0644; then
        alloy_install_failed
      fi
      if ! write_atomic_artifact "$apt_repo_file" "$apt_repo_content" 0644; then
        alloy_install_failed
      fi
      apt_source_options=(
        -o "Dir::Etc::sourcelist=$apt_repo_file"
        -o 'Dir::Etc::sourceparts=-'
        -o 'Acquire::AllowInsecureRepositories=false'
        -o 'Acquire::AllowDowngradeToInsecureRepositories=false'
        -o 'APT::Get::List-Cleanup=0'
      )
      if ! DEBIAN_FRONTEND=noninteractive apt-get "${apt_source_options[@]}" update >/dev/null 2>&1; then
        alloy_install_failed
      fi
      if ! DEBIAN_FRONTEND=noninteractive apt-get "${apt_source_options[@]}" install -y --no-install-recommends alloy >/dev/null 2>&1; then
        alloy_install_failed
      fi
      ;;
    dnf|yum)
      if ! prepare_repo_artifact "$rpm_repo_file"; then
        alloy_install_failed
      fi
      capture_rpm_keys
      if ! curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
        --output "$key_file" 'https://rpm.grafana.com/gpg.key' >/dev/null 2>&1; then
        alloy_install_failed
      fi
      if ! write_atomic_artifact "$rpm_repo_file" "$rpm_repo_content" 0644; then
        alloy_install_failed
      fi
      if ! rpm --import "$key_file" >/dev/null 2>&1; then
        record_new_rpm_keys
        alloy_install_failed
      fi
      record_new_rpm_keys
      rpm_install_options=(
        -y
        --disablerepo='*'
        --enablerepo='grafana'
        --setopt=gpgcheck=1
        --setopt=repo_gpgcheck=1
        install
        alloy
      )
      if ! "$PACKAGE_MANAGER" "${rpm_install_options[@]}" >/dev/null 2>&1; then
        alloy_install_failed
      fi
      ;;
    *)
      alloy_install_failed
      ;;
  esac
}
