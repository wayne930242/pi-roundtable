import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin } from "pi-roundtable";
import { describeDb, type TestHost, testHost } from "pi-roundtable/testing";
import { line } from "./plugin.ts";
import { LINE, type LineBridgePort } from "./port.ts";
import type { LineScreen } from "./screen.ts";
import { CHANNEL_ID, fakeLine, SECRET } from "./testing/line-fake.ts";

// The plugin as the README shows it: read `LINE` with `get` in setup, and require it.
const screen: LineScreen = async (event) =>
	event.raw.mode === "standby" ? "consume" : "keep";

const linkCodes = definePlugin({
	name: "link-codes",
	requires: [LINE],
	setup: (context) => {
		context.services.get(LINE).screen(screen);
		return {};
	},
});

const lineWith = () =>
	line({
		credentials: { channelId: CHANNEL_ID, channelSecret: SECRET },
		fetch: fakeLine().fetch,
	});

const config = () => ({
	dataDir: mkdtempSync(join(tmpdir(), "roundtable-line-screen-")),
	http: {
		publicUrl: "https://hook.example.test",
		socketPath: join(tmpdir(), `line-screen-${process.pid}.sock`),
	},
});

describeDb("attaching a screen from a plugin's setup, as documented", () => {
	let host: TestHost | undefined;
	afterAll(async () => {
		await host?.stop();
	});

	test("a plugin that requires LINE and reads it with get attaches the screen in setup", async () => {
		host = await testHost({
			config: config(),
			plugins: [lineWith(), linkCodes],
		});
		const port: LineBridgePort = host.context.services.get(LINE);
		// The place is taken: the screen the plugin attached in setup is the one of the webhook.
		expect(() => port.screen(async () => "keep")).toThrow("already attached");
		// Only one host runs in a process: the next tests start their own.
		await host.stop();
		host = undefined;
	});

	test("listing the plugin before line() is refused at the start, naming both", async () => {
		await expect(
			testHost({ config: config(), plugins: [linkCodes, lineWith()] }),
		).rejects.toThrow(/link-codes.*line/s);
	});

	test("reading LINE with lazy() during setup is what throws, which is why the guide uses get", async () => {
		const lazily = definePlugin({
			name: "lazy-screen",
			requires: [LINE],
			setup: (context) => {
				context.services.lazy(LINE)().screen(screen);
				return {};
			},
		});
		await expect(
			testHost({ config: config(), plugins: [lineWith(), lazily] }),
		).rejects.toThrow("once every plugin is set up");
	});
});
