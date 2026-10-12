# [opsgrid-agent] Linux enrollment definitions; loaded by install.sh.
# Loading this module does not install, enroll, or change service state.

ENROLLMENT_TOKEN=''
ENROLLMENT_REQUEST_FILE=''
ENROLLMENT_RESPONSE_FILE=''
ENROLLMENT_STATUS_FILE=''
ENROLLED_CREDENTIAL=''

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

  # Enrollment consumes a single-use token. A lost response, timeout or server
  # error cannot prove the POST was not committed; never automatically replay it.
  # Ignore caller curlrc settings so they cannot enable retries or redirect POSTs.
  if ! curl --disable --request POST --header 'Content-Type: application/json' \
    --connect-timeout 10 --max-time 30 --silent \
    --data-binary "@$ENROLLMENT_REQUEST_FILE" \
    --output "$ENROLLMENT_RESPONSE_FILE" --write-out '%{http_code}' \
    "$API_BASE_URL/api/v1/agent-enrollment" > "$ENROLLMENT_STATUS_FILE" 2>/dev/null; then
    enrollment_failed
  fi
  http_code="$(<"$ENROLLMENT_STATUS_FILE")"
  case "$http_code" in
    2[0-9][0-9]) ;;
    *) enrollment_failed ;;
  esac

  if ! validate_enrollment_json "$ENROLLMENT_RESPONSE_FILE"; then
    enrollment_failed
  fi
  if ! ENROLLED_CREDENTIAL="$(jq -er '.credential' "$ENROLLMENT_RESPONSE_FILE" 2>/dev/null)"; then
    enrollment_failed
  fi
}
