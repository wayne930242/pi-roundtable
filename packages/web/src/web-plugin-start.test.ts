import { describe, expect, test } from "bun:test";
import { testPlugin } from "pi-roundtable/testing";
import { resolveOptions } from "./options.ts";
import { ORIGIN } from "./testing/fixtures.ts";
import {
	agents,
	base,
	discord,
	identity,
	memory,
	webPluginHostPerTest,
} from "./testing/web-plugin-host.ts";
import { webConsole } from "./web-plugin.ts";

webPluginHostPerTest();

describe("refuses to start", () => {
	test("without a verifier, however the option is missing", () => {
		const { verifier: _omitted, ...rest } = base();
		expect(() => webConsole(rest as never)).toThrow("no verifier");
		expect(() =>
			webConsole({ ...base(), verifier: undefined } as never),
		).toThrow("no verifier");
		expect(() => webConsole({ ...base(), verifier: "yes" } as never)).toThrow(
			"no verifier",
		);
		expect(() => webConsole(undefined as never)).toThrow();
	});

	test.each([
		["an origin that is not a URL", { origin: "console" }, "origin"],
		[
			"an origin with a path",
			{ origin: "https://console.example.test/app" },
			"origin",
		],
		[
			"an origin that is not http or https",
			{ origin: "ftp://console.example.test" },
			"origin",
		],
		["a mount path with no segment", { mountPath: "/" }, "mountPath"],
		[
			"a mount path without a leading slash",
			{ mountPath: "console" },
			"mountPath",
		],
		["a mount path with a dot segment", { mountPath: "/a/../b" }, "mountPath"],
		["a mount path with a space", { mountPath: "/my console" }, "mountPath"],
		["no panes", { panes: [] }, "panes"],
		["an unknown pane", { panes: ["unknown"] }, "unknown pane"],
		["a repeated pane", { panes: ["notes", "notes"] }, "twice"],
		[
			"schedules without rooms",
			{ panes: ["schedules"] },
			"needs the rooms pane",
		],
		["the discord surface", { surface: "discord" }, "surface"],
		["a surface that is not a word", { surface: "My App" }, "surface"],
		["no card grace", { cardGraceSeconds: 0 }, "cardGraceSeconds"],
		["a day of card grace", { cardGraceSeconds: 86_400 }, "cardGraceSeconds"],
		["no upload at all", { uploadMaxBytes: 0 }, "uploadMaxBytes"],
		[
			"an upload limit the listener could not be asked for",
			{ uploadMaxBytes: Number.MAX_SAFE_INTEGER },
			"uploadMaxBytes",
		],
		[
			"an upload limit above 4 GiB",
			{ uploadMaxBytes: 4 * 1024 ** 3 + 1 },
			"uploadMaxBytes",
		],
		["a fractional upload limit", { uploadMaxBytes: 1.5 }, "uploadMaxBytes"],
		[
			"a push host that is a URL",
			{ push: { endpointHosts: ["https://push.example.com"] } },
			"push.endpointHosts",
		],
		[
			"a push host that is an address",
			{ push: { endpointHosts: ["10.0.0.1"] } },
			"push.endpointHosts",
		],
		[
			"a preview that is not a switch",
			{ push: { preview: "yes" } },
			"push.preview",
		],
		[
			"a push subject that is neither mailto nor https",
			{ push: { subject: "http://ops.example.com" } },
			"push.subject",
		],
		[
			"quiet hours that are not a window",
			{ push: { quietHours: true } },
			"push.quietHours",
		],
		[
			"quiet hours with a time that is not HH:MM",
			{ push: { quietHours: { start: "23", end: "08:00" } } },
			"push.quietHours",
		],
		[
			"quiet hours at an hour past 23",
			{ push: { quietHours: { start: "24:00", end: "08:00" } } },
			"push.quietHours",
		],
		[
			"quiet hours with no end",
			{ push: { quietHours: { start: "23:00" } } },
			"push.quietHours",
		],
		[
			"quiet hours that start when they end",
			{ push: { quietHours: { start: "08:00", end: "08:00" } } },
			"push.quietHours",
		],
		["notes with no owner id", { ownerId: " " }, "ownerId"],
		["an empty title", { title: " " }, "title"],
	])("with %s", (_name, change, message) => {
		expect(() => webConsole({ ...base(), ...change } as never)).toThrow(
			message,
		);
	});

	test("without a list of panes the console serves the owner app first", () => {
		const { panes } = resolveOptions({ ...base(), panes: undefined } as never);
		expect(panes).toEqual([
			"rooms",
			"table",
			"workspace",
			"overview",
			"schedules",
			"conversations",
			"notes",
			"presets",
			"webhooks",
		]);
		const settings = resolveOptions(base());
		expect([settings.surface, settings.cardGraceSeconds]).toEqual(["app", 120]);
		// A file may be 100 MiB by default, or more: the upload route asks the listener for the room.
		expect(settings.uploadMaxBytes).toBe(100 * 1024 * 1024);
		expect([settings.push.preview, settings.push.endpointHosts]).toEqual([
			true,
			[],
		]);
		expect(
			resolveOptions({
				...base(),
				push: { preview: false, endpointHosts: ["*.push.example.com"] },
			}).push,
		).toMatchObject({ preview: false, endpointHosts: ["*.push.example.com"] });
		// Quiet hours default to 23:00 to 08:00; `false` turns them off.
		expect(settings.push.quietHours).toEqual({ start: "23:00", end: "08:00" });
		expect(
			resolveOptions({
				...base(),
				push: { quietHours: { start: "22:30", end: "07:00" } },
			}).push.quietHours,
		).toEqual({ start: "22:30", end: "07:00" });
		expect(
			resolveOptions({ ...base(), push: { quietHours: false } }).push
				.quietHours,
		).toBeUndefined();
		// The VAPID contact defaults to an https origin only; a mailto: or https: subject overrides.
		expect(resolveOptions(base()).push.subject).toBe(ORIGIN);
		expect(
			resolveOptions({ ...base(), origin: "http://localhost:8080" }).push
				.subject,
		).toBeUndefined();
		expect(
			resolveOptions({
				...base(),
				origin: "http://localhost:8080",
				push: { subject: "mailto:ops@example.com" },
			}).push.subject,
		).toBe("mailto:ops@example.com");
		expect(
			resolveOptions({ ...base(), uploadMaxBytes: 1024 * 1024 * 1024 })
				.uploadMaxBytes,
		).toBe(1024 * 1024 * 1024);
	});

	test("a notes-less console needs no owner id", () => {
		expect(() =>
			webConsole({ ...base(), ownerId: undefined, panes: ["conversations"] }),
		).not.toThrow();
	});

	test("the notes pane needs no owner id either: it shows the visitor's own notes", () => {
		expect(() => webConsole({ ...base(), ownerId: undefined })).not.toThrow();
	});

	test("with a page that was never built", async () => {
		await expect(
			testPlugin(webConsole({ ...base(), assetDir: "/nonexistent-page" }), {
				services: [agents, memory, discord, identity()],
			}),
		).rejects.toThrow("not built");
	});
});
