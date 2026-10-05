# [opsgrid-agent] Linux alloy definitions; loaded by install.sh.
# Loading this module does not install, enroll, or change service state.

ALLOY_BINARY_PATH=''
ALLOY_SERVICE_FILE=''
ALLOY_RUNTIME_GROUP=''
ALLOY_REUSE=0
ALLOY_PRE_RUN_CAPTURED=0
ALLOY_PRE_RUN_SERVICE_PRESENT=0
ALLOY_PRE_RUN_SERVICE_ACTIVE=0
ALLOY_PRE_RUN_SERVICE_ENABLED=0
ALLOY_PRE_RUN_CONFIG_EXISTS=0
ALLOY_PRE_RUN_CREDENTIAL_EXISTS=0
ALLOY_PRE_RUN_CONFIG_DIR_EXISTS=0
ALLOY_PRE_RUN_CONFIG_DIR_MODE=''
ALLOY_PRE_RUN_CONFIG_DIR_UID=''
ALLOY_PRE_RUN_CONFIG_DIR_GID=''
ALLOY_PRE_RUN_CREDENTIAL_DIR_EXISTS=0
ALLOY_PRE_RUN_CREDENTIAL_DIR_MODE=''
ALLOY_PRE_RUN_CREDENTIAL_DIR_UID=''
ALLOY_PRE_RUN_CREDENTIAL_DIR_GID=''
ALLOY_RUNTIME_USER=''
ALLOY_RUNTIME_ROOT=0

alloy_install_failed() {
  log 'Alloy install failed' >&2
  exit 20
}

safe_alloy_binary_path() {
  local candidate="$1"
  local resolved=''

  if [[ "$candidate" != /* || "$candidate" != */alloy ]]; then
    return 1
  fi
  if [[ ! "$candidate" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
    return 1
  fi
  if ! resolved="$(realpath -e -- "$candidate" 2>/dev/null)"; then
    return 1
  fi
  if [[ "$resolved" != /* || "$resolved" != */alloy ]]; then
    return 1
  fi
  if [[ ! "$resolved" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ ! -f "$resolved" ]] || [[ ! -x "$resolved" ]]; then
    return 1
  fi
  printf '%s' "$resolved"
}

# Grafana's Debian/RPM package starts Alloy through a fixed vendor wrapper
# (currently /usr/lib/alloy/alloy-wrapper). The wrapper ultimately execs the
# real binary, so keep the wrapper allowlisted but return the real binary for
# validation. Never accept an arbitrary executable path from ExecStart.

safe_alloy_wrapper_path() {
  local candidate="$1"
  local resolved=''

  case "$candidate" in
    /usr/lib/alloy/alloy-wrapper|/usr/libexec/alloy/alloy-wrapper|/opt/alloy/bin/alloy-wrapper)
      ;;
    *)
      return 1
      ;;
  esac
  if [[ ! "$candidate" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ -L "$candidate" ]] || [[ ! -f "$candidate" ]]; then
    return 1
  fi
  if ! resolved="$(realpath -e -- "$candidate" 2>/dev/null)" || [[ "$resolved" != "$candidate" ]]; then
    return 1
  fi
  if [[ ! -x "$resolved" ]]; then
    return 1
  fi
  printf '%s' "$resolved"
}

get_alloy_wrapper_binary() {
  local wrapper_path="$1"
  local candidate=''
  local resolved=''

  if ! safe_alloy_wrapper_path "$wrapper_path" >/dev/null 2>&1; then
    return 1
  fi

  # These are the fixed vendor layouts supported by the installer. The
  # official wrapper defaults to /usr/bin/alloy; the other paths cover the
  # existing portable layouts already accepted by this installer.
  for candidate in /usr/bin/alloy /usr/local/bin/alloy /opt/alloy/bin/alloy; do
    if resolved="$(safe_alloy_binary_path "$candidate" 2>/dev/null)"; then
      printf '%s' "$resolved"
      return 0
    fi
  done
  return 1
}

safe_alloy_service_file() {
  local candidate="$1"
  local resolved=''

  if [[ "$candidate" != /* || "$candidate" != */alloy.service ]]; then
    return 1
  fi
  if [[ ! "$candidate" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
    return 1
  fi
  if [[ -L "$candidate" ]] || [[ ! -f "$candidate" ]]; then
    return 1
  fi
  if ! resolved="$(realpath -e -- "$candidate" 2>/dev/null)" || [[ "$resolved" != "$candidate" ]]; then
    return 1
  fi
  printf '%s' "$candidate"
}

get_alloy_service_file() {
  local candidate=''
  local service_file=''

  if candidate="$(systemctl show alloy.service --property=FragmentPath --value 2>/dev/null)"; then
    candidate="${candidate//$'\r'/}"
    if [[ "$candidate" != *$'\n'* ]] && service_file="$(safe_alloy_service_file "$candidate" 2>/dev/null)"; then
      printf '%s' "$service_file"
      return 0
    fi
  fi

  for service_file in \
    /etc/systemd/system/alloy.service \
    /usr/lib/systemd/system/alloy.service \
    /lib/systemd/system/alloy.service \
    /run/systemd/system/alloy.service; do
    if service_file="$(safe_alloy_service_file "$service_file" 2>/dev/null)"; then
      printf '%s' "$service_file"
      return 0
    fi
  done
  return 1
}

get_alloy_execstart_from_service_file() {
  local service_file="$1"
  local line=''
  local value=''
  local resolved=''
  local wrapper_path=''

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      ExecStart=*)
        value="${line#ExecStart=}"
        while [[ "$value" == [-+@!]* ]]; do
          value="${value:1}"
        done
        if [[ "$value" == \"* ]]; then
          value="${value#\"}"
          value="${value%%\"*}"
        else
          value="${value%%[[:space:]]*}"
        fi
        if resolved="$(safe_alloy_binary_path "$value" 2>/dev/null)"; then
          printf '%s' "$resolved"
          return 0
        fi
        if wrapper_path="$(safe_alloy_wrapper_path "$value" 2>/dev/null)" \
            && resolved="$(get_alloy_wrapper_binary "$wrapper_path" 2>/dev/null)"; then
          printf '%s' "$resolved"
          return 0
        fi
        ;;
    esac
  done < "$service_file"
  return 1
}

get_alloy_execstart_from_metadata() {
  local metadata=''
  local path_pattern='path=([^[:space:];]+)'
  local value=''
  local resolved=''
  local wrapper_path=''

  if ! metadata="$(systemctl show alloy.service --property=ExecStart --value 2>/dev/null)"; then
    return 1
  fi
  if [[ "$metadata" =~ $path_pattern ]]; then
    value="${BASH_REMATCH[1]}"
    if resolved="$(safe_alloy_binary_path "$value" 2>/dev/null)"; then
      printf '%s' "$resolved"
      return 0
    fi
    if wrapper_path="$(safe_alloy_wrapper_path "$value" 2>/dev/null)" \
        && resolved="$(get_alloy_wrapper_binary "$wrapper_path" 2>/dev/null)"; then
      printf '%s' "$resolved"
      return 0
    fi
  fi
  return 1
}

get_alloy_service_binary() {
  local service_file="${1:-}"
  local resolved=''

  if [[ -n "$service_file" ]] && resolved="$(get_alloy_execstart_from_service_file "$service_file" 2>/dev/null)"; then
    printf '%s' "$resolved"
    return 0
  fi
  if resolved="$(get_alloy_execstart_from_metadata 2>/dev/null)"; then
    printf '%s' "$resolved"
    return 0
  fi
  return 1
}

alloy_is_installed() {
  local alloy_command=''
  local known_binary_path=''
  local service_file=''
  local service_binary=''
  local binary_present=0
  local service_present=0
  local service_valid=0
  local local_metadata=''

  ALLOY_BINARY_PATH=''
  ALLOY_SERVICE_FILE=''
  ALLOY_REUSE=0

  if alloy_command="$(command -v alloy 2>/dev/null)"; then
    if alloy_command="$(safe_alloy_binary_path "$alloy_command" 2>/dev/null)"; then
      ALLOY_BINARY_PATH="$alloy_command"
      binary_present=1
    fi
  fi

  # command -v intentionally uses the restricted system PATH above. Probe only
  # fixed, known Alloy layouts as a second source of evidence; never enumerate
  # directories or execute an arbitrary discovered executable.
  if (( ! binary_present )); then
    for known_binary_path in \
      /usr/bin/alloy \
      /usr/local/bin/alloy \
      /opt/alloy/bin/alloy; do
      if alloy_command="$(safe_alloy_binary_path "$known_binary_path" 2>/dev/null)"; then
        ALLOY_BINARY_PATH="$alloy_command"
        binary_present=1
        break
      fi
    done
  fi

  if systemctl cat alloy.service >/dev/null 2>&1; then
    service_present=1
  fi
  if service_file="$(get_alloy_service_file 2>/dev/null)"; then
    ALLOY_SERVICE_FILE="$service_file"
    service_present=1
  fi
  if ((service_present)) && service_binary="$(get_alloy_service_binary "$ALLOY_SERVICE_FILE" 2>/dev/null)"; then
    service_valid=1
    binary_present=1
    if [[ -z "$ALLOY_BINARY_PATH" ]]; then
      ALLOY_BINARY_PATH="$service_binary"
    fi
  fi

  if (( ! ALLOY_PRE_RUN_CAPTURED )); then
    ALLOY_PRE_RUN_SERVICE_PRESENT="$service_present"
    if ((service_present)); then
      if systemctl is-active --quiet alloy.service >/dev/null 2>&1; then
        ALLOY_PRE_RUN_SERVICE_ACTIVE=1
      fi
      if systemctl is-enabled --quiet alloy.service >/dev/null 2>&1; then
        ALLOY_PRE_RUN_SERVICE_ENABLED=1
      fi
    fi
    if [[ -e "$ALLOY_CONFIG_FILE" ]]; then
      ALLOY_PRE_RUN_CONFIG_EXISTS=1
    fi
    if [[ -e "$AGENT_CREDENTIAL_FILE" ]]; then
      ALLOY_PRE_RUN_CREDENTIAL_EXISTS=1
    fi
    local_metadata=''
    if [[ -d "${ALLOY_CONFIG_FILE%/*}" && ! -L "${ALLOY_CONFIG_FILE%/*}" ]]; then
      ALLOY_PRE_RUN_CONFIG_DIR_EXISTS=1
      if ! local_metadata="$(stat -c '%u:%g:%a' -- "${ALLOY_CONFIG_FILE%/*}" 2>/dev/null)"; then
        alloy_install_failed
      fi
      IFS=: read -r ALLOY_PRE_RUN_CONFIG_DIR_UID ALLOY_PRE_RUN_CONFIG_DIR_GID ALLOY_PRE_RUN_CONFIG_DIR_MODE <<< "$local_metadata"
    fi
    if [[ -d "${AGENT_CREDENTIAL_FILE%/*}" && ! -L "${AGENT_CREDENTIAL_FILE%/*}" ]]; then
      ALLOY_PRE_RUN_CREDENTIAL_DIR_EXISTS=1
      if ! local_metadata="$(stat -c '%u:%g:%a' -- "${AGENT_CREDENTIAL_FILE%/*}" 2>/dev/null)"; then
        alloy_install_failed
      fi
      IFS=: read -r ALLOY_PRE_RUN_CREDENTIAL_DIR_UID ALLOY_PRE_RUN_CREDENTIAL_DIR_GID ALLOY_PRE_RUN_CREDENTIAL_DIR_MODE <<< "$local_metadata"
    fi
    ALLOY_PRE_RUN_CAPTURED=1
  fi

  if ((binary_present && service_valid)); then
    ALLOY_REUSE=1
    return 0
  fi
  if ((binary_present || service_present)); then
    alloy_install_failed
  fi
  return 1
}

get_alloy_runtime_group() {
  local metadata=''
  local service_user=''
  local service_group=''
  local property_name=''
  local property_value=''
  local user_property_read=0
  local group_property_read=0

  ALLOY_RUNTIME_USER=''
  ALLOY_RUNTIME_GROUP=''
  ALLOY_RUNTIME_ROOT=0

  # Read both properties in one quiet systemd query. The fallback preserves
  # compatibility with older fixtures that expose --property/--value only.
  # A failed query is never treated as a root service: credential permissions
  # must be derived from an observed service identity before any mutation.
  if metadata="$(systemctl show -p User -p Group alloy 2>/dev/null)" && [[ -n "$metadata" ]]; then
    while IFS='=' read -r property_name property_value || [[ -n "$property_name" ]]; do
      property_value="${property_value%$'\r'}"
      case "$property_name" in
        User)
          service_user="$property_value"
          user_property_read=1
          ;;
        Group)
          service_group="$property_value"
          group_property_read=1
          ;;
      esac
    done <<< "$metadata"
  else
    if service_user="$(systemctl show alloy.service --property=User --value 2>/dev/null)"; then
      user_property_read=1
    fi
    if service_group="$(systemctl show alloy.service --property=Group --value 2>/dev/null)"; then
      group_property_read=1
    fi
    service_user="${service_user//$'\n'/}"
    service_group="${service_group//$'\n'/}"
  fi

  if (( ! user_property_read || ! group_property_read )); then
    return 1
  fi
  service_user="${service_user//$'\r'/}"
  service_group="${service_group//$'\r'/}"
  if [[ "$service_user" == '-' || -z "$service_user" || "$service_user" == 'root' || "$service_user" == '0' ]]; then
    # A root service must not receive group-readable credentials even when its
    # unit declares a non-root supplemental Group= value.
    ALLOY_RUNTIME_USER='root'
    ALLOY_RUNTIME_GROUP='root'
    ALLOY_RUNTIME_ROOT=1
    return 0
  fi
  if [[ ! "$service_user" =~ ^[A-Za-z0-9._-]+$ ]] || ! id -u "$service_user" >/dev/null 2>&1; then
    return 1
  fi

  if [[ "$service_group" == '-' ]]; then
    service_group=''
  fi
  if [[ -z "$service_group" ]]; then
    if ! service_group="$(id -gn "$service_user" 2>/dev/null)"; then
      return 1
    fi
  fi
  if [[ ! "$service_group" =~ ^[A-Za-z0-9._-]+$ ]] || ! getent group "$service_group" >/dev/null 2>&1; then
    return 1
  fi

  ALLOY_RUNTIME_USER="$service_user"
  ALLOY_RUNTIME_GROUP="$service_group"
  return 0
}

task4_service_present_now() {
  local load_state=''

  if load_state="$(systemctl show alloy.service --property=LoadState --value 2>/dev/null)"; then
    load_state="${load_state//$'\r'/}"
    if [[ "$load_state" == 'loaded' || "$load_state" == 'masked' ]]; then
      return 0
    fi
  fi
  systemctl cat alloy.service >/dev/null 2>&1
}

task4_read_service_flags() {
  local active_state=''
  local enabled_state=''
  local active_rc=0
  local enabled_rc=0

  TASK4_CURRENT_SERVICE_PRESENT=0
  TASK4_CURRENT_SERVICE_ACTIVE=0
  TASK4_CURRENT_SERVICE_ENABLED=0
  if ! task4_service_present_now; then
    return 0
  fi
  TASK4_CURRENT_SERVICE_PRESENT=1

  active_state="$(systemctl is-active alloy.service 2>/dev/null)" || active_rc=$?
  case "$active_state" in
    active) TASK4_CURRENT_SERVICE_ACTIVE=1 ;;
    inactive|failed|deactivating|activating) TASK4_CURRENT_SERVICE_ACTIVE=0 ;;
    *) return 1 ;;
  esac
  if (( active_rc != 0 )) && [[ "$active_state" != 'inactive' && "$active_state" != 'failed' && "$active_state" != 'deactivating' && "$active_state" != 'activating' ]]; then
    return 1
  fi

  enabled_state="$(systemctl is-enabled alloy.service 2>/dev/null)" || enabled_rc=$?
  case "$enabled_state" in
    enabled|enabled-runtime) TASK4_CURRENT_SERVICE_ENABLED=1 ;;
    disabled|static|masked|indirect|generated|transient|unknown) TASK4_CURRENT_SERVICE_ENABLED=0 ;;
    *) return 1 ;;
  esac
  if (( enabled_rc != 0 )) && [[ "$enabled_state" != 'disabled' && "$enabled_state" != 'static' && "$enabled_state" != 'masked' && "$enabled_state" != 'indirect' && "$enabled_state" != 'generated' && "$enabled_state" != 'transient' && "$enabled_state" != 'unknown' ]]; then
    return 1
  fi
  return 0
}

wait_for_service() {
  local attempt=1

  while (( attempt <= 60 )); do
    if systemctl is-active --quiet alloy.service >/dev/null 2>&1; then
      return 0
    fi
    if (( attempt == 60 )); then
      break
    fi
    sleep 1 >/dev/null 2>&1 || true
    attempt=$((attempt + 1))
  done
  return 1
}
