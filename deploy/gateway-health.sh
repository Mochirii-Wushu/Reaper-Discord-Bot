#!/bin/sh
# Installed root-owned with the reviewed Compose file; never source runtime secrets.
set -eu
umask 077

fail() { printf '%s\n' "Gateway health: $1" >&2; exit 1; }
image=${REAPER_GATEWAY_IMAGE:-}
case "$image" in ''|*[!a-z0-9./:@_-]*) fail invalid_image ;; esac
printf '%s\n' "$image" | grep -Eq '^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$' || fail invalid_image
if [ "${1:-}" = '--validate-image' ] && [ "$#" -eq 1 ]; then exit 0; fi
[ "$#" -eq 0 ] || fail invalid_argument

container=mochirii-reaper-gateway
state_dir=${STATE_DIRECTORY:-/var/lib/mochirii-reaper-gateway-health}
case "$state_dir" in /*) ;; *) fail invalid_state_directory ;; esac
[ ! -L "$state_dir" ] || fail invalid_state_directory
mkdir -p "$state_dir" || fail state_unavailable
mkdir "$state_dir/lock" 2>/dev/null || fail check_already_running
trap 'rmdir "$state_dir/lock" 2>/dev/null || true' EXIT
trap 'exit 1' HUP INT TERM

# An operator stop always wins. The timer also stops with the lifecycle unit.
if ! systemctl is-active --quiet mochirii-reaper-gateway.service; then
  printf '%s\n' 'Gateway health: service_inactive'
  exit 0
fi

expected_id=$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null) || fail image_unavailable
printf '%s\n' "$expected_id" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail invalid_image_identity
format='{{.Id}}|{{.Name}}|{{.Config.Image}}|{{.Image}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'

inspect_owned() {
  snapshot=$(docker inspect --type container --format "$format" "$container" 2>/dev/null) || fail container_unavailable
  IFS='|' read -r container_id name configured_image actual_image project service status health extra <<EOF
$snapshot
EOF
  [ "$snapshot" = "$container_id|$name|$configured_image|$actual_image|$project|$service|$status|$health" ] || fail invalid_container_identity
  printf '%s\n' "$container_id" | grep -Eq '^[0-9a-f]{64}$' || fail invalid_container_identity
  [ "$name" = "/$container" ] && [ "$configured_image" = "$image" ] &&
    [ "$actual_image" = "$expected_id" ] && [ "$project" = "$container" ] &&
    [ "$service" = gateway ] || fail foreign_container
}

inspect_owned
case "$status" in
  exited|created|paused|restarting|removing|dead)
    printf '%s\n' 'Gateway health: container_not_running'
    exit 0 ;;
  running) ;;
  *) fail invalid_container_state ;;
esac
case "$health" in
  starting) printf '%s\n' 'Gateway health: starting'; exit 0 ;;
  healthy|unhealthy) ;;
  *) fail missing_healthcheck ;;
esac

if docker exec "$container_id" /nodejs/bin/node dist/healthcheck.js >/dev/null 2>&1; then
  printf '%s\n' 'Gateway health: ready'
  exit 0
fi

history=$state_dir/recovery-attempts
latch=$state_dir/recovery-latched
[ ! -L "$history" ] && [ ! -L "$latch" ] || fail invalid_recovery_state
[ ! -e "$latch" ] || fail recovery_latched
now=$(date +%s) || fail clock_unavailable
case "$now" in ''|*[!0-9]*) fail invalid_clock ;; esac
[ "${#now}" -le 10 ] && [ "$now" -gt 0 ] || fail invalid_clock
count=0
total=0
recent=''
if [ -e "$history" ]; then
  [ -f "$history" ] || fail invalid_recovery_state
  while IFS= read -r timestamp || [ -n "$timestamp" ]; do
    total=$((total + 1))
    [ "$total" -le 3 ] || fail invalid_recovery_state
    case "$timestamp" in ''|*[!0-9]*) fail invalid_recovery_state ;; esac
    [ "${#timestamp}" -le 10 ] && [ "$timestamp" -gt 0 ] && [ "$timestamp" -le "$now" ] || fail invalid_recovery_state
    if [ "$((now - timestamp))" -lt 900 ]; then
      count=$((count + 1))
      recent="$recent $timestamp"
    fi
  done < "$history"
fi
[ "$count" -lt 3 ] || { : > "$latch"; fail recovery_latched; }

# Recheck identity and operator state immediately before recovering the exact ID.
prior_id=$container_id
inspect_owned
[ "$container_id" = "$prior_id" ] || fail container_changed
if [ "$status" != running ] || ! systemctl is-active --quiet mochirii-reaper-gateway.service; then
  printf '%s\n' 'Gateway health: recovery_cancelled'
  exit 0
fi
temporary=$state_dir/recovery-attempts.$$
trap 'rm -f "$temporary"; rmdir "$state_dir/lock" 2>/dev/null || true' EXIT
[ ! -e "$temporary" ] && [ ! -L "$temporary" ] || fail invalid_recovery_state
: > "$temporary"
for timestamp in $recent; do printf '%s\n' "$timestamp" >> "$temporary"; done
printf '%s\n' "$now" >> "$temporary"
mv "$temporary" "$history" || fail state_unavailable
if [ "$count" -eq 2 ]; then : > "$latch"; fi
docker restart --time 20 "$container_id" >/dev/null 2>&1 || fail recovery_failed
printf '%s\n' 'Gateway health: recovery_requested'
