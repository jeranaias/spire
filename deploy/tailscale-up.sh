#!/bin/sh
# Bring up Tailscale in userspace mode and expose it as a SOCKS5 + HTTP proxy
# on 127.0.0.1 so the SPIRE backend can reach the rig over the tailnet without
# ever requiring NET_ADMIN / TUN / privileged in the Fly machine.
#
# Behavior:
#   - If $TS_AUTHKEY is unset (no rig wired yet), exit 0 cleanly and let the
#     rest of the stack come up. Backend will see SPIRE_LLM_PROXY unreachable
#     and fall back to rule-based mode (same as before this commit).
#   - If $TS_AUTHKEY is set, start tailscaled, then `tailscale up` against the
#     tailnet, tagged tag:fly. Wait until it's online so the backend's first
#     LLM call doesn't race the tunnel.
set -eu

if [ -z "${TS_AUTHKEY:-}" ]; then
  echo "[tailscale] TS_AUTHKEY unset — skipping; LLM-backed features will fall back to rule-based"
  exit 0
fi

mkdir -p /var/run/tailscale

# Persist Tailscale state on the spire_runtime volume so the node identity
# survives auto-stop/wake cycles. Without this, the ephemeral node has to
# re-auth from scratch on every wake, and the prior session is already gone
# from the coordination server, leaving the machine "Logged out" until the
# tailscale-up runs again. With persistent state, the prior identity is
# reused across restarts and the tunnel comes up immediately.
TS_STATEDIR=/opt/spire/runtime/tailscale
mkdir -p "$TS_STATEDIR"
chmod 700 "$TS_STATEDIR"

# Userspace mode: no TUN, no NET_ADMIN. SOCKS5 proxy bound at 127.0.0.1:1055,
# HTTP proxy at 127.0.0.1:1099. The backend reads SPIRE_LLM_PROXY which we
# point at the tailnet hostname; libcurl/httpx will use the HTTP proxy via the
# ALL_PROXY env var if set.
/usr/sbin/tailscaled \
    --tun=userspace-networking \
    --socks5-server=127.0.0.1:1055 \
    --outbound-http-proxy-listen=127.0.0.1:1099 \
    --statedir="$TS_STATEDIR" \
    >/var/log/tailscaled.log 2>&1 &
TSD_PID=$!

# Give the daemon a moment to bind its socket.
i=0
while [ $i -lt 30 ]; do
  if /usr/bin/tailscale status --json >/dev/null 2>&1; then break; fi
  sleep 1; i=$((i+1))
done

HOSTNAME_FLAG="--hostname=${TS_HOSTNAME:-spire-mdm}"
TAGS_FLAG="--advertise-tags=${TS_TAGS:-tag:fly}"

# Idempotent: if persisted state already authed, this re-syncs without a fresh
# auth round-trip. No --reset so we keep prior identity across wakes.
# If the auth-key changes externally, delete /opt/spire/runtime/tailscale and
# the next boot starts clean.
/usr/bin/tailscale up \
    --authkey="$TS_AUTHKEY" \
    --ssh=false \
    --accept-dns=true \
    --accept-routes=false \
    "$HOSTNAME_FLAG" \
    "$TAGS_FLAG"

echo "[tailscale] online: $(/usr/bin/tailscale ip -4 2>/dev/null || echo '?')"
echo "[tailscale] peers:"
/usr/bin/tailscale status 2>/dev/null | head -10 || true

# Hand off to supervisord (which will keep monitoring tailscaled too).
wait $TSD_PID
