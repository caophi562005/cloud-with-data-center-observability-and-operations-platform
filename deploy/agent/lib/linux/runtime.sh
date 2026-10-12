# [opsgrid-agent] Linux runtime definitions; loaded by install.sh.
# Loading this module does not install, enroll, or change service state.

API_BASE_URL_DEFAULT='https://api.opsgrid.hacmieu.com'
GATEWAY_URL_DEFAULT='https://ingest.opsgrid.hacmieu.com/api/v1/write'
OUTPUT_PREFIX='[opsgrid-agent]'
API_BASE_URL="$API_BASE_URL_DEFAULT"
GATEWAY_URL="$GATEWAY_URL_DEFAULT"
RE_ENROLL=0
APPLY_PROFILE=''
GATEWAY_URL_EXPLICIT=0
SHOW_HELP=0

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
  printf '%s   --apply-profile PROFILE   Upgrade managed config to linux-baseline-v1; preserve credential\n' "$OUTPUT_PREFIX"
  printf '%s Existing agents reconcile only the Gateway URL unless a profile update is requested.\n' "$OUTPUT_PREFIX"
  printf '%s   --help                    Show this help text\n' "$OUTPUT_PREFIX"
}

parse_args() {
  API_BASE_URL="$API_BASE_URL_DEFAULT"
  GATEWAY_URL="$GATEWAY_URL_DEFAULT"
  RE_ENROLL=0
  APPLY_PROFILE=''
  GATEWAY_URL_EXPLICIT=0
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
        GATEWAY_URL_EXPLICIT=1
        shift 2
        ;;
      --apply-profile)
        if (($# < 2)) || [[ -z "$2" || "$2" == --* ]]; then
          fail '--apply-profile requires a value'
        fi
        APPLY_PROFILE="$2"
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
  if [[ -n "$APPLY_PROFILE" ]]; then
    [[ "$APPLY_PROFILE" == linux-baseline-v1 ]] || fail 'unsupported Linux metrics profile'
    (( ! RE_ENROLL )) || fail 'profile updates cannot be combined with re-enrollment'
  fi
}
