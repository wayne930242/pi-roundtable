FROM oven/bun:1.4.4-alpine
WORKDIR /app
COPY src/protocol.ts src/history.ts /app/src/
COPY worker/main.ts worker/agent.ts worker/memory.ts worker/transport.ts worker/precheck-main.ts /app/worker/
LABEL pi-roundtable-sandbox.protocol="2"
USER 1000:1000
ENTRYPOINT ["bun", "/app/worker/main.ts"]
