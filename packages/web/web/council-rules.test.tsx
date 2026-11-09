import { expect, test } from "bun:test";
import { agent, councilPage, group, NAMES } from "./council-fixture.tsx";
import {
	councilOf,
	hostOf,
	membersOf,
	slugFor,
	startingTicks,
	toggled,
} from "./lib/council.ts";

councilPage();

// ── the pure rules ───────────────────────────────────────────────────────────────────────────

test("the address, then the council this device chose, then the first group is what the table shows", () => {
	const crew = group("crew", ["guide", "scout"]);
	const ops = group("ops", ["mason", "cook"]);
	expect(councilOf([crew, ops], undefined)?.name).toBe("crew");
	expect(councilOf([crew, ops], ops.key)?.name).toBe("ops");
	expect(councilOf([crew, ops], ops.key, "crew")?.name).toBe("crew");
	expect(councilOf([crew, ops], undefined, ops.key)?.name).toBe("ops");
	// a choice that is gone (archived) falls back to the first group
	expect(councilOf([crew, ops], "app:group.gone")?.name).toBe("crew");
	expect(councilOf([], "app:group.crew")).toBeUndefined();
});

test("with no council the sheet starts from the agents that were not muted, the coordinator first, eight at most", () => {
	const list = [
		agent("scout", { muted: true }),
		agent("mason"),
		...NAMES.slice(3).map((name) => agent(name)),
		agent("guide"),
	];
	const ticks = startingTicks(list);
	expect(ticks).toHaveLength(8);
	expect(ticks[0]).toBe("guide");
	expect(ticks).not.toContain("scout");
});

test("ticks keep the order they were made in, and the ninth is not taken", () => {
	let ticked: string[] = [];
	for (const name of NAMES.slice(0, 8)) ticked = toggled(ticked, name);
	expect(ticked).toEqual(NAMES.slice(0, 8));
	expect(toggled(ticked, "clerk")).toEqual(ticked);
	expect(toggled(ticked, "mason")).toEqual(
		NAMES.slice(0, 8).filter((name) => name !== "mason"),
	);
	// a tick that comes back goes last
	expect(toggled(toggled(ticked, "guide"), "guide").at(-1)).toBe("guide");
});

test("members are the ticks that still exist, at most eight, and the host stays unless it left", () => {
	expect(membersOf(["a", "b", "gone", "c"], (name) => name !== "gone")).toEqual(
		["a", "b", "c"],
	);
	expect(membersOf(NAMES.concat("x"), () => true)).toHaveLength(8);
	expect(hostOf(["a", "b"], "b", "a")).toBe("b");
	expect(hostOf(["a", "b"], "c", "b")).toBe("b");
	expect(hostOf(["a", "b"], undefined, "z")).toBe("a");
	expect(hostOf([], undefined, undefined)).toBe("");
});

test("a new council's permanent name comes from its name, and is free among the names there are", () => {
	expect(slugFor("Night Watch", new Set())).toBe("night-watch");
	expect(slugFor("Night Watch", new Set(["night-watch"]))).toBe(
		"night-watch-2",
	);
	// a name with no letter or digit in it still gets one
	expect(slugFor("\u8a55\u8b70\u6703", new Set())).toBe("council");
	expect(slugFor("\u8a55\u8b70\u6703", new Set(["council", "council-2"]))).toBe(
		"council-3",
	);
});

// ── the page ─────────────────────────────────────────────────────────────────────────────────
