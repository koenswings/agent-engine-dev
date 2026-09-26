#!/bin/bash
#
# Bootstrap installer for the Engine software
#

set -e # Exit immediately if a command exits with a non-zero status.

echo "--- Starting Engine Bootstrap Installation ---"

# 1. Install base system dependencies and Node.js tools
echo "--> Installing git, curl, and Node.js environment..."
apt-get update -y
apt-get install -y npm git curl borgbackup
npm install -g n pnpm
echo "--> Setting Node.js version for script execution..."
n 20

# 2. Get the main application code
echo "--> Cloning repository..."
# Clean up previous attempts if they exist
rm -rf /tmp/engine-install
git clone https://github.com/koenswings/engine.git /tmp/engine-install
cd /tmp/engine-install

# 3. Install project-specific dependencies (including zx)
echo "--> Installing project dependencies..."
pnpm install --no-frozen-lockfile

# 4. Configure /dev/engine ownership
# /dev/engine is created by udev for disk sentinel detection. The Engine runs
# as 'pi', so pi must own the directory — on every Pi, dev and production alike.
echo "--> Configuring /dev/engine ownership ..."
tee /etc/tmpfiles.d/idea-engine.conf > /dev/null << 'EOF'
# /dev/engine is created by udev for the IDEA Engine disk detection mechanism.
# The Engine runs as pi, so pi owns this directory on all Pis.
d /dev/engine 0775 pi pi -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/idea-engine.conf

# 5. Run the main provisioning script in Local Mode
echo "--> Executing main build script in Local Mode..."
# Execute the main build script using its new wrapper
./build-engine

echo "--- Bootstrap Installation Complete ---"
