#!/bin/bash
#
# setup-dev.sh — One-time dev environment setup for native Pi development.
#
# This is a thin wrapper. All setup that a dev Pi needs is the same as what
# a production Pi needs — so this just runs install.sh.
#
# Run once on any Pi used for development or testing.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sudo bash "$SCRIPT_DIR/install.sh"
