#!/bin/sh
# Relays 127.0.0.1:3128 to the host's egress proxy on the mounted unix socket, then idles.
# The host drives the browser with `docker exec agent-browser ...`.
set -eu
socat TCP-LISTEN:3128,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/egress/proxy.sock &
# Exits by itself once the task could not still be running, even if the host that started it is gone.
exec sleep "${BROWSER_LIFETIME_SECONDS:-1200}"
