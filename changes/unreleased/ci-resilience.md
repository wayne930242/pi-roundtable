---
type: none
---
CI and local test runs are more resilient: `bun test` starts its own throwaway PostgreSQL through a preload, and the bun install step retries instead of failing on a transient network error.
