# -----------------------------------------------------------------------------
# base
# Use this target in compose-dev.yaml to run the repo using Docker Dev Environments
# ------------------------------------------------------------------------------

FROM ubuntu:focal-20240123@sha256:bb1c41682308d7040f74d103022816d41c50d7b0c89e9d706a74b4e548636e54 as base
RUN apt-get update --fix-missing

# Add ssh
# RUN apt-get install -y openssh-server && systemctl ssh start && systemctl ssh enable   
#A1 RUN apt-get install -y openssh-server && service ssh start 
RUN apt-get install -y openssh-server openssh-client && service ssh start 

# Install rsync
RUN apt install rsync -y

# Install Docker for DIND
#RUN apt-get install -y curl && curl -sSL https://get.docker.com/ > install-docker.sh && chmod +x ./install-docker.sh && ./install-docker.sh --version 24.0.7 # Same version as Docker Desktop 4.26.1 (131620)
#RUN apt-get install -y curl && curl -sSL https://get.docker.com/ > install-docker.sh && chmod +x ./install-docker.sh && ./install-docker.sh                  # Latest version
RUN apt-get install -y curl && curl -sSL https://get.docker.com/ > install-docker.sh && chmod +x ./install-docker.sh && ./install-docker.sh --version 25.0.3  # Freeze version to improve build consistency

# Install npm, pnpm and node
RUN apt-get install -y npm && npm install -g -y n pnpm && n 19.6.0

# Install libusb for node-usb
# RUN apt-get install -y libusb-1.0-0

# Install various utilities
RUN apt-get install -y vim iputils-ping tcpdump iproute2 net-tools

# Install usbutils for lsusb, and udev for triggering events
RUN apt-get install -y usbutils udev

# Install the avahi dns_sd compat library and its header files 
RUN apt-get install -y libavahi-compat-libdnssd-dev

# hdparm for reading a unique SSD id
RUN apt-get install -y hdparm

# Create a META.yaml file in the root location
RUN echo "hostname: dev_engine, engineId: 1234567890-engine, deviceId: 1234567890-device, created: 1718271140002, version: '1.0' > /META.yaml"

# Initialise pnpm 
# All packages will be added to /pnpm, outside the /app folder
ENV SHELL bash
ENV PNPM_HOME /pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN pnpm setup 

# Add any global npm packages  
# - Install ts-node globally so the engine scripts can run globally
RUN pnpm add -g ts-node  

# Expose ports
EXPOSE 22
EXPOSE 1234

# Replace sh by bash so that the terminal window in Docker Desktop starts with bash
RUN ln -sf /bin/bash /bin/sh

# ------------------------------------------------------------------------------
# base_with_source
# This is the base image for the dev_image and prod_image targets
# Do not use this image as a target
# ------------------------------------------------------------------------------

FROM base as base_with_source

# Add the source code
COPY . /engine
WORKDIR /engine


# ------------------------------------------------------------------------------
# dev_image
# Use this target to build a dev image from the source code
# This target can also be used for automated builds on Docker Hub
# ------------------------------------------------------------------------------

FROM base_with_source as dev_image

# Install dev dependencies
ENV NODE_ENV development
RUN pnpm install

# Build the code
RUN npm run dev_build

# Run the node project on the start of the container
CMD npm run dev

# ------------------------------------------------------------------------------
# prod_image
# Use this target to build a prod image from the source code
# This target can also be used for automated builds on Docker Hub
# ------------------------------------------------------------------------------

FROM base_with_source as prod_image

# Install prod dependencies
ENV NODE_ENV production
RUN pnpm install

# Build the code
RUN npm run prod_build

# Run the node project on the start of the container
CMD npm run prod


