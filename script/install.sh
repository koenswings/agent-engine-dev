#!/bin/bash
#
# install.sh — thin wrapper around build-engine (idea#322: one install path).
#
# Run as pi from a checkout of a tagged Engine release (engine-vYYYY.MM.DD[-N]):
#   git clone https://github.com/koenswings/agent-engine-dev && cd agent-engine-dev
#   git checkout engine-vYYYY.MM.DD && bash script/install.sh [build-engine options]
# It installs the committed lockfile's packages (needs node + pnpm on PATH) and
# hands every argument to ./build-engine (local mode). Everything else — apt
# snapshot, pinned Node/pnpm/pm2/Tailscale, udev, sudoers, root helpers, the
# deployment record — is done by build-engine only.
set -euo pipefail
[ "$(id -u)" -eq 0 ] && { echo "run as pi, not root (build-engine uses sudo itself)" >&2; exit 1; }
cd "$(dirname "$0")/.."
[ -x node_modules/.bin/tsx ] || pnpm install --frozen-lockfile
exec ./build-engine "$@"
