#!/bin/bash
# docker stop engine-engine-1
# docker rm engine-engine-1
# sudo rm -fr yjs-db
# docker compose -f compose-engine-dev.yaml up -d
# docker logs -f engine-engine-1
sudo -i
cd /home/pi/idea/agents/agent-engine-dev
pm2 stop engine
pnpm build
pm2 start engine
pm2 logs