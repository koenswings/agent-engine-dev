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
  echo "--> Setting hostname and META.yaml via build-engine.ts --personalize" >> /home/pi/boot.out
  (cd /home/pi/idea/agents/agent-engine-dev && PATH=/usr/local/bin:$PATH ./node_modules/.bin/tsx script/build-engine.ts --personalize) >> /home/pi/boot.out 2>&1

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

# Restart Avahi to pick up any hostname changes
echo "Restarting Avahi daemon" >> /home/pi/boot.out
sudo systemctl restart avahi-daemon >> /home/pi/boot.out 2>&1

echo "DONE" >> /home/pi/boot.out
