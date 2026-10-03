FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY src/protocol.ts /app/src/protocol.ts
COPY worker/main.ts worker/agent.ts worker/memory.ts worker/transport.ts worker/precheck-main.ts /app/worker/
USER 1000:1000
ENTRYPOINT ["bun", "/app/worker/main.ts"]
