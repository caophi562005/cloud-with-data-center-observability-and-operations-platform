#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

OUTPUT_PREFIX='[opsgrid-agent]'
RELEASE_BASE_URL='https://github.com/caophi562005/cloud-with-data-center-observability-and-operations-platform/releases/latest/download'
TOKEN=''
TEMP_ROOT=''

log() {
  printf '%s %s\n' "$OUTPUT_PREFIX" "$*"
}

usage() {
  printf '%s Usage: install-launcher.sh --token TOKEN\n' "$OUTPUT_PREFIX"
  printf '%s   --token TOKEN  Enrollment token input (not echoed)\n' "$OUTPUT_PREFIX"
  printf '%s   --help         Show this help text\n' "$OUTPUT_PREFIX"
}

fail_usage() {
  log 'invalid launcher arguments' >&2
  exit 10
}

parse_args() {
  local argument=''
  while (($# > 0)); do
    argument="$1"
    case "$argument" in
      --token)
        if (($# < 2)); then
          fail_usage
        fi
        TOKEN="$2"
        shift 2
        ;;
      --token=*)
        TOKEN="${argument#--token=}"
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        fail_usage
        ;;
    esac
  done

  if [[ -z "$TOKEN" ]]; then
    log 'enrollment token is required; pass --token TOKEN' >&2
    exit 10
  fi
}

cleanup() {
  local exit_code=$?
  local cleanup_failed=0
  trap - EXIT

  if [[ -n "${TEMP_ROOT:-}" && "$TEMP_ROOT" != '/' && -d "$TEMP_ROOT" ]]; then
    if ! rm -rf -- "$TEMP_ROOT"; then
      cleanup_failed=1
    fi
  fi

  if ((cleanup_failed)); then
    log 'launcher temporary cleanup failed' >&2
    if ((exit_code == 0)); then
      exit_code=50
    fi
  fi
  exit "$exit_code"
}

require_commands() {
  local command_name=''
  for command_name in curl mktemp chmod mkdir rm mv head grep; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
      log 'required launcher command is unavailable' >&2
      exit 10
    fi
  done
}

download_asset() {
  local asset_name="$1"
  local destination="$2"
  local temporary="${destination}.tmp"
  local error_file="${TEMP_ROOT}/download.error"

  rm -f -- "$temporary" "$error_file"
  if ! curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
      --output "$temporary" "$RELEASE_BASE_URL/$asset_name" 2>"$error_file"; then
    rm -f -- "$temporary" "$error_file"
    log 'release asset download failed' >&2
    return 1
  fi
  rm -f -- "$error_file"
  if [[ ! -s "$temporary" ]]; then
    rm -f -- "$temporary"
    log 'release asset was empty' >&2
    return 1
  fi
  if ! mv -- "$temporary" "$destination"; then
    rm -f -- "$temporary"
    log 'release asset preparation failed' >&2
    return 1
  fi
  return 0
}

validate_assets() {
  local installer="$TEMP_ROOT/install.sh"
  local template="$TEMP_ROOT/alloy/linux.config.alloy.template"

  if [[ "$(head -n 1 "$installer")" != '#!'* ]]; then
    log 'downloaded Linux installer is invalid' >&2
    return 1
  fi
  if ! grep -Fq -- '__CREDENTIAL_FILE__' "$template"; then
    log 'downloaded Linux Alloy template is invalid' >&2
    return 1
  fi
  return 0
}

main() {
  parse_args "$@"
  require_commands

  if ! TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/opsgrid-agent-launcher.XXXXXX")"; then
    log 'launcher temporary directory creation failed' >&2
    exit 20
  fi
  if ! chmod 700 "$TEMP_ROOT" || ! mkdir -m 700 "$TEMP_ROOT/alloy"; then
    log 'launcher temporary directory preparation failed' >&2
    exit 20
  fi

  if ! download_asset 'install.sh' "$TEMP_ROOT/install.sh" \
      || ! download_asset 'linux.config.alloy.template' "$TEMP_ROOT/alloy/linux.config.alloy.template"; then
    exit 20
  fi
  if ! chmod 700 "$TEMP_ROOT/install.sh"; then
    log 'downloaded Linux installer preparation failed' >&2
    exit 20
  fi
  if ! validate_assets; then
    exit 20
  fi

  local installer_exit=0
  bash "$TEMP_ROOT/install.sh" --enrollment-token "$TOKEN" || installer_exit=$?
  TOKEN=''
  if ((installer_exit != 0)); then
    return "$installer_exit"
  fi
  return 0
}

trap cleanup EXIT
main "$@"
