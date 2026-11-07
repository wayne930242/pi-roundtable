import { expect, test } from "bun:test";
import { DISPLAY_KINDS } from "pi-better-show";
import type { ChannelKey } from "pi-roundtable";
import {
	describeBlocksContract,
	type SurfaceObservation,
} from "pi-roundtable/testing";
import { AppSurface } from "./surface.ts";

const ROOM = "app:agent.guide" as ChannelKey;

function appSurface(rows: { text?: string }[] = []) {
	return new AppSurface({
		surface: "app",
		sockets: { deliver: () => undefined },
		audienceOf: () => ({ owners: true }),
		isHostRoom: () => false,
		log: {
			append: async (row: { text?: string }) => {
				rows.push(row);
				return { id: rows.length, ...row };
			},
		},
		files: {},
		uploads: { maxBytes: 1 },
		threads: {},
		canHost: async () => false,
		changed: () => undefined,
		now: () => 1_000_000,
		logger: { warn: () => undefined },
	} as never);
}

describeBlocksContract("the app surface", async () => {
	const rows: { text?: string }[] = [];
	return {
		surface: appSurface(rows),
		channel: ROOM,
		write: async () => {
			throw new Error("the display-block contract writes nothing");
		},
		observations: (): readonly SurfaceObservation[] =>
			rows.map((row) => ({
				kind: "reply" as const,
				text: row.text ?? "",
				files: [],
			})),
	};
});

test("the app draws the display kinds itself, and the model is told how to write each", () => {
	const surface = appSurface();
	expect(surface.blocks).toEqual(DISPLAY_KINDS);
	for (const kind of DISPLAY_KINDS)
		expect(surface.formatting).toContain(`\`${kind}\``);
	// The interactive kinds arrive as text and are answered by typing.
	for (const kind of ["options", "form", "review", "suggest", "checklist"])
		expect(surface.formatting).not.toContain(`\`${kind}\``);
});

test("a 5000-character table reply is stored whole, in one message", async () => {
	const rows: { text?: string }[] = [];
	const table = [
		"```table",
		"columns: [name, size]",
		"rows:",
		...Array.from(
			{ length: 260 },
			(_, i) => `  - [row ${i} of the table, ${i}]`,
		),
		"```",
	].join("\n");
	expect(table.length).toBeGreaterThan(5000);
	await appSurface(rows).sendReply(ROOM, { chunks: [table] });
	expect(rows.map((row) => row.text)).toEqual([table]);
});
