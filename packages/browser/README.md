# pi-roundtable-browser

A browser worker for [pi-roundtable][roundtable] agents.
Source lives in [`packages/browser`][source] in the pi-roundtable repository and releases in lockstep with the core.
The plugin adds one tool, `browser_task({ task, url? })`.
It starts a fresh worker session whose only tools drive a real browser, lets it work for a few minutes, and returns its written report; the screenshots the worker chose to keep are attached to the agent's reply.
The browser runs in a Docker container that is started for the task and removed after it, with no network of its own and no route to the host's loopback, link-local or private addresses.

[roundtable]: https://github.com/wayne930242/pi-roundtable
[source]: https://github.com/wayne930242/pi-roundtable/tree/master/packages/browser

## Requirements

- Bun 1.4.4 or later and pi-roundtable `>=0.25.0 <0.26.0`, which provides the `WORKER_SESSIONS` service the plugin runs its worker on.
- A native Linux host with a local Docker daemon, and a non-root service account permitted to run Docker. The container runs as that account; root is refused.
- The Docker image, built once on that host (below).

macOS supports the offline tests and building the image.
Browsing needs Linux: the container reaches the host's proxy through a bind-mounted Unix socket, and Docker Desktop does not share host Unix sockets into its Linux VM.
Remote Docker daemons are unsupported for the same reason: the socket must exist on the host that runs the container.

## Setup

```sh
bun add pi-roundtable-browser
```

Build the image from the installed package (the host builds it; the package publishes no image):

```sh
docker build -t pi-roundtable-browser:<version> \
  -f node_modules/pi-roundtable-browser/docker/Dockerfile \
  node_modules/pi-roundtable-browser/docker
```

`<version>` is the installed package's version; the default driver looks for exactly that tag.
`browserImageBuildCommand()` prints the command with your paths filled in, and the error you get when the image is missing quotes it.
To use another tag, build under it and pass `docker: { image }`.
The image installs Debian's Chromium (Chrome for Testing has no Linux ARM64 build), CJK and emoji fonts, `socat`, and `agent-browser` at the version in the Dockerfile's `AGENT_BROWSER_VERSION` build argument.
Rebuild it after upgrading the package.

Add the plugin to `roundtable.config.ts`:

```ts
import { browserAgent } from "pi-roundtable-browser";

export default {
  // ...the settings created by pi-roundtable init...
  plugins: [
    browserAgent({
      model: "anthropic/claude-sonnet-5-5", // default: the host's delegation.model
      thinking: "medium",                    // default: the host's delegation.thinking
    }),
  ],
};
```

Setup stops with a `PluginError` that names the fix when Docker is missing, its daemon does not answer, the image is not built, or the host runs as root.

The tool needs the owner tier.
Lower it with the host's `toolTiers`, for example `toolTiers: { browser_task: "admin" }`; remember that whoever may call it can make the host fetch any public page.
It is not a held action: nothing waits for the owner's approval.
Every task starts from a clean browser profile, so there are no stored logins, and the worker is told it has no credentials.

## Options

| Option | Default | What it does |
|---|---|---|
| `driver` | the agent-browser driver | How a task gets a browser; see [Another driver](#another-driver) |
| `docker` | | Options of the default driver: `image`, `binary`, `user: { uid, gid }`, `memoryMb` (1024), `cpus` (1.5), `pids` (512), `ports` (80 and 443), `commandTimeoutMs` (60,000), `onRefused(destination, reason)` |
| `model`, `thinking` | the host's delegation settings | The worker's model (`provider/model-id`) and thinking level |
| `limits.timeoutMs` | 5 minutes | The whole task. Past it the task ends with a message and the screenshots kept so far are still attached |
| `limits.maxSteps` | 40 | Tool calls. The call after the last gets an error telling the worker to report |
| `limits.maxScreenshots` | 4 | Screenshots the worker may keep for the reply |
| `limits.maxScreenshotBytes` | 4 MiB | The largest screenshot, kept or only looked at (at most 10 MiB, the core's limit for one reply file) |
| `limits.maxOutputChars` | 24,000 | The longest text one tool call hands the worker |
| `maxConcurrentTasks` | 2 | Tasks at once; the next call is refused until one ends |

A bad value stops startup with a `PluginError` naming the option.
Cancelling the turn, or stopping the host, aborts the worker and removes the task's container before the call settles.

## What the worker gets

The default driver gives the worker one tool, `agent_browser`, and the guide of the agent-browser the image holds.
`args` is the argument list after `agent-browser` (never a shell), `stdin` feeds `eval --stdin`, and `keep: true` on a `screenshot` attaches that image to the reply.
The guide is what `agent-browser skills get core` prints in the container, so the worker's instructions always match the binary it drives; the package adds a short note on translating the guide's shell examples into argument lists.

The command policy (`refuseAgentBrowserCommand`) keeps the worker to browsing.
It runs only commands on its list and refuses, with a reason the worker reads: downloads, uploads, installs and upgrades, cookies, storage and saved state, the auth vault, plugins, `connect`, `batch`, recording and tracing, and any flag that changes how the browser launches or what it trusts (`--proxy`, `--args`, `--cdp`, `--profile`, `--state`, `--ignore-https-errors`, `--headers` and the like).
`open` and `tab new` take only http and https addresses.
This is not the security boundary, which is the container's network; it keeps a worker from wasting steps on things that cannot work.

## How the container is isolated

- `--network none`: the container has a loopback interface and nothing else. There is no route to the host's loopback or private networks, to link-local addresses such as cloud metadata, or to the internet.
- The browser's only way out is a Unix socket, bind-mounted read-only from a private folder (mode 0700) at `/egress`, which `socat` relays to `127.0.0.1:3128` inside the container. Chromium uses it as its HTTP proxy for every request: pages, redirects, subresources, `fetch`, and WebSockets (`CONNECT`).
- On the host, the proxy resolves each destination itself, refuses it unless every address in the answer is a public unicast address (loopback, private, link-local, carrier-grade NAT, multicast, documentation and benchmarking ranges, IPv4-mapped and transition IPv6 forms are not), and connects to one of the vetted addresses. The browser's own DNS answer is never used, so a name that later resolves elsewhere (DNS rebinding) reaches nothing, and every redirect is a new request that is vetted again. Numeric forms of IPv4 addresses (`2130706433`, `0x7f.1`) are refused outright, and only ports 80 and 443 are open unless `docker.ports` adds more. A plain HTTP request is sent on its own connection, and every connection has idle and size limits.
- WebRTC is disabled for non-proxied UDP (`--force-webrtc-ip-handling-policy=disable_non_proxied_udp`), and with no interface there is no other path for it.
- Chromium runs under a managed policy that refuses downloads, local files, `chrome://` pages, file dialogs, sign-in, password saving and autofill. The agent-browser upload and download commands are refused as well.
- The container is read-only with a small tmpfs, runs as the host's non-root user with all capabilities dropped and `no-new-privileges`, and has memory, CPU and process limits. It is created with `--rm` and labelled; it exits by itself shortly after the task's time limit even if the host dies, and a restarted host removes containers a dead host left.
- A task that fails to clean up (for example the Docker daemon is down) logs a warning that names the container; the cleanup runs again when the host stops or restarts.

Nothing in the container is a secret: no credentials, no cookies, no mounted host files except the proxy socket.
What the worker reads on the web is untrusted, and its standing instructions say so; keep the `model` you give it in mind when the pages it reads may try to steer it.
A public page the worker opens is fetched from your host's IP address.

## Another driver

`BrowserDriver` is the extension point:

```ts
import { Type } from "typebox";
import { browserAgent, browserTool, type BrowserDriver } from "pi-roundtable-browser";

const driver: BrowserDriver = {
  async check() { /* throw a PluginError naming the fix if it cannot work */ },
  async start({ signal, limits, keepScreenshot }) {
    const session = await openMyBrowser(signal);
    return {
      tools: [browserTool({ name: "browser_open", description: "...", parameters: Type.Object({ url: Type.String() }), execute: async ({ url }) => ({ text: await session.open(url) }) })],
      skills: [{ name: "my browser", content: "How to use these tools..." }],
      prompt: "Optional instructions added after the standing rules.",
      dispose: () => session.close(),
    };
  },
};

browserAgent({ driver });
```

`start` builds one task's tools, skills and instructions; `dispose` is called once when the task ends, however it ended.
The package counts every tool call against `limits.maxSteps`, cuts text at `limits.maxOutputChars`, scrubs unexpected errors before the worker reads them, aborts `signal` on cancellation, time-out and shutdown, and enforces the screenshot count and size when a tool calls `keepScreenshot(image)`.
A driver is responsible for keeping its browser away from what the host should not expose; the package cannot check that for it.

## Testing

`bun test` runs offline: the tool flow with a fake driver and scripted worker sessions, the limits, cancellation and cleanup, the egress proxy with a stand-in network, the command policy, and the driver against a fake `docker` binary.
The Docker integration test builds the image, browses a public page, and proves that requests to the host's loopback, a private address and the metadata address fail.
It is opt-in and runs on native Linux as a non-root user:

```sh
(cd packages/browser && BROWSER_DOCKER_TEST=1 bun test src/docker.integration.test.ts)
```

CI runs it on its Ubuntu runner and requires it to pass.
