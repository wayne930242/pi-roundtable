# The browser worker's image: agent-browser and the distribution's Chromium, nothing else of use.
# The host runs it with no network at all; see packages/browser/README.md.
FROM node:24-bookworm-slim

ARG AGENT_BROWSER_VERSION=0.39.1

# Chromium comes from the distribution because Chrome for Testing has no Linux ARM64 build, and its
# managed policy directory is /etc/chromium/policies/managed. socat relays the container's loopback
# proxy port to the host's egress proxy socket.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    chromium socat ca-certificates fonts-liberation fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

RUN npm install --global --allow-scripts=agent-browser "agent-browser@${AGENT_BROWSER_VERSION}" \
 && rm -rf /root/.npm

# Chromium refuses downloads, local files, and the pages that expose the browser's own state.
COPY policies.json /etc/chromium/policies/managed/pi-roundtable.json

COPY entrypoint.sh /usr/local/bin/pi-roundtable-browser-entrypoint
RUN chmod 0755 /usr/local/bin/pi-roundtable-browser-entrypoint

ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENTRYPOINT ["/usr/local/bin/pi-roundtable-browser-entrypoint"]
