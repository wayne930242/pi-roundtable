import { expect, test } from "bun:test";
import { DISPLAY_KINDS, INTERACTIVE_KINDS } from "pi-better-show";
import type { ChannelKey } from "pi-roundtable";
import { supportOf } from "pi-roundtable/kit";
import {
	describeBlocksContract,
	type SurfaceObservation,
} from "pi-roundtable/testing";
import { AppSurface } from "./surface.ts";

const ROOM = "app:agent.guide" as ChannelKey;

function appSurface(rows: { text?: string }[] = [], hostRooms: string[] = []) {
	return new AppSurface({
		surface: "app",
		sockets: { deliver: () => undefined },
		audienceOf: () => ({ owners: true }),
		isHostRoom: (room: string) => hostRooms.includes(room),
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

test("the app draws the display and the interactive kinds itself, and the model is told how to write each", () => {
	const surface = appSurface();
	expect(surface.blocks).toEqual([...DISPLAY_KINDS, ...INTERACTIVE_KINDS]);
	for (const kind of [...DISPLAY_KINDS, ...INTERACTIVE_KINDS])
		expect(surface.formatting).toContain(`\`${kind}\``);
	// Core adds no line that the app cannot show forms.
	expect(supportOf(surface, ROOM).formatting).toBe(surface.formatting);
});

test("the model is told when to use a block and when ask_user, and that the answer comes as a message", () => {
	const { formatting } = appSurface();
	expect(formatting).toContain("ask_user");
	expect(formatting).toContain("next message");
	expect(formatting).toContain("Never use it when several may be chosen");
	expect(formatting).toContain("`multi` question");
	expect(formatting).toContain("`file:` id");
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

test("a host room is told no block guide and draws no block, though the app's rooms do", () => {
	const host = "app:team.guests" as ChannelKey;
	const surface = appSurface([], [host]);
	expect(surface.support(ROOM)).toBeUndefined();
	const there = surface.support(host);
	expect(there?.blocks).toEqual([]);
	expect(there?.formatting).toContain("Markdown renders");
	expect(there?.formatting).not.toContain("Display blocks");
	expect(there?.formatting).not.toContain("`table`");
	// Core tells the model what a guest's page cannot show.
	expect(supportOf(surface, host).formatting).toContain(
		"This chat cannot show forms, option buttons or checklists.",
	);
});
