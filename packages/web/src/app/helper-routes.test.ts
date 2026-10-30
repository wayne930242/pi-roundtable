import { beforeEach, describe, expect, test } from "bun:test";
import type { Speaker } from "pi-roundtable";
import type { HelpersArchived, HelpersRestored } from "../api-types.ts";
import { HelperRoutes } from "./helper-routes.ts";

interface Row {
	name: string;
	parent?: string;
	status: "active" | "archived";
	finished?: boolean;
}

const owner: Speaker = {
	id: "o",
	name: "Owner",
	tier: "owner",
	principalId: "o",
};

let rows: Row[];
let changes: number;

const routes = () =>
	new HelperRoutes({
		surface: "app",
		directory: {
			agent: (name: string) => rows.find((row) => row.name === name),
			agents: () => rows,
		} as never,
		team: {
			finishedHelpers: (parents?: readonly string[]) =>
				rows.filter(
					(row) =>
						row.parent !== undefined &&
						row.status === "active" &&
						row.finished &&
						(parents === undefined || parents.includes(row.parent)),
				),
			archiveHelpers: async (names: readonly string[]) =>
				rows
					.filter((row) => names.includes(row.name) && row.status === "active")
					.map((row) => {
						row.status = "archived";
						return row.name;
					}),
			restoreHelpers: async (names: readonly string[]) =>
				rows
					.filter(
						(row) => names.includes(row.name) && row.status === "archived",
					)
					.map((row) => {
						row.status = "active";
						return row.name;
					}),
		} as never,
		changed: () => {
			changes += 1;
		},
	});

const post = (body: unknown) =>
	new Request("http://x/api/rooms/x", {
		method: "POST",
		body: JSON.stringify(body),
	});

beforeEach(() => {
	changes = 0;
	rows = [
		{ name: "guide", status: "active" },
		{ name: "scout", status: "active" },
		{ name: "guide-1", parent: "guide", status: "active", finished: true },
		{ name: "guide-2", parent: "guide", status: "active" },
		{ name: "guide-3", parent: "guide", status: "active", finished: true },
		{ name: "scout-1", parent: "scout", status: "active", finished: true },
	];
});

describe("archiving finished temp knights", () => {
	test("with no room named it takes every knight's finished ones, by room, and leaves the working one", async () => {
		const response = await routes().archiveFinished(post({}), owner);
		const body = (await response.json()) as HelpersArchived;
		expect(body.archived).toEqual([
			{ room: "app:agent.guide", names: ["guide-1", "guide-3"] },
			{ room: "app:agent.scout", names: ["scout-1"] },
		]);
		expect(rows.find((row) => row.name === "guide-2")?.status).toBe("active");
		expect(changes).toBe(1);
	});

	test("a named room keeps it to that knight's temp knights", async () => {
		const response = await routes().archiveFinished(
			post({ rooms: ["app:agent.scout"] }),
			owner,
		);
		expect(((await response.json()) as HelpersArchived).archived).toEqual([
			{ room: "app:agent.scout", names: ["scout-1"] },
		]);
		expect(rows.find((row) => row.name === "guide-1")?.status).toBe("active");
	});

	test("nothing finished changes nothing and tells nobody", async () => {
		for (const row of rows) row.finished = false;
		const response = await routes().archiveFinished(post({}), owner);
		expect(((await response.json()) as HelpersArchived).archived).toEqual([]);
		expect(changes).toBe(0);
	});

	test("a key that is no knight's room, a temp knight's room or a list too long is refused", async () => {
		for (const rooms of [
			["app:agent.nobody"],
			["app:agent.guide-1"],
			["elsewhere:agent.guide"],
			"x",
			[1],
			Array(501).fill("app:agent.guide"),
		])
			expect(
				routes().archiveFinished(post({ rooms }), owner),
			).rejects.toMatchObject({ status: 400 });
	});
});

describe("restoring temp knights", () => {
	test("puts back exactly the names given, and passes over one that is no longer archived", async () => {
		await routes().archiveFinished(post({}), owner);
		const back = rows.find((row) => row.name === "guide-3");
		if (back) back.status = "active";
		changes = 0;
		const response = await routes().restore(
			post({ names: ["guide-1", "guide-3"] }),
		);
		expect(((await response.json()) as HelpersRestored).restored).toEqual([
			"guide-1",
		]);
		expect(rows.find((row) => row.name === "scout-1")?.status).toBe("archived");
		expect(changes).toBe(1);
	});

	test("a name that is no temp knight is refused by name", async () => {
		const failure = await routes()
			.restore(post({ names: ["guide-1", "guide", "nobody"] }))
			.catch((error: Error) => error);
		expect(failure).toMatchObject({ status: 400 });
		expect((failure as Error).message).toContain('"guide"');
		expect(changes).toBe(0);
	});

	test("the names are required and capped", async () => {
		for (const body of [{}, { names: "x" }, { names: Array(501).fill("a") }])
			expect(routes().restore(post(body))).rejects.toMatchObject({
				status: 400,
			});
	});
});
