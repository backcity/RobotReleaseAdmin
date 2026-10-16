#!/bin/sh
set -eu
mkdir -p /data
if ! setpriv --reuid=node --regid=node --init-groups /bin/sh -c 'test -w /data'; then
  chown -R node:node /data
fi
cd /app
exec setpriv --reuid=node --regid=node --init-groups npm run start -w server
