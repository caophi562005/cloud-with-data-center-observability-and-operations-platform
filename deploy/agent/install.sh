#!/usr/bin/env bash
set -Eeuo pipefail
# Enrollment tokens must never appear in caller-enabled xtrace output.
set +x
umask 077
PATH='/usr/sbin:/usr/bin:/sbin:/bin'
export PATH

# Resolve the canonical entrypoint directory, including bare install.sh calls.
OPSGRID_INSTALLER_SOURCE="${BASH_SOURCE[0]}"
case "$OPSGRID_INSTALLER_SOURCE" in
  */*) OPSGRID_INSTALLER_DIRECTORY="${OPSGRID_INSTALLER_SOURCE%/*}" ;;
  *) OPSGRID_INSTALLER_DIRECTORY='.' ;;
esac
# An absolute entrypoint directly under / has an empty ${path%/*} dirname.
[[ -n "$OPSGRID_INSTALLER_DIRECTORY" ]] || OPSGRID_INSTALLER_DIRECTORY='/'
if ! OPSGRID_INSTALLER_ROOT="$(cd -- "$OPSGRID_INSTALLER_DIRECTORY" 2>/dev/null && pwd -P)"; then
  printf '[opsgrid-agent] Error: installer directory unavailable\n' >&2
  return 10 2>/dev/null || exit 10
fi
unset OPSGRID_INSTALLER_SOURCE OPSGRID_INSTALLER_DIRECTORY

# OPSGRID_BUNDLE_BEGIN
source "${OPSGRID_INSTALLER_ROOT}/lib/linux/runtime.sh"
source "${OPSGRID_INSTALLER_ROOT}/lib/linux/preflight.sh"
source "${OPSGRID_INSTALLER_ROOT}/lib/linux/filesystem.sh"
source "${OPSGRID_INSTALLER_ROOT}/lib/linux/repositories.sh"
source "${OPSGRID_INSTALLER_ROOT}/lib/linux/alloy.sh"
source "${OPSGRID_INSTALLER_ROOT}/lib/linux/enrollment.sh"
source "${OPSGRID_INSTALLER_ROOT}/lib/linux/configuration.sh"
source "${OPSGRID_INSTALLER_ROOT}/lib/linux/transaction.sh"
source "${OPSGRID_INSTALLER_ROOT}/lib/linux/reconciliation.sh"
# OPSGRID_BUNDLE_END

trap cleanup EXIT

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
    if [[ -n "$APPLY_PROFILE" ]]; then
      reconcile_profile
    else
      reconcile_gateway
    fi
    return 0
  fi
  if [[ -n "$APPLY_PROFILE" ]]; then
    fail 'profile update requires an existing enrolled agent' 40
  fi
  read_enrollment_token

  if ! alloy_is_installed; then
    install_alloy_official
    if ! alloy_is_installed; then
      alloy_install_failed
    fi
  fi
  # Prove every deterministic local prerequisite before consuming a single-use
  # token. Snapshot and stage under the transaction, without changing live files
  # or restarting Alloy. Enrollment failure discards the stage via EXIT rollback.
  if ! resolve_script_paths; then
    fail 'config validation failed' 40
  fi
  if ! get_alloy_runtime_group; then
    fail 'service failed' 50
  fi
  if ! snapshot_state || ! validate_credential_target; then
    fail 'config validation failed' 40
  fi
  if ! render_config_atomic || ! validate_alloy_config; then
    fail 'config validation failed' 40
  fi
  post_enrollment
  if ! write_credential_atomic; then
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
