# [opsgrid-agent] Linux configuration definitions; loaded by install.sh.
# Loading this module does not install, enroll, or change service state.

CREDENTIAL_FILE_PLACEHOLDER='__CREDENTIAL_FILE__'
GATEWAY_URL_PLACEHOLDER='__GATEWAY_URL__'
SCRIPT_DIR=''
LINUX_TEMPLATE_FILE=''
AGENT_CREDENTIAL_FILE='/etc/opsgrid-agent/agent.credential'
ALLOY_CONFIG_FILE='/etc/alloy/config.alloy'

resolve_script_paths() {
  # Always resolve assets from the entrypoint, never this library's BASH_SOURCE.
  if [[ -z "$OPSGRID_INSTALLER_ROOT" || ! -d "$OPSGRID_INSTALLER_ROOT" ]]; then
    return 1
  fi
  SCRIPT_DIR="$OPSGRID_INSTALLER_ROOT"
  LINUX_TEMPLATE_FILE="$SCRIPT_DIR/alloy/linux.config.alloy.template"
}

validate_credential_target() {
  local directory="${AGENT_CREDENTIAL_FILE%/*}"
  local metadata='' expected_gid=''
  if [[ -L "$AGENT_CREDENTIAL_FILE" || ( -e "$AGENT_CREDENTIAL_FILE" && ! -f "$AGENT_CREDENTIAL_FILE" ) || -L "$directory" ]]; then
    return 1
  fi
  if ! secure_artifact_directory "${directory%/*}"; then
    return 1
  fi
  if [[ ! -e "$directory" ]]; then return 0; fi
  if secure_artifact_directory "$directory"; then return 0; fi
  # Permit only the service-readable, non-writable credential vendor layout.
  if [[ ! -d "$directory" || "$(realpath -e -- "$directory")" != "$directory" ]] || (( ALLOY_RUNTIME_ROOT )); then
    return 1
  fi
  expected_gid="$(getent group "$ALLOY_RUNTIME_GROUP" | cut -d: -f3)" || return 1
  [[ -n "$expected_gid" ]] || return 1
  metadata="$(stat -c '%u:%g:%a' -- "$directory")" || return 1
  [[ "$metadata" == "0:$expected_gid:750" ]]
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
  if [[ ( -n "$ENROLLED_CREDENTIAL" && "$rendered" == *"$ENROLLED_CREDENTIAL"* ) || "$rendered" == *'AGT_'* ]]; then
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

# Compare the complete managed config, not a spoofable profile comment. Strip
# only whitespace and // comments outside strings; retain every other token.

canonical_alloy_config() {
  awk '
    {
      for (i=1; i<=length($0); i++) {
        c=substr($0,i,1)
        if (quoted) {
          printf "%s", c
          if (escaped) escaped=0
          else if (c == "\\") escaped=1
          else if (c == "\"") quoted=0
        } else {
          if (c == "/" && substr($0,i+1,1) == "/") break
          if (c == "\"") quoted=1
          if (c !~ /[[:space:]]/) printf "%s", c
        }
      }
      if (quoted) { bad=1; exit 1 }
    }
    END { if (bad) exit 1; printf "\n" }
  ' "$@"
}

# The only unversioned config eligible for migration is our original 15s Linux
# template. Any changed collector, extra endpoint/component or custom pipeline
# fails closed instead of being silently replaced.

legacy_managed_config() {
  local existing_gateway="$1"
  cat <<EOF
local.file "agent_credential" {
  filename = "$AGENT_CREDENTIAL_FILE"
  is_secret = true
}
prometheus.exporter.unix "host" {
}
prometheus.scrape "host" {
  targets = prometheus.exporter.unix.host.targets
  forward_to = [prometheus.remote_write.ingestion.receiver]
  scrape_interval = "15s"
}
prometheus.remote_write "ingestion" {
  endpoint {
    url = "$existing_gateway"
    authorization {
      type = "Bearer"
      credentials = local.file.agent_credential.content
    }
  }
}
EOF
}

stage_profile_update() {
  local existing_gateway='' requested_gateway="$GATEWAY_URL"
  local current='' legacy='' baseline='' desired=''
  # Require valid source syntax before whitespace normalization: malformed
  # unquoted tokens must not become equivalent to a managed config.
  "$ALLOY_BINARY_PATH" validate "$TASK4_SNAPSHOT_CONFIG_CONTENT" >/dev/null 2>&1 || return 1
  # URL extraction is only a candidate; full-config equality below establishes
  # ownership and excludes duplicate/custom endpoints and inline credentials.
  existing_gateway="$(awk '
    /^[[:space:]]*url[[:space:]]*=/ {
      if ($0 !~ /^[[:space:]]*url[[:space:]]*=[[:space:]]*"[^"]*"[[:space:]]*(\/\/.*)?$/) { bad=1; exit 1 }
      count++; value=$0; sub(/^[^"]*"/, "", value); sub(/".*$/, "", value)
    }
    END { if (bad || count != 1) exit 1; print value }
  ' "$TASK4_SNAPSHOT_CONFIG_CONTENT")" || return 1
  GATEWAY_URL="$existing_gateway"
  validate_gateway_url
  # Preserve the original spelling too unless an endpoint override was supplied.
  GATEWAY_URL="$existing_gateway"
  current="$(canonical_alloy_config "$TASK4_SNAPSHOT_CONFIG_CONTENT")" || return 1
  legacy="$(legacy_managed_config "$existing_gateway" | canonical_alloy_config)" || return 1
  render_config_atomic || return 1
  baseline="$(canonical_alloy_config "$TASK4_CONFIG_STAGE")" || return 1
  [[ "$current" == "$legacy" || "$current" == "$baseline" ]] || return 1
  if (( GATEWAY_URL_EXPLICIT )); then
    GATEWAY_URL="$requested_gateway"
    render_config_atomic || return 1
  fi
  desired="$(canonical_alloy_config "$TASK4_CONFIG_STAGE")" || return 1
  if [[ "$current" == "$desired" ]]; then
    # Preserve comments, spacing, final newline and inode on an active no-op.
    cp -- "$TASK4_SNAPSHOT_CONFIG_CONTENT" "$TASK4_CONFIG_STAGE" || return 1
  fi
}
