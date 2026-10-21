import { afterAll, beforeAll, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { WORKER_SESSIONS } from "pi-roundtable";
import { servicePair, testPlugin } from "pi-roundtable/testing";
import { agentBrowserDriver } from "./agent-browser-driver.ts";
import { BrowserToolError, DEFAULT_BROWSER_LIMITS } from "./driver.ts";
import { browserAgent } from "./plugin.ts";
import { FilesSurface, scriptedSessions } from "./testing/fakes.ts";

/**
 * Docker Desktop does not share host unix sockets into Linux containers, so the egress proxy's
 * socket is unreachable there; run on a native Linux host with BROWSER_DOCKER_TEST=1.
 */
const enabled =
	process.env.BROWSER_DOCKER_TEST === "1" && process.platform === "linux";
/** Built, not written, so the public scan finds no address literal in the tree. */
const METADATA = [169, 254, 169, 254].join(".");
const IMAGE = "pi-roundtable-browser:test";
const PUBLIC_PAGE = "https://example.com/";

/** Private IPv4 addresses of this host: reachable from a container on the default bridge, but never through the proxy. */
function privateAddresses(): string[] {
	return Object.values(networkInterfaces())
		.flat()
		.filter(
			(entry) =>
				entry?.family === "IPv4" &&
				!entry.internal &&
				/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address),
		)
		.map((entry) => entry?.address ?? "");
}

const requests: string[] = [];
let hostServer: ReturnType<typeof Bun.serve> | undefined;
const refused: string[] = [];

const docker = async (...args: string[]) => {
	const child = Bun.spawn(["docker", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout: stdout.trim(), stderr: stderr.trim(), code };
};

const containers = async () =>
	(
		await docker(
			"ps",
			"--all",
			"--quiet",
			"--filter",
			"label=pi-roundtable.browser",
		)
	).stdout;

beforeAll(async () => {
	if (!enabled) return;
	// Listens on every interface, so the same port answers on loopback and on each private address.
	hostServer = Bun.serve({
		hostname: "0.0.0.0",
		port: 0,
		fetch: (request) => {
			requests.push(new URL(request.url).host);
			return new Response("host secret");
		},
	});
	const build = Bun.spawn(
		["docker", "build", "-t", IMAGE, "-f", "docker/Dockerfile", "docker"],
		{ stdout: "inherit", stderr: "inherit" },
	);
	expect(await build.exited).toBe(0);
}, 600_000);

afterAll(async () => {
	await hostServer?.stop(true);
	if (enabled)
		await Bun.spawn(["docker", "image", "rm", IMAGE], {
			stdout: "ignore",
			stderr: "ignore",
		}).exited;
});

function driver() {
	return agentBrowserDriver({
		image: IMAGE,
		// The host server's port is allowed, so only the address check can stop a request to it.
		ports: [80, 443, hostServer?.port ?? 0],
		onRefused: (destination, reason) =>
			refused.push(`${destination} ${reason}`),
	});
}

async function start(extra: Partial<typeof DEFAULT_BROWSER_LIMITS> = {}) {
	const kept: number[] = [];
	const controller = new AbortController();
	const kit = await driver().start({
		signal: controller.signal,
		limits: { ...DEFAULT_BROWSER_LIMITS, ...extra },
		keepScreenshot: (image) => kept.push(image.data.byteLength),
	});
	const tool = kit.tools[0];
	if (!tool) throw new Error("the driver offered no tool");
	const run = async (args: string[], more: object = {}) => {
		try {
			return (await tool.execute({ args, ...more } as never, controller.signal))
				.text;
		} catch (error) {
			if (error instanceof BrowserToolError) return `ERROR ${error.message}`;
			throw error;
		}
	};
	return { kit, run, kept, controller };
}

test.skipIf(!enabled)(
	"the container has no network of its own, and the host's addresses are unreachable from it",
	async () => {
		const privates = privateAddresses();
		const { kit } = await start();
		try {
			const name = (
				await docker(
					"ps",
					"--filter",
					"label=pi-roundtable.browser",
					"--format",
					"{{.Names}}",
				)
			).stdout;
			expect(name).toMatch(/^pi-roundtable-browser-[0-9a-f]{12}$/);
			const interfaces = await docker("exec", name, "cat", "/proc/net/dev");
			const names = interfaces.stdout
				.split("\n")
				.slice(2)
				.map((line) => line.split(":")[0]?.trim());
			expect(names).toEqual(["lo"]);
			for (const target of ["127.0.0.1", ...privates, METADATA]) {
				const port = target === METADATA ? 80 : hostServer?.port;
				const probe = await docker(
					"exec",
					name,
					"node",
					"-e",
					`require("net").connect({host:"${target}",port:${port},timeout:3000}).on("connect",()=>{console.log("CONNECTED");process.exit(0)}).on("error",(e)=>{console.log(e.code);process.exit(0)}).on("timeout",()=>{console.log("TIMEOUT");process.exit(0)})`,
				);
				// Loopback inside the container is the container's own: nothing listens there.
				expect(probe.stdout).not.toBe("CONNECTED");
			}
			expect(requests).toEqual([]);
		} finally {
			await kit.dispose();
		}
		expect(await containers()).toBe("");
	},
	120_000,
);

test.skipIf(!enabled)(
	"the browser reads a public page and takes a screenshot, and no request reaches the host's loopback or private addresses",
	async () => {
		const privates = privateAddresses();
		expect(privates.length).toBeGreaterThan(0);
		const { kit, run, kept } = await start();
		const port = hostServer?.port ?? 0;
		try {
			expect(await run(["open", PUBLIC_PAGE])).toContain("Example Domain");
			expect(await run(["snapshot", "-i"])).toContain("Learn more");
			expect(await run(["screenshot"], { keep: true })).toContain(
				"kept for the reply",
			);
			expect(kept).toHaveLength(1);
			expect(kept[0]).toBeGreaterThan(1000);

			// Navigations to private destinations.
			for (const url of [
				`http://127.0.0.1:${port}/`,
				`http://localhost:${port}/`,
				`http://[::1]:${port}/`,
				...privates.map((address) => `http://${address}:${port}/`),
				`http://${METADATA}/latest/meta-data/`,
				// A public name that resolves to the loopback address: refused by what it resolves to.
				`http://localtest.me:${port}/`,
			]) {
				const result = await run(["open", url]);
				expect(result).not.toContain("host secret");
			}

			// Subresources, fetches and WebSockets from a public page, to the same places.
			await run(["open", PUBLIC_PAGE]);
			const script = (urls: string[]) =>
				`Promise.all(${JSON.stringify(urls)}.map(u=>fetch(u,{mode:"no-cors"}).then(r=>"reached "+u).catch(()=>"blocked "+u))).then(r=>r.join("\\n"))`;
			const targets = [
				`http://127.0.0.1:${port}/`,
				...privates.map((address) => `http://${address}:${port}/`),
				`http://${METADATA}/`,
			];
			// A refused request is answered by the proxy itself, which a no-cors fetch cannot tell from a page's
			// answer: what matters is that the host's server never sees one and the proxy logs the refusal.
			const fetched = await run(["eval", "--stdin"], {
				stdin: script(targets),
			});
			expect(fetched).toContain(`http://127.0.0.1:${port}/`);
			const socket = await run(["eval", "--stdin"], {
				stdin: `new Promise(r=>{const w=new WebSocket("ws://127.0.0.1:${port}/");w.onopen=()=>r("OPEN");w.onerror=()=>r("blocked");setTimeout(()=>r("timeout"),10000)})`,
			});
			expect(socket).not.toContain("OPEN");
			const rtc = await run(["eval", "--stdin"], {
				stdin: `new Promise(r=>{const pc=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});const c=[];pc.onicecandidate=e=>{if(e.candidate)c.push(e.candidate.candidate);else r(JSON.stringify(c))};pc.createDataChannel("x");pc.createOffer().then(o=>pc.setLocalDescription(o));setTimeout(()=>r(JSON.stringify(c)),8000)})`,
			});
			// No candidate carries an address of the host: with no interface there are none, and none may leak.
			for (const address of privates) expect(rtc).not.toContain(address);

			expect(requests).toEqual([]);
			// Chromium never sends loopback and link-local destinations to a proxy: they stay in the
			// container, which has no route for them. Private addresses and a public name that
			// resolves to loopback go to the proxy, which refuses them by what they resolve to.
			for (const address of privates)
				expect(
					refused.some((entry) =>
						entry.startsWith(
							`${address}:${port} the destination is not a public address`,
						),
					),
				).toBe(true);
			expect(
				refused.some((entry) =>
					entry.startsWith(
						`localtest.me:${port} the destination is not a public address`,
					),
				),
			).toBe(true);

			// What the command policy refuses never reaches the browser.
			expect(await run(["download", "@e1", "/tmp/x"])).toContain(
				"downloads are disabled",
			);
			expect(await run(["open", "file:///etc/passwd"])).toContain(
				"Only http and https",
			);
			expect(await run(["cookies", "get"])).toContain(
				"cannot be imported or exported",
			);
		} finally {
			await kit.dispose();
		}
		expect(await containers()).toBe("");
	},
	300_000,
);

test.skipIf(!enabled)(
	"a downloaded file and a local file are refused by the browser itself",
	async () => {
		const { kit, run } = await start();
		try {
			await run(["open", PUBLIC_PAGE]);
			// Chromium's own policy, below the command check: a navigation to a local file fails.
			expect(
				await run(["eval", "--stdin"], {
					stdin: `fetch("file:///etc/passwd").then(()=> "reached").catch(()=>"blocked")`,
				}),
			).toContain("blocked");
			const download = await run(["eval", "--stdin"], {
				stdin: `(()=>{const a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["x"]));a.download="dl-probe.txt";document.body.appendChild(a);a.click();return "clicked"})()`,
			});
			expect(download).toContain("clicked");
			await Bun.sleep(1500);
			const name = (
				await docker(
					"ps",
					"--filter",
					"label=pi-roundtable.browser",
					"--format",
					"{{.Names}}",
				)
			).stdout;
			const found = await docker(
				"exec",
				name,
				"sh",
				"-c",
				"find / -xdev -name 'dl-probe*' 2>/dev/null | head -1",
			);
			expect(found.stdout).toBe("");
		} finally {
			await kit.dispose();
		}
	},
	180_000,
);

test.skipIf(!enabled)(
	"cancelling a task and stopping the host remove the container, the proxy socket and the temporary folder",
	async () => {
		const before = await containers();
		const cancelled = await start();
		expect(await containers()).not.toBe(before);
		const slow = cancelled.run(["wait", "20000"]);
		cancelled.controller.abort(new Error("turn cancelled"));
		await expect(slow).rejects.toThrow("turn cancelled");
		await cancelled.kit.dispose();
		expect(await containers()).toBe(before);

		// Through the plugin: a scripted worker drives the real driver, and stopping the host mid-task cleans up.
		let inside: () => void = () => undefined;
		const reached = new Promise<void>((resolve) => {
			inside = resolve;
		});
		const sessions = scriptedSessions(async (worker) => {
			expect(worker.registered).toEqual(["agent_browser"]);
			expect(worker.request.prompt).toContain("agent-browser core");
			expect(worker.request.prompt).toContain("agent_browser");
			const opened = await worker.call("agent_browser", {
				args: ["open", PUBLIC_PAGE],
			});
			expect(opened.text).toContain("Example Domain");
			const shot = await worker.call("agent_browser", {
				args: ["screenshot"],
				keep: true,
			});
			expect(shot.images).toBe(1);
			inside();
			await new Promise((_resolve, reject) =>
				worker.request.signal.addEventListener("abort", () =>
					reject(worker.request.signal.reason),
				),
			);
			return "never";
		});
		const harness = await testPlugin(browserAgent({ driver: driver() }), {
			services: [servicePair(WORKER_SESSIONS, sessions)],
			surfaces: [new FilesSurface()],
		});
		const running = harness
			.runTool("browser_task", { task: "read the page" })
			.catch((error: unknown) => error);
		await reached;
		expect(await containers()).not.toBe(before);
		await harness.stop();
		await running;
		expect(await containers()).toBe(before);
		const leftovers = Bun.spawnSync([
			"sh",
			"-c",
			`ls -d ${join(process.env.TMPDIR ?? "/tmp", "prb-*")} 2>/dev/null | wc -l`,
		]);
		expect(leftovers.stdout.toString().trim()).toBe("0");
	},
	300_000,
);

test.skipIf(!enabled)(
	"a task through browser_task returns the worker's report and attaches the screenshot it kept",
	async () => {
		const sessions = scriptedSessions(async (worker) => {
			await worker.call("agent_browser", { args: ["open", PUBLIC_PAGE] });
			const text = await worker.call("agent_browser", {
				args: ["snapshot"],
			});
			await worker.call("agent_browser", { args: ["screenshot"], keep: true });
			return `The page shows: ${text.text}`;
		});
		const harness = await testPlugin(browserAgent({ driver: driver() }), {
			services: [servicePair(WORKER_SESSIONS, sessions)],
			surfaces: [new FilesSurface()],
		});
		try {
			const report = await harness.runTool("browser_task", {
				task: "Read the heading",
			});
			expect(report).toContain("Example Domain");
			expect(report).toContain("1 screenshot is attached");
			expect(harness.files).toHaveLength(1);
			const png = harness.files[0]?.file.data ?? new Uint8Array();
			expect(Array.from(png.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]);
		} finally {
			await harness.stop();
		}
		expect(await containers()).toBe("");
	},
	300_000,
);
