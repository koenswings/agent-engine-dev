#!/bin/bash
# /usr/local/bin/boot.sh

echo "Starting boot.sh" > /home/pi/boot.out

FLAG="/boot/MASTER"
if [[ -f $FLAG ]]; then
  echo "*********************************" >> /home/pi/boot.out
  echo "Performing First-Boot Personalization" >> /home/pi/boot.out
  echo "*********************************" >> /home/pi/boot.out

  # 1. Regenerate machine-id
  echo "--> Regenerating machine-id" >> /home/pi/boot.out
  rm -f /etc/machine-id
  systemd-machine-id-setup
  
  # 2. Regenerate SSH host keys
  echo "--> Regenerating SSH host keys" >> /home/pi/boot.out
  rm -f /etc/ssh/ssh_host_*
  dpkg-reconfigure -f noninteractive openssh-server >> /home/pi/boot.out 2>&1

  # 3. Set hostname and META.yaml via build-engine.ts --personalize.
  #    Same invocation as the ./build-engine wrapper: run from the engine dir
  #    (config.yaml is read relative to cwd) with the project's tsx (resolves
  #    the .js imports to .ts sources). /usr/local/bin holds the node from `n`.
  #    Runs as pi (sudo -u pi), not root, so it leaves no root-owned files in the
  #    Engine tree (idea#80). The root steps inside it use sudo themselves.
  echo "--> Setting hostname and META.yaml via build-engine.ts --personalize" >> /home/pi/boot.out
  (cd /home/pi/idea/agents/agent-engine-dev && sudo -u pi -H env PATH=/usr/local/bin:$PATH ./node_modules/.bin/tsx script/build-engine.ts --personalize) >> /home/pi/boot.out 2>&1

  # 4. Preventing from running again
  echo "--> Personalization complete. Removing flag file." >> /home/pi/boot.out
  rm -f "$FLAG"

  # 5. Reboot to apply all changes
  echo "--> Rebooting to apply changes." >> /home/pi/boot.out
  reboot
fi

# This part runs on every boot
echo "******************************" >> /home/pi/boot.out
echo "Growing and resizing partition" >> /home/pi/boot.out
echo "******************************" >> /home/pi/boot.out
# Try to expand the partition and filesystem. Errors are ignored if it's already expanded.
sudo growpart /dev/sda 2 >> /home/pi/boot.out 2>&1 || true
sudo resize2fs /dev/sda2 >> /home/pi/boot.out 2>&1 || true

# Self-repair of USB disk detection (idea#82). The Engine watches /dev/engine,
# whose links are created by the udev rule 90-docking.rules. tmpfiles.d always
# creates /dev/engine, so without the rule docking silently does nothing.
# Reinstall the rule when it is missing or differs from the shipped asset, then
# reload udev and re-trigger it so disks that are already plugged in appear.
# The Engine's startup self-check reports anything this could not fix.
# (installCrontabs rewrites the engine path below to config.defaults.enginePath.)
# --- ensure_docking_rule: begin (extracted and run by test/automated/disk-detection.test.ts)
DOCKING_RULE_SRC="${DOCKING_RULE_SRC:-/home/pi/idea/agents/agent-engine-dev/script/build_image_assets/90-docking.rules}"
DOCKING_RULE_DST="${DOCKING_RULE_DST:-/etc/udev/rules.d/90-docking.rules}"
ensure_docking_rule() {
  if [[ ! -f "$DOCKING_RULE_SRC" ]]; then
    echo "udev rule asset $DOCKING_RULE_SRC not found; cannot check $DOCKING_RULE_DST"
    return 1
  fi
  if cmp -s "$DOCKING_RULE_SRC" "$DOCKING_RULE_DST"; then
    echo "udev rule $DOCKING_RULE_DST is in place"
    return 0
  fi
  echo "udev rule $DOCKING_RULE_DST is missing or differs; reinstalling it"
  if ! { mkdir -p "$(dirname "$DOCKING_RULE_DST")" && install -m 0644 "$DOCKING_RULE_SRC" "$DOCKING_RULE_DST"; }; then
    echo "could not write $DOCKING_RULE_DST"
    return 1
  fi
  udevadm control --reload && udevadm trigger
}
# --- ensure_docking_rule: end
echo "Checking the USB docking udev rule" >> /home/pi/boot.out
ensure_docking_rule >> /home/pi/boot.out 2>&1 || echo "udev rule self-repair failed" >> /home/pi/boot.out

# Restart Avahi to pick up any hostname changes
echo "Restarting Avahi daemon" >> /home/pi/boot.out
sudo systemctl restart avahi-daemon >> /home/pi/boot.out 2>&1

echo "DONE" >> /home/pi/boot.out
