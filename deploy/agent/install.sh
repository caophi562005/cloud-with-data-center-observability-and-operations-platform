#!/usr/bin/env bash
set -Eeuo pipefail
# Enrollment tokens must never appear in caller-enabled xtrace output.
set +x
umask 077
PATH='/usr/sbin:/usr/bin:/sbin:/bin'
export PATH

# [opsgrid-agent] Enrollment API and metric ingestion are separate endpoints.
API_BASE_URL_DEFAULT='https://api.opsgrid.hacmieu.com'
GATEWAY_URL_DEFAULT='https://opsgrid-ingest.bravecliff-c4215c1b.southeastasia.azurecontainerapps.io/api/v1/write'
CREDENTIAL_FILE_PLACEHOLDER='__CREDENTIAL_FILE__'
GATEWAY_URL_PLACEHOLDER='__GATEWAY_URL__'
OUTPUT_PREFIX='[opsgrid-agent]'
SCRIPT_DIR=''
LINUX_TEMPLATE_FILE=''

# [opsgrid-agent] Linux platform paths reserved by the shared contract.
AGENT_CREDENTIAL_FILE='/etc/opsgrid-agent/agent.credential'
ALLOY_CONFIG_FILE='/etc/alloy/config.alloy'
INSTALL_LOCK_FILE='/run/lock/opsgrid-agent-install.lock'
PRIVATE_INSTALL_LOCK_FILE='/run/opsgrid-agent/opsgrid-agent-install.lock'

# [opsgrid-agent] Task 2 state. These values are intentionally kept in memory only.
API_BASE_URL="$API_BASE_URL_DEFAULT"
GATEWAY_URL="$GATEWAY_URL_DEFAULT"
RE_ENROLL=0
ENROLLMENT_TOKEN=''
SHOW_HELP=0
DISTRO_ID=''
DISTRO_ID_LIKE=''
DISTRO_VERSION=''
OS_PRETTY_NAME=''
OS_METADATA=''
PLATFORM_ARCH=''
PACKAGE_MANAGER=''
LOCK_FD=''
PRIVATE_LOCK_FD=''
TEMP_ROOT=''
TEMP_ROOT_CREATED=0
TEMP_FILES=()

# [opsgrid-agent] Repository files are changed transactionally and rolled back
# unless enrollment and all Task 3 preparation steps complete successfully.
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
REPO_CREATED_DIRS=()
RPM_PRE_RUN_KEYS=''
RPM_IMPORTED_KEYS=()

# [opsgrid-agent] Task 3 state. Credentials and enrollment payloads remain in memory
# or in the invocation-owned temporary root until cleanup removes them.
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
ENROLLMENT_REQUEST_FILE=''
ENROLLMENT_RESPONSE_FILE=''
ENROLLMENT_STATUS_FILE=''
ENROLLED_CREDENTIAL=''
ENROLLMENT_MAX_ATTEMPTS=3
ENROLLMENT_RETRY_DELAYS=(1 2)

# [opsgrid-agent] Task 4 credential/config/service transaction state.
ALLOY_RUNTIME_USER=''
ALLOY_RUNTIME_ROOT=0
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

log() {
  printf '%s %s\n' "$OUTPUT_PREFIX" "$*"
}

fail() {
  local message="$1"
  local exit_code="${2:-10}"
  log "Error: $message" >&2
  exit "$exit_code"
}

fail_unsupported_platform() {
  log 'unsupported platform' >&2
  exit 10
}

usage() {
  printf '%s Usage: install.sh [OPTIONS]\n' "$OUTPUT_PREFIX"
  printf '%s   --enrollment-token TOKEN  Enrollment token input (not echoed)\n' "$OUTPUT_PREFIX"
  printf '%s   --api-base-url URL        Enrollment API base URL (default: %s)\n' "$OUTPUT_PREFIX" "$API_BASE_URL_DEFAULT"
  printf '%s   --gateway-url URL         Gateway base or /api/v1/write URL (default: %s)\n' "$OUTPUT_PREFIX" "$GATEWAY_URL_DEFAULT"
  printf '%s   --re-enroll               Explicitly replace an existing credential using a new token\n' "$OUTPUT_PREFIX"
  printf '%s Existing agents reuse credentials and reconcile only the Gateway URL.\n' "$OUTPUT_PREFIX"
  printf '%s   --help                    Show this help text\n' "$OUTPUT_PREFIX"
}

parse_args() {
  API_BASE_URL="$API_BASE_URL_DEFAULT"
  GATEWAY_URL="$GATEWAY_URL_DEFAULT"
  RE_ENROLL=0
  ENROLLMENT_TOKEN=''
  SHOW_HELP=0

  while (($# > 0)); do
    case "$1" in
      --enrollment-token)
        if (($# < 2)) || [[ "$2" == --* ]]; then
          fail '--enrollment-token requires a value'
        fi
        ENROLLMENT_TOKEN="$2"
        if [[ -z "$ENROLLMENT_TOKEN" ]]; then
          fail '--enrollment-token requires a non-empty value'
        fi
        shift 2
        ;;
      --api-base-url)
        if (($# < 2)) || [[ "$2" == --* ]]; then
          fail '--api-base-url requires a value'
        fi
        API_BASE_URL="$2"
        shift 2
        ;;
      --gateway-url)
        if (($# < 2)) || [[ -z "$2" || "$2" == --* ]]; then
          fail '--gateway-url requires a value'
        fi
        GATEWAY_URL="$2"
        shift 2
        ;;
      --re-enroll)
        RE_ENROLL=1
        shift
        ;;
      --help)
        SHOW_HELP=1
        shift
        ;;
      *)
        # Do not echo the unknown argument: a token-like value must never leak.
        fail 'unknown option'
        ;;
    esac
  done
}

validate_port() {
  local value="$1"
  local numeric=0

  if [[ -z "$value" ]]; then
    return 0
  fi
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( ${#value} > 5 )); then
    fail 'invalid API base URL'
  fi
  numeric=$((10#$value))
  if ((numeric < 1 || numeric > 65535)); then
    fail 'invalid API base URL'
  fi
}

validate_api_url() {
  local url="$API_BASE_URL"
  local scheme=''
  local remainder=''
  local authority=''
  local host=''
  local port=''

  # The base URL must be a single-line absolute URL. Credentials and fragments
  # are rejected so user input cannot be mistaken for a host or API path.
  if [[ -z "$url" || "$url" == *[$' \t\r\n']* || "$url" == *'#'* ]]; then
    fail 'invalid API base URL'
  fi

  case "$url" in
    https://*)
      scheme='https'
      remainder="${url#https://}"
      ;;
    http://*)
      scheme='http'
      remainder="${url#http://}"
      ;;
    *)
      fail 'invalid API base URL'
      ;;
  esac

  # The API base is authority-only. Reject every path, query, and fragment so
  # the enrollment target is exactly "$API_BASE_URL/api/v1/agent-enrollment".
  authority="$remainder"
  if [[ "$authority" == *[/?#]* ]]; then
    fail 'invalid API base URL'
  fi
  if [[ -z "$authority" || "$authority" == *'@'* ]]; then
    fail 'invalid API base URL'
  fi

  # Accept bracketed IPv6 authorities and conventional host:port authorities.
  # The unbracketed ::1 spelling is retained for local mock compatibility.
  if [[ "$authority" == \[* ]]; then
    if [[ "$authority" =~ ^\[([0-9A-Fa-f:.]+)\](:([0-9]+))?$ ]]; then
      host="${BASH_REMATCH[1]}"
      port="${BASH_REMATCH[3]}"
    else
      fail 'invalid API base URL'
    fi
  elif [[ "$authority" == *:* ]]; then
    if [[ "$authority" == '::1' ]]; then
      host='::1'
    elif [[ "$scheme" == 'http' && "$authority" =~ ^::1:([0-9]+)$ ]]; then
      host='::1'
      port="${BASH_REMATCH[1]}"
    elif [[ "$authority" =~ ^([^:]+):([0-9]+)$ ]]; then
      host="${BASH_REMATCH[1]}"
      port="${BASH_REMATCH[2]}"
    else
      fail 'invalid API base URL'
    fi
  else
    host="$authority"
  fi

  validate_port "$port"
  if [[ -z "$host" || "$host" == *'['* || "$host" == *']'* ]]; then
    fail 'invalid API base URL'
  fi

  if [[ "$scheme" == 'http' ]]; then
    case "$host" in
      localhost|127.0.0.1|::1)
        return 0
        ;;
      *)
        fail 'invalid API base URL'
        ;;
    esac
  fi
}

# Only the Remote Write v1 endpoint is supported. A base URL is normalized to
# that endpoint; rejecting quotes, queries, userinfo and escapes also prevents
# injection into the Alloy quoted string below. Plain HTTP is loopback-only.
validate_gateway_url() {
  local pattern='^(https|http)://([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(:([0-9]{1,5}))?(/api/v1/write)?/?$'
  local scheme='' host='' port='' authority=''
  if [[ ! "$GATEWAY_URL" =~ $pattern ]]; then
    fail 'invalid Gateway URL'
  fi
  scheme="${BASH_REMATCH[1]}"
  host="${BASH_REMATCH[2]}"
  port="${BASH_REMATCH[5]}"
  authority="$host"
  if [[ -n "$port" ]]; then
    if (( 10#$port < 1 || 10#$port > 65535 )); then
      fail 'invalid Gateway URL'
    fi
    authority+=":$port"
  fi
  if [[ "$scheme" == http ]]; then
    case "$host" in
      localhost|127.0.0.1|\[::1\]) ;;
      *) fail 'Gateway URL must use HTTPS' ;;
    esac
  fi
  GATEWAY_URL="$scheme://$authority/api/v1/write"
}

read_os_release() {
  local key=''
  local value=''
  local os_release_file='/etc/os-release'

  if [[ ! -r "$os_release_file" ]]; then
    fail 'preflight failed: /etc/os-release is unavailable'
  fi

  DISTRO_ID=''
  DISTRO_ID_LIKE=''
  DISTRO_VERSION=''
  OS_PRETTY_NAME=''

  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    value="${value%$'\r'}"
    # os-release values may be quoted; strip only a complete matching pair.
    if [[ ${#value} -ge 2 && "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ ${#value} -ge 2 && "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    case "$key" in
      ID) DISTRO_ID="$value" ;;
      ID_LIKE) DISTRO_ID_LIKE="$value" ;;
      VERSION_ID) DISTRO_VERSION="$value" ;;
      PRETTY_NAME) OS_PRETTY_NAME="$value" ;;
    esac
  done < "$os_release_file"
}

is_rpm_family_id() {
  case "$1" in
    amazon|almalinux|alma|amzn|centos|cloudlinux|eurolinux|fedora|fedora-coreos|ol|oracle|oraclelinux|redhat|rhel|rocky|scientific|scientificlinux)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_rpm_family() {
  local family=''
  local family_ids=()

  if is_rpm_family_id "$DISTRO_ID"; then
    return 0
  fi
  read -r -a family_ids <<< "$DISTRO_ID_LIKE"
  for family in "${family_ids[@]}"; do
    if is_rpm_family_id "$family"; then
      return 0
    fi
  done
  return 1
}

detect_platform() {
  local machine=''
  local uname_path=''

  # Check uname before invoking it so a stripped-down host still gets a stable
  # preflight result instead of Bash's command-not-found diagnostic.
  if ! uname_path="$(command -v uname 2>/dev/null)" || [[ -z "$uname_path" ]]; then
    fail 'preflight failed: required command unavailable'
  fi
  if ! machine="$(uname -m 2>/dev/null)" || [[ -z "$machine" ]]; then
    fail 'preflight failed: architecture detection failed'
  fi

  case "$machine" in
    x86_64) PLATFORM_ARCH='amd64' ;;
    aarch64|arm64) PLATFORM_ARCH='arm64' ;;
    *) fail_unsupported_platform ;;
  esac

  read_os_release

  case "$DISTRO_ID" in
    ubuntu|debian)
      if command -v apt-get >/dev/null 2>&1; then
        PACKAGE_MANAGER='apt-get'
      else
        fail_unsupported_platform
      fi
      ;;
    *)
      if ! is_rpm_family; then
        fail_unsupported_platform
      fi
      if command -v dnf >/dev/null 2>&1; then
        PACKAGE_MANAGER='dnf'
      elif command -v yum >/dev/null 2>&1; then
        PACKAGE_MANAGER='yum'
      else
        fail_unsupported_platform
      fi
      ;;
  esac
}

enforce_root() {
  if [[ "${EUID:-1}" -ne 0 ]]; then
    fail 'preflight failed: root privileges are required'
  fi
}

check_ca_certificates() {
  local package_status=''

  case "$PACKAGE_MANAGER" in
    apt-get)
      if command -v dpkg-query >/dev/null 2>&1; then
        package_status="$(dpkg-query -W -f='${Status}' ca-certificates 2>/dev/null || true)"
        if [[ "$package_status" == 'install ok installed' ]]; then
          return 0
        fi
      fi
      # apt-cache reads the local package index and does not install or refresh it.
      if command -v apt-cache >/dev/null 2>&1 && apt-cache show ca-certificates >/dev/null 2>&1; then
        return 0
      fi
      ;;
    dnf|yum)
      if command -v rpm >/dev/null 2>&1 && rpm -q ca-certificates >/dev/null 2>&1; then
        return 0
      fi
      # --cacheonly prevents a metadata refresh/network access during preflight.
      if "$PACKAGE_MANAGER" --cacheonly list available ca-certificates >/dev/null 2>&1; then
        return 0
      fi
      ;;
  esac

  fail 'preflight failed: ca-certificates package unavailable'
}

require_commands() {
  local required_command=''
  local required_commands=(
    curl jq gpg systemctl mktemp install mkdir chmod chown sed awk uname flock rm rmdir stat realpath cp mv sleep getent id cmp
  )

  required_commands+=("$PACKAGE_MANAGER")
  case "$PACKAGE_MANAGER" in
    dnf|yum) required_commands+=(rpm) ;;
  esac
  for required_command in "${required_commands[@]}"; do
    if ! command -v "$required_command" >/dev/null 2>&1; then
      fail 'preflight failed: required command unavailable'
    fi
  done

  check_ca_certificates
}

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
  if ! exec {PRIVATE_LOCK_FD}>>"$private_lock_file" 2>/dev/null; then
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
  if ! exec {LOCK_FD}>>"$lock_file" 2>/dev/null; then
    fail 'preflight failed: lock file unavailable'
  fi
  if ! chmod 600 -- "$lock_file" 2>/dev/null; then
    fail 'preflight failed: lock file permissions could not be set'
  fi
  if ! flock -n "$LOCK_FD" >/dev/null 2>&1; then
    fail 'installation lock is already held'
  fi
}

read_enrollment_token() {
  if [[ -n "$ENROLLMENT_TOKEN" ]]; then
    return 0
  fi

  if [[ ! -t 0 ]]; then
    fail 'enrollment token is required'
  fi

  printf '%s Enrollment token: ' "$OUTPUT_PREFIX" >&2
  if ! IFS= read -r -s ENROLLMENT_TOKEN; then
    printf '\n' >&2
    fail 'enrollment token is required'
  fi
  printf '\n' >&2
  if [[ -z "$ENROLLMENT_TOKEN" ]]; then
    fail 'enrollment token is required'
  fi
}

get_os_metadata() {
  local cleaned=''

  if [[ -n "$OS_PRETTY_NAME" ]]; then
    cleaned="$(printf '%s' "$OS_PRETTY_NAME" | sed -e 's/[[:cntrl:]]//g' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' || true)"
    OS_METADATA="${cleaned:0:128}"
  else
    OS_METADATA=''
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
  local directory="${target_path%/*}"
  local temporary=''
  local canonical=''

  if ! ensure_artifact_directory "$directory"; then
    return 1
  fi
  if ! temporary="$(mktemp -- "$directory/.opsgrid-agent-install.XXXXXX" 2>/dev/null)"; then
    return 1
  fi
  if ! chmod 600 -- "$temporary" >/dev/null 2>&1; then
    rm -f -- "$temporary" >/dev/null 2>&1 || true
    return 1
  fi
  if ! canonical="$(realpath -e -- "$temporary" 2>/dev/null)" || [[ "$canonical" != "$temporary" ]] || [[ -L "$temporary" ]]; then
    rm -f -- "$temporary" >/dev/null 2>&1 || true
    return 1
  fi
  REPO_TXN_TEMP_FILES+=("$temporary")
  printf '%s' "$temporary"
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
    if ! backup="$(make_artifact_temp "$artifact_path")"; then
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

  if ! temporary="$(make_artifact_temp "$artifact_path")"; then
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
  local result=0

  for temporary in "${REPO_TXN_TEMP_FILES[@]}"; do
    [[ -z "$temporary" ]] && continue
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

repo_transaction_rollback() {
  local index=0
  local artifact_path=''
  local backup=''
  local mode=''
  local uid=''
  local gid=''
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
    backup="${REPO_ARTIFACT_BACKUPS[$index]}"
    if [[ "${REPO_ARTIFACT_EXISTS[$index]}" == 1 ]]; then
      if [[ -z "$backup" || ! -f "$backup" || -L "$backup" || -L "$artifact_path" || ( -e "$artifact_path" && ! -f "$artifact_path" ) ]]; then
        result=1
        continue
      fi
      mode="${REPO_ARTIFACT_MODES[$index]}"
      uid="${REPO_ARTIFACT_UIDS[$index]}"
      gid="${REPO_ARTIFACT_GIDS[$index]}"
      if ! chmod "$mode" -- "$backup" >/dev/null 2>&1 || ! chown "$uid:$gid" -- "$backup" >/dev/null 2>&1 || ! mv -f -- "$backup" "$artifact_path" >/dev/null 2>&1; then
        result=1
        continue
      fi
      if [[ -L "$artifact_path" || ! -f "$artifact_path" ]]; then
        result=1
        continue
      fi
      if [[ "$(stat -c '%u:%g:%a' -- "$artifact_path" 2>/dev/null || true)" != "$uid:$gid:$mode" ]]; then
        result=1
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

alloy_install_failed() {
  log 'Alloy install failed' >&2
  exit 20
}

enrollment_failed() {
  local enrollment_file=''
  local temp_root="${TEMP_ROOT:-}"

  # Enrollment failures must not retain request/response data or touch the
  # persistent credential/configuration paths owned by later tasks.
  for enrollment_file in "${ENROLLMENT_REQUEST_FILE:-}" "${ENROLLMENT_RESPONSE_FILE:-}" "${ENROLLMENT_STATUS_FILE:-}"; do
    if [[ -n "$temp_root" && -n "$enrollment_file" && "$enrollment_file" == "$temp_root/"* && -e "$enrollment_file" ]]; then
      rm -f -- "$enrollment_file" >/dev/null 2>&1 || true
    fi
  done

  log 'enrollment failed' >&2
  exit 30
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
      if ! keyring_temp="$(make_artifact_temp "$keyring_file")"; then
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

resolve_script_paths() {
  local source_path="${BASH_SOURCE[0]}"
  local source_dir=''

  if [[ "$source_path" != /* ]]; then
    source_path="$PWD/$source_path"
  fi
  source_dir="${source_path%/*}"
  if [[ "$source_dir" == "$source_path" || -z "$source_dir" ]]; then
    source_dir='.'
  fi
  if ! SCRIPT_DIR="$(cd -- "$source_dir" 2>/dev/null && pwd -P)"; then
    return 1
  fi
  LINUX_TEMPLATE_FILE="$SCRIPT_DIR/alloy/linux.config.alloy.template"
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
  task4_capture_service_state
  TASK4_SNAPSHOT_READY=1
  TASK4_TXN_ACTIVE=1
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

write_credential_atomic() {
  local credential_dir="${AGENT_CREDENTIAL_FILE%/*}"
  local temporary=''
  local mode='0640'
  local target_mode='640'
  local group="$ALLOY_RUNTIME_GROUP"
  local metadata=''
  local uid=''
  local gid=''
  local actual_mode=''

  if [[ -z "$group" || ! "$ENROLLED_CREDENTIAL" =~ ^AGT_[A-Za-z0-9_-]+$ ]]; then
    return 1
  fi
  if ! task4_ensure_credential_directory; then
    return 1
  fi
  if [[ -L "$AGENT_CREDENTIAL_FILE" || ( -e "$AGENT_CREDENTIAL_FILE" && ! -f "$AGENT_CREDENTIAL_FILE" ) ]]; then
    return 1
  fi
  if (( ALLOY_RUNTIME_ROOT )); then
    group='root'
    mode='0600'
    target_mode='600'
  fi
  if ! temporary="$(mktemp -- "$credential_dir/.opsgrid-agent-credential.XXXXXX" 2>/dev/null)"; then
    return 1
  fi
  if ! task4_track_temp "$temporary" || ! chmod 600 -- "$temporary" >/dev/null 2>&1; then
    rm -f -- "$temporary" >/dev/null 2>&1 || true
    return 1
  fi
  # Alloy's local.file component reads the credential bytes verbatim. Do not
  # append a newline: it would become an invalid Authorization header value.
  if ! printf '%s' "$ENROLLED_CREDENTIAL" > "$temporary"; then
    return 1
  fi
  if ! chown "root:$group" -- "$temporary" >/dev/null 2>&1 || ! chmod "$mode" -- "$temporary" >/dev/null 2>&1; then
    return 1
  fi
  if ! metadata="$(stat -c '%u:%g:%a' -- "$temporary" 2>/dev/null)"; then
    return 1
  fi
  IFS=: read -r uid gid actual_mode <<< "$metadata"
  if [[ "$uid" != '0' || "$gid" != "$(getent group "$group" | cut -d: -f3)" || "$actual_mode" != "$target_mode" ]]; then
    return 1
  fi
  if [[ -L "$AGENT_CREDENTIAL_FILE" ]]; then
    return 1
  fi
  if ! mv -f -- "$temporary" "$AGENT_CREDENTIAL_FILE" >/dev/null 2>&1; then
    return 1
  fi
  TASK4_CREDENTIAL_CHANGED=1
  TASK4_CREDENTIAL_STAGE=''
  if [[ -L "$AGENT_CREDENTIAL_FILE" || ! -f "$AGENT_CREDENTIAL_FILE" ]]; then
    return 1
  fi
  if ! metadata="$(stat -c '%u:%g:%a' -- "$AGENT_CREDENTIAL_FILE" 2>/dev/null)"; then
    return 1
  fi
  if [[ "$metadata" != "0:$(getent group "$group" | cut -d: -f3):$target_mode" ]]; then
    return 1
  fi
}

render_config_atomic() {
  local config_dir="${ALLOY_CONFIG_FILE%/*}"
  local template_content=''
  local without_placeholder=''
  local rendered=''
  local temporary=''
  local placeholder_length=${#CREDENTIAL_FILE_PLACEHOLDER}
  local placeholder_bytes=0

  if [[ -z "$LINUX_TEMPLATE_FILE" || -L "$LINUX_TEMPLATE_FILE" || ! -f "$LINUX_TEMPLATE_FILE" || ! -r "$LINUX_TEMPLATE_FILE" ]]; then
    return 1
  fi
  if ! template_content="$(<"$LINUX_TEMPLATE_FILE")"; then
    return 1
  fi
  without_placeholder="${template_content//"$CREDENTIAL_FILE_PLACEHOLDER"/}"
  placeholder_bytes=$(( ${#template_content} - ${#without_placeholder} ))
  if (( placeholder_length == 0 || placeholder_bytes != placeholder_length )); then
    return 1
  fi
  without_placeholder="${template_content//"$GATEWAY_URL_PLACEHOLDER"/}"
  placeholder_bytes=$(( ${#template_content} - ${#without_placeholder} ))
  if (( placeholder_bytes != ${#GATEWAY_URL_PLACEHOLDER} )); then
    return 1
  fi
  rendered="${template_content//"$CREDENTIAL_FILE_PLACEHOLDER"/"$AGENT_CREDENTIAL_FILE"}"
  rendered="${rendered//"$GATEWAY_URL_PLACEHOLDER"/"$GATEWAY_URL"}"
  if [[ "$rendered" == *"$ENROLLED_CREDENTIAL"* || "$rendered" == *'AGT_'* ]]; then
    return 1
  fi
  if [[ -n "${ENROLLMENT_TOKEN:-}" && "$rendered" == *"$ENROLLMENT_TOKEN"* ]]; then
    return 1
  fi
  if ! task4_ensure_config_directory; then
    return 1
  fi
  if [[ -L "$ALLOY_CONFIG_FILE" || ( -e "$ALLOY_CONFIG_FILE" && ! -f "$ALLOY_CONFIG_FILE" ) ]]; then
    return 1
  fi
  if ! temporary="$(mktemp -- "$config_dir/.opsgrid-agent-config.XXXXXX" 2>/dev/null)"; then
    return 1
  fi
  if ! task4_track_temp "$temporary" || ! chmod 600 -- "$temporary" >/dev/null 2>&1; then
    rm -f -- "$temporary" >/dev/null 2>&1 || true
    return 1
  fi
  if ! printf '%s\n' "$rendered" > "$temporary"; then
    return 1
  fi
  if [[ -n "${ENROLLMENT_TOKEN:-}" ]] && grep -F -- "$ENROLLMENT_TOKEN" "$temporary" >/dev/null 2>&1; then
    return 1
  fi
  TASK4_CONFIG_STAGE="$temporary"
}

validate_alloy_config() {
  if [[ -z "$ALLOY_BINARY_PATH" || ! -x "$ALLOY_BINARY_PATH" || -z "$TASK4_CONFIG_STAGE" || ! -f "$TASK4_CONFIG_STAGE" || -L "$TASK4_CONFIG_STAGE" ]]; then
    return 1
  fi
  # Grafana Alloy's validate command takes the config path positionally;
  # --config.file is a run-mode flag and is rejected by the vendor CLI.
  "$ALLOY_BINARY_PATH" validate "$TASK4_CONFIG_STAGE" >/dev/null 2>&1
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
  # Staging/validation can fail before any persistent mutation. Do not stop a
  # healthy running service or rewrite unchanged credentials just to discard a
  # rejected stage (the live process may still be using a valid older config).
  if (( ! TASK4_SERVICE_MUTATED && ! TASK4_CREDENTIAL_CHANGED && ! TASK4_CONFIG_CHANGED && ! TASK4_CREDENTIAL_DIR_CHANGED && ! TASK4_CONFIG_DIR_CHANGED )); then
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

validate_enrollment_json() {
  local response_file="$1"

  if [[ -z "$response_file" || ! -f "$response_file" ]]; then
    return 1
  fi
  jq -e '
    type == "object"
    and (.status == "ACTIVE")
    and (.agentId | if type == "string" then length > 0 else false end)
    and (.organizationId | if type == "string" then length > 0 else false end)
    and (.vmId | if type == "string" then length > 0 else false end)
    and (.credential | if type == "string" then test("^AGT_[A-Za-z0-9_-]+$") else false end)
  ' "$response_file" >/dev/null 2>&1
}

post_enrollment() {
  local http_code=''
  local curl_exit=0
  local attempt=1
  local retryable=0
  local retry_delay=0

  create_temp_root
  if ! ENROLLMENT_REQUEST_FILE="$(mktemp -- "$TEMP_ROOT/enrollment-request.XXXXXX" 2>/dev/null)"; then
    fail 'temporary file unavailable' 50
  fi
  if ! chmod 600 -- "$ENROLLMENT_REQUEST_FILE" >/dev/null 2>&1; then
    fail 'temporary file permissions could not be set' 50
  fi
  track_temp_file "$ENROLLMENT_REQUEST_FILE"

  if ! ENROLLMENT_RESPONSE_FILE="$(mktemp -- "$TEMP_ROOT/enrollment-response.XXXXXX" 2>/dev/null)"; then
    fail 'temporary file unavailable' 50
  fi
  if ! chmod 600 -- "$ENROLLMENT_RESPONSE_FILE" >/dev/null 2>&1; then
    fail 'temporary file permissions could not be set' 50
  fi
  track_temp_file "$ENROLLMENT_RESPONSE_FILE"

  if ! ENROLLMENT_STATUS_FILE="$(mktemp -- "$TEMP_ROOT/enrollment-status.XXXXXX" 2>/dev/null)"; then
    fail 'temporary file unavailable' 50
  fi
  if ! chmod 600 -- "$ENROLLMENT_STATUS_FILE" >/dev/null 2>&1; then
    fail 'temporary file permissions could not be set' 50
  fi
  track_temp_file "$ENROLLMENT_STATUS_FILE"

  if [[ -n "$OS_METADATA" ]]; then
    if ! jq -n --arg token "$ENROLLMENT_TOKEN" --arg os "$OS_METADATA" \
      '{token: $token, os: $os}' > "$ENROLLMENT_REQUEST_FILE" 2>/dev/null; then
      enrollment_failed
    fi
  else
    if ! jq -n --arg token "$ENROLLMENT_TOKEN" \
      '{token: $token}' > "$ENROLLMENT_REQUEST_FILE" 2>/dev/null; then
      enrollment_failed
    fi
  fi

  while ((attempt <= ENROLLMENT_MAX_ATTEMPTS)); do
    : > "$ENROLLMENT_RESPONSE_FILE"
    : > "$ENROLLMENT_STATUS_FILE"
    if curl --request POST --header 'Content-Type: application/json' \
      --connect-timeout 10 --max-time 30 --silent \
      --data-binary "@$ENROLLMENT_REQUEST_FILE" \
      --output "$ENROLLMENT_RESPONSE_FILE" --write-out '%{http_code}' \
      "$API_BASE_URL/api/v1/agent-enrollment" > "$ENROLLMENT_STATUS_FILE" 2>/dev/null; then
      curl_exit=0
    else
      curl_exit=$?
    fi

    http_code="$(<"$ENROLLMENT_STATUS_FILE")"
    retryable=0
    if ((curl_exit != 0)); then
      case "$curl_exit" in
        5|6|7|28|35|52|55|56) retryable=1 ;;
      esac
      http_code='000'
    else
      if [[ ! "$http_code" =~ ^[0-9]{3}$ ]]; then
        http_code='000'
      fi
      case "$http_code" in
        408|429|5??) retryable=1 ;;
      esac
    fi

    if ((retryable)); then
      if ((attempt < ENROLLMENT_MAX_ATTEMPTS)); then
        retry_delay="${ENROLLMENT_RETRY_DELAYS[$((attempt - 1))]}"
        sleep "$retry_delay" >/dev/null 2>&1 || true
        attempt=$((attempt + 1))
        continue
      fi
      enrollment_failed
    fi

    case "$http_code" in
      2??) break ;;
      *) enrollment_failed ;;
    esac
  done

  if ! validate_enrollment_json "$ENROLLMENT_RESPONSE_FILE"; then
    enrollment_failed
  fi
  if ! ENROLLED_CREDENTIAL="$(jq -er '.credential' "$ENROLLMENT_RESPONSE_FILE" 2>/dev/null)"; then
    enrollment_failed
  fi
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
    if [[ -e "$TEMP_ROOT" || -L "$TEMP_ROOT" ]]; then
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
trap cleanup EXIT

# Existing credentials must be safe and usable by the vendor service. This is
# local validation only: Gateway authentication still requires a real enrollment.
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

stage_gateway_update() {
  local temporary='' stage_status=0
  temporary="$(mktemp -- "${ALLOY_CONFIG_FILE%/*}/.opsgrid-agent-config.XXXXXX")" || return 1
  task4_track_temp "$temporary" || return 1
  chmod 600 -- "$temporary" || return 1
  # Change only the single endpoint URL in the installer-managed ingestion
  # component. Preserve all other config lines; reject ambiguous/custom layouts
  # rather than guessing which endpoint to rewrite. Input is the private snapshot.
  awk -v url="$GATEWAY_URL" '
    /^[[:space:]]*prometheus[.]remote_write[[:space:]]+"ingestion"[[:space:]]*[{][[:space:]]*$/ {
      blocks++; inside=1; depth=0
    }
    {
      if (inside) {
        if ($0 ~ /^[[:space:]]*endpoint[[:space:]]*[{][[:space:]]*$/) {
          endpoints++; endpoint_depth=depth+1
        }
        if (endpoint_depth && depth == endpoint_depth && $0 ~ /^[[:space:]]*url[[:space:]]*=/) {
          if ($0 !~ /^[[:space:]]*url[[:space:]]*=[[:space:]]*"[^"]*"[[:space:]]*(\/\/.*)?$/) exit 1
          current=$0; sub(/^[^"]*"/, "", current); sub(/".*$/, "", current)
          if (current != url) changed=1
          urls++; sub(/"[^"]*"/, "\"" url "\"")
        }
        braces=$0
        gsub(/"[^"]*"/, "", braces); sub(/\/\/.*/, "", braces)
        opens=gsub(/[{]/, "", braces); closes=gsub(/[}]/, "", braces)
        depth+=opens-closes
        if (endpoint_depth && depth < endpoint_depth) endpoint_depth=0
        if (depth == 0) inside=0
      }
      print
    }
    END {
      if (blocks != 1 || endpoints != 1 || urls != 1 || inside) exit 1
      if (!changed) exit 2
    }
  ' "$TASK4_SNAPSHOT_CONFIG_CONTENT" > "$temporary" || stage_status=$?
  if (( stage_status == 2 )); then
    # Preserve even final-newline differences when the URL already matches.
    cp -- "$TASK4_SNAPSHOT_CONFIG_CONTENT" "$temporary" || return 1
  elif (( stage_status != 0 )); then
    return 1
  fi
  TASK4_CONFIG_STAGE="$temporary"
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

main() {
  parse_args "$@"
  if ((SHOW_HELP)); then
    usage
    return 0
  fi

  validate_api_url
  validate_gateway_url
  enforce_root
  detect_platform
  require_commands
  acquire_lock
  get_os_metadata

  # Reruns reconcile the embedded Gateway without consuming another token or
  # invoking package installation. Re-enrollment is an explicit opt-in only.
  if (( ! RE_ENROLL )) && [[ -e "$AGENT_CREDENTIAL_FILE" || -L "$AGENT_CREDENTIAL_FILE" ]]; then
    if ! alloy_is_installed; then
      fail 'existing agent has no valid Alloy installation; refusing to reinstall' 20
    fi
    reconcile_gateway
    return 0
  fi
  read_enrollment_token

  if ! alloy_is_installed; then
    install_alloy_official
    if ! alloy_is_installed; then
      alloy_install_failed
    fi
  fi
  # Task 4 begins only after enrollment succeeds. Resolve every fixed path and
  # the real service identity before taking any persistent mutation.
  post_enrollment
  if ! resolve_script_paths; then
    fail 'config validation failed' 40
  fi
  if ! get_alloy_runtime_group; then
    fail 'service failed' 50
  fi
  if ! snapshot_state; then
    fail 'config validation failed' 40
  fi
  if ! write_credential_atomic; then
    fail 'config validation failed' 40
  fi
  if ! render_config_atomic; then
    fail 'config validation failed' 40
  fi
  if ! validate_alloy_config; then
    fail 'config validation failed' 40
  fi
  if ! apply_and_restart; then
    fail 'service failed' 50
  fi
  if ! wait_for_service; then
    fail 'service failed' 50
  fi
  # Clean staged Task 4 files while rollback is still available. A cleanup
  # failure remains a primary service failure and reaches EXIT rollback.
  if ! task4_cleanup_temps; then
    fail 'service failed' 50
  fi
  # Repository/package-manager artifacts become durable only after the new
  # credential, config, and healthy service have all crossed the commit point.
  # Keep Task 4 active until this succeeds so a commit failure still restores
  # the local credential/config/service state in EXIT cleanup.
  if ! repo_transaction_commit; then
    fail 'service failed' 50
  fi
  if ! task4_commit; then
    fail 'service failed' 50
  fi

  log 'Alloy installation/reuse, enrollment, configuration, and service activation completed.'
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
