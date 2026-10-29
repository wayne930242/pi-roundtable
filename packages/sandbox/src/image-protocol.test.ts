import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { IDENTITY } from "pi-roundtable";
import { servicePair, testPlugin } from "pi-roundtable/testing";
import type { ContainerDriver } from "./container-driver.ts";
import { sandbox } from "./plugin.ts";
import { SandboxRuntime, type SandboxRuntimeOptions } from "./runtime.ts";

const served = servicePair(IDENTITY, {
	resolve: async () => undefined,
});

function driver(
	protocol: number | undefined | "throw",
	asked: string[],
): ContainerDriver {
	return {
		run: async () => ({ ok: true, text: "done" }),
		imageProtocol: async (image) => {
			asked.push(image);
			if (protocol === "throw") throw new Error("cannot inspect sandbox image");
			return protocol;
		},
	};
}

const base = (root: string): SandboxRuntimeOptions => ({
	image: "sandbox:local",
	runRoot: join(root, "run"),
	workspaceRoot: join(root, "work"),
	model: "fake",
	modelUrl: "https://models.example/chat",
	apiKey: () => "k",
});

test.each([
	["workspace server", { workspace: "server" as const }],
	["budgets", { budgets: { promptBytes: 9000 } }],
])("%s needs a worker image of protocol 2", async (_name, extra) => {
	const root = mkdtempSync("/tmp/sb-proto-");
	try {
		for (const found of [undefined, 1]) {
			const asked: string[] = [];
			const runtime = new SandboxRuntime({
				...base(root),
				...extra,
				driver: driver(found, asked),
			});
			await expect(runtime.verifyImage()).rejects.toThrow(
				/sandbox:local.*protocol 2.*rebuild the image/s,
			);
			expect(asked).toEqual(["sandbox:local"]);
			await runtime.dispose();
		}
		for (const found of [2, 3]) {
			const runtime = new SandboxRuntime({
				...base(root),
				...extra,
				driver: driver(found, []),
			});
			await runtime.verifyImage();
			await runtime.dispose();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("options any worker serves never ask the driver, so an old image and a bare driver keep working", async () => {
	const root = mkdtempSync("/tmp/sb-proto-");
	try {
		const asked: string[] = [];
		const withLabel = new SandboxRuntime({
			...base(root),
			workspace: "channel",
			driver: driver(undefined, asked),
		});
		await withLabel.verifyImage();
		expect(asked).toEqual([]);
		const bare = new SandboxRuntime({
			...base(root),
			driver: { run: async () => ({ ok: true, text: "" }) },
		});
		await bare.verifyImage();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a driver that cannot report the protocol stops a startup that needs it, and an inspect failure passes through", async () => {
	const root = mkdtempSync("/tmp/sb-proto-");
	try {
		const bare = new SandboxRuntime({
			...base(root),
			workspace: "server",
			driver: { run: async () => ({ ok: true, text: "" }) },
		});
		await expect(bare.verifyImage()).rejects.toThrow("cannot report");
		const failing = new SandboxRuntime({
			...base(root),
			workspace: "server",
			driver: driver("throw", []),
		});
		await expect(failing.verifyImage()).rejects.toThrow("cannot inspect");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the plugin checks the image before it claims anything", async () => {
	const root = mkdtempSync("/tmp/sb-proto-");
	const make = (found: number | undefined) =>
		sandbox({
			...base(root),
			stateFile: join(root, "state", "channels.json"),
			provider: "p",
			workspace: "server",
			driver: driver(found, []),
		});
	const env = { services: [served], apiKeys: { p: "k" }, surfaces: [] };
	try {
		await expect(testPlugin(make(1), env)).rejects.toThrow(/rebuild the image/);
		const harness = await testPlugin(make(2), env);
		await harness.stop();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test.each([
	["an empty budgets object", {}],
	["budgets whose keys are all undefined", { promptBytes: undefined }],
])("%s asks nothing of the image", async (_name, budgets) => {
	const root = mkdtempSync("/tmp/sb-proto-");
	try {
		const asked: string[] = [];
		const runtime = new SandboxRuntime({
			...base(root),
			budgets,
			driver: driver(undefined, asked),
		});
		await runtime.verifyImage();
		expect(asked).toEqual([]);
		await runtime.dispose();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test.each([
	[
		"a relative stateFile",
		{ stateFile: "channels.json" },
		/stateFile must be absolute/,
	],
	["a malformed guild id", { guilds: ["not-a-snowflake"] }, /guild/i],
])(
	"the plugin rejects %s before it inspects the image",
	async (_name, extra, message) => {
		const root = mkdtempSync("/tmp/sb-proto-");
		const asked: string[] = [];
		try {
			const plugin = sandbox({
				...base(root),
				stateFile: join(root, "state", "channels.json"),
				provider: "p",
				workspace: "server",
				driver: driver(2, asked),
				...extra,
			});
			await expect(
				testPlugin(plugin, {
					services: [served],
					apiKeys: { p: "k" },
					surfaces: [],
				}),
			).rejects.toThrow(message);
			expect(asked).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
