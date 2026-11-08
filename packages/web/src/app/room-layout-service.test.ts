import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
	AGENTS,
	IDENTITY,
	ROOM_LAYOUT,
	type RoomLayoutService,
} from "pi-roundtable";
import { describeDb } from "pi-roundtable/testing";
import type { RoomsView } from "../api-types.ts";
import {
	ADA,
	bootE,
	Client,
	type EHost,
	ofType,
	principalOf,
	rest,
} from "../testing/e-host.ts";

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("ROOM_LAYOUT over the app's stored room layout", () => {
	let boot: EHost;
	let service: RoomLayoutService;
	let tab: Client;
	const clear = async () => {
		const database = boot.host.context.database();
		await database`DELETE FROM web_room_folder_rooms`;
		await database`DELETE FROM web_room_pins`;
		await database`DELETE FROM web_room_folders`;
	};
	/** The room list as an owner's page reads it. */
	const roomList = async () =>
		(await (await rest(boot, "rooms")).json()) as RoomsView;
	const keyed = (view: RoomsView) =>
		view.folders.map((folder) => [folder.name, folder.rooms]);

	/** Takes the change frames of earlier changes, once their coalescing window has passed. */
	const drain = async () => {
		await Bun.sleep(300);
		while (await tab.sees(ofType("changed"), 20))
			await tab.take(ofType("changed"));
	};

	beforeAll(async () => {
		boot = await bootE({ local: true });
		const { services } = boot.host.context;
		service = services.get(ROOM_LAYOUT);
		const team = services.get(AGENTS).team;
		const speaker = await services
			.get(IDENTITY)
			.speakerFor(await principalOf(boot.host, ADA));
		for (const name of ["lay-scout", "lay-scribe", "lay-smith"])
			await team.createAgent(speaker, {
				name,
				displayName: name,
				prompt: `You are ${name}.`,
			});
		await team.createGroup({
			name: "lay-duo",
			displayName: "Lay duo",
			members: ["lay-scout", "lay-scribe"],
		});
		const client = await Client.open(boot, "owner");
		if (!client) throw new Error("the owner was refused");
		tab = client;
		await tab.take(ofType("ready"));
	}, 30_000);
	afterAll(async () => {
		tab?.close();
		if (!boot) return;
		await clear();
		// The names are freed, so the suite can run again on the same database.
		const team = boot.host.context.services.get(AGENTS).team;
		for (const name of ["lay-duo", "lay-scout", "lay-scribe", "lay-smith"]) {
			await team.archive(undefined, name).catch(() => undefined);
			await team.remove(name).catch(() => undefined);
		}
		await boot.stop();
		rmSync(boot.dataDir, { recursive: true, force: true });
	});
	beforeEach(clear);

	test("place makes a missing group, puts the room last, and the open page hears the change", async () => {
		await drain();
		await service.place("lay-scout", "Research");
		await tab.take(ofType("changed"));
		await service.place("lay-duo", "research");
		await tab.take(ofType("changed"));
		expect(keyed(await roomList())).toEqual([
			["Research", ["app:agent.lay-scout", "app:group.lay-duo"]],
		]);
		expect(await service.view()).toEqual({
			groups: [{ name: "Research", rooms: ["lay-scout", "lay-duo"] }],
			pins: [],
		});
		await service.place("lay-scout", null);
		expect(keyed(await roomList())).toEqual([
			["Research", ["app:group.lay-duo"]],
		]);
	});

	test("arrange puts the listed groups and rooms first and keeps every other room where it was", async () => {
		await service.place("lay-smith", "Old");
		await service.place("lay-scribe", "Work");
		await service.place("lay-duo", "Work");
		const pinned = await rest(
			boot,
			`rooms/${encodeURIComponent("app:agent.lay-scout")}/pin`,
			{
				method: "PUT",
				body: JSON.stringify({ pinned: true }),
			},
		);
		expect(pinned.status).toBe(200);
		await tab.take(ofType("changed"));
		await drain();
		await service.arrange([
			{ group: "Work", names: ["lay-duo"] },
			{ group: "Life", names: ["lay-scout"] },
		]);
		await tab.take(ofType("changed"));
		expect(await service.view()).toEqual({
			groups: [
				{ name: "Work", rooms: ["lay-duo", "lay-scribe"] },
				{ name: "Life", rooms: ["lay-scout"] },
				{ name: "Old", rooms: ["lay-smith"] },
			],
			pins: [],
		});
	});

	test("a wrong name refuses the whole arrangement and nothing moves", async () => {
		await service.place("lay-scout", "Work");
		const before = await service.view();
		for (const [entries, refusal] of [
			[
				[{ group: "Life", names: ["lay-scribe", "ghost"] }],
				'no active agent or group "ghost"',
			],
			[[{ group: "Life", names: ["guide"] }], "Home stays at the top."],
			[
				[{ group: "x".repeat(41), names: ["lay-scribe"] }],
				"1 to 40 characters",
			],
			[
				[
					{ group: "Life", names: ["lay-scribe"] },
					{ group: "life", names: ["lay-smith"] },
				],
				"A group is listed twice.",
			],
		] as const)
			await expect(service.arrange(entries)).rejects.toThrow(refusal);
		await expect(service.place("guide", "Life")).rejects.toThrow(
			"Home stays at the top.",
		);
		expect(await service.view()).toEqual(before);
	});
});
