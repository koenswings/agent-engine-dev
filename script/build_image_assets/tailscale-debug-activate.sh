#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# tailscale-debug-activate.sh — Activate Tailscale debug mode on a school Pi
#
# USAGE (run via SSH from Tapiwa's laptop):
#   ssh pi@engine-1.local
#   sudo /usr/local/bin/tailscale-debug-activate.sh
#
# WHAT THIS DOES:
#   1. Verifies internet connectivity (wlan0 should be connected to Starlink)
#   2. Starts tailscaled
#   3. Joins the IDEA Tailnet (ephemeral — Pi is removed automatically on disconnect)
#   4. Prints the Tailscale IP for Tapiwa to relay to IDEA staff
#   5. Waits for Enter (Tapiwa presses it when the session is done)
#   6. Runs tailscale down, stops tailscaled — Pi is isolated again
#
# NOTE: wlan0 stays connected to Starlink after this script exits.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

AUTH_KEY_FILE="/etc/tailscale/debug-authkey"

info() { echo -e "\033[1;34m[debug]\033[0m $*"; }
ok()   { echo -e "\033[1;32m[debug]\033[0m $*"; }
die()  { echo -e "\033[1;31m[debug]\033[0m $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Must run as root (use sudo)"
[[ -f "$AUTH_KEY_FILE" ]] || die "Auth key not found at $AUTH_KEY_FILE — run install.sh first"

info "Starting Tailscale debug session at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
info "Hostname: $(hostname)"

# ── Check internet connectivity ───────────────────────────────────────────────

info "Checking internet connectivity..."
if ! curl -sf --max-time 10 https://api.ipify.org > /dev/null; then
  echo ""
  echo "  No internet detected. Is Tapiwa's Starlink in range?"
  echo ""
  echo "  Check WiFi status:  nmcli device status"
  echo "  Check wlan0:        ip addr show wlan0"
  echo ""
  echo "  If Starlink is nearby but not connected:"
  echo "    nmcli device wifi connect <SSID> password <PASSWORD> ifname wlan0"
  echo ""
  die "Cannot activate Tailscale without internet. Aborting."
fi
ok "Internet available via $(ip route get 1.1.1.1 | awk '{print $5; exit}' 2>/dev/null || echo 'unknown interface')"

# ── Start Tailscale ───────────────────────────────────────────────────────────

info "Starting tailscaled..."
systemctl start tailscaled
sleep 2

info "Joining IDEA Tailnet (ephemeral)..."
tailscale up \
  --authkey "$(cat "$AUTH_KEY_FILE")" \
  --ephemeral \
  --advertise-tags=tag:school-pi \
  --hostname="$(hostname)"

TAILSCALE_IP=$(tailscale ip -4 2>/dev/null || echo "<not yet assigned>")

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  TAILSCALE IP:  $TAILSCALE_IP"
echo ""
echo "  Relay this IP to IDEA staff via phone or WhatsApp."
echo "  They will SSH in at:  ssh pi@$TAILSCALE_IP"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Session is ACTIVE. Stay in this terminal."
echo "  Press Enter when IDEA staff have finished."
echo ""
read -r

# ── Close session ─────────────────────────────────────────────────────────────

info "Closing session..."
tailscale down
systemctl stop tailscaled

echo ""
ok "Session closed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
ok "Pi is isolated again. Tailscale service is stopped."
ok "wlan0 remains connected to Starlink — it will auto-disconnect when Starlink leaves."
echo ""
