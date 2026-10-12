# [opsgrid-agent] Linux preflight definitions; loaded by install.sh.
# Loading this module does not install, enroll, or change service state.

DISTRO_ID=''
DISTRO_ID_LIKE=''
DISTRO_VERSION=''
OS_PRETTY_NAME=''
OS_METADATA=''
PLATFORM_ARCH=''
PACKAGE_MANAGER=''

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

get_os_metadata() {
  local cleaned=''

  if [[ -n "$OS_PRETTY_NAME" ]]; then
    cleaned="$(printf '%s' "$OS_PRETTY_NAME" | sed -e 's/[[:cntrl:]]//g' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' || true)"
    OS_METADATA="${cleaned:0:128}"
  else
    OS_METADATA=''
  fi
}
