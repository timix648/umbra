#!/usr/bin/env bash
# Umbra watchdog: every 2 minutes (cron). Logs every change of state and, when
# /opt/umbra/alert.env sets ALERT_WEBHOOK_URL (a Slack-style incoming webhook),
# posts it there too. Only CHANGES are reported, so a long outage is one alert
# going down and one coming back.
STATE=/opt/umbra/watchdog.state
LOG=/var/log/umbra-watchdog.log
[ -f /opt/umbra/alert.env ] && . /opt/umbra/alert.env

problems=()
st=$(curl -s -m 8 -o /tmp/umbra-status.json -w "%{http_code}" http://127.0.0.1:4002/api/status)
if [ "$st" != "200" ]; then
  problems+=("app status $st: $(head -c 300 /tmp/umbra-status.json 2>/dev/null)")
fi
for c in splice-validator-participant-1 splice-validator-validator-1 decman-devnet decman-keycloak; do
  s=$(docker inspect -f '{{.State.Status}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null)
  case "$s" in running|running/healthy) ;; *) problems+=("$c: ${s:-missing}") ;; esac
done
s=$(systemctl is-active umbra-signer 2>/dev/null)
[ "$s" = "active" ] || problems+=("venue signer: ${s:-missing}")
# while the signer is in audit mode: anything it WOULD have refused
aud=$(grep -c -E "AUDIT \(would refuse\)|REFUSED" /var/log/umbra-signer.log 2>/dev/null)
[ "${aud:-0}" -gt 0 ] && problems+=("venue signer flagged ${aud} request(s) outside its policy - see /var/log/umbra-signer.log")
disk=$(df --output=pcent / | tail -1 | tr -dc 0-9)
[ "${disk:-0}" -ge 90 ] && problems+=("disk ${disk}% full")
avail=$(free -m | awk '/Mem:/{print $7}')
[ "${avail:-99999}" -lt 1500 ] && problems+=("only ${avail}MB memory available")

if [ ${#problems[@]} -eq 0 ]; then now="OK"; msg="Umbra is healthy again"; else now="FAIL"; msg="Umbra problem: $(IFS='; '; echo "${problems[*]}")"; fi
was=$(cat "$STATE" 2>/dev/null)
sig="$now|${problems[*]}"
if [ "$sig" != "$was" ]; then
  echo "$(date -u +%FT%TZ) $now ${problems[*]}" >> "$LOG"
  echo "$sig" > "$STATE"
  if [ -n "$ALERT_WEBHOOK_URL" ]; then
    curl -s -m 10 -X POST -H "Content-Type: application/json" \
      --data "$(python3 -c 'import json,sys;print(json.dumps({"text":sys.argv[1]}))' "$msg")" "$ALERT_WEBHOOK_URL" >/dev/null
  fi
fi
