import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defineRoundtable } from "../define-roundtable.ts";
import { recordingLogger } from "../testing/recording-logger.ts";
import {
	AVATAR_DEPRECATION,
	type RoundtableConfig,
	resolveConfig,
} from "./config.ts";

const minimal: RoundtableConfig = {
	owner: { id: "100000000000000001", name: "Ada" },
	discord: {
		token: "token",
		guild: "900000000000000001",
		entryChannel: "900000000000000002",
	},
	database: { url: "postgres://localhost/roundtable" },
	dataDir: "/data",
	model: "anthropic/claude-sonnet-5-5",
	http: { publicUrl: "https://bot.example.com" },
};

test("avatar is deprecated: it resolves, logs one warning at start, and the host starts", async () => {
	const resolved = resolveConfig({ ...minimal, avatar: "/a.png" });
	expect(resolved.deprecations).toContain(AVATAR_DEPRECATION);
	expect(resolveConfig(minimal).deprecations).not.toContain(AVATAR_DEPRECATION);
	const dir = mkdtempSync(join(tmpdir(), "roundtable-avatar-"));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const { logger, lines } = recordingLogger();
	const config = { ...minimal, dataDir: dir, avatar: "/a.png" };
	await defineRoundtable(config, { logger, modelRuntime });
	await defineRoundtable(config, { logger, modelRuntime });
	expect(
		lines.filter(
			(line) => line.message === `deprecated: ${AVATAR_DEPRECATION}`,
		),
	).toEqual([
		{
			level: "warn",
			fields: {},
			message: `deprecated: ${AVATAR_DEPRECATION}`,
		},
	]);
});
