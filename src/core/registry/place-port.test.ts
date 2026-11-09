import { expect, test } from "bun:test";
import type { PlaceProvider } from "../contract/places.ts";
import type { ChatSurface } from "../contract/surface.ts";
import { surfacePort } from "../routing/surface-port.ts";
import { FakePager } from "../testing/fake-pager-places.ts";
import { FakeRoomSurface } from "../testing/fake-room-surface.ts";
import { placeProviderContract } from "../testing/place-contract.ts";
import { derivedPlaces, placePort } from "./place-port.ts";

/** A surface that serves channels but no agent rooms. */
const plain = (surface: string): ChatSurface => ({
	surface,
	start: async () => undefined,
	sendReply: async () => undefined,
});

placeProviderContract("the derived provider over a room surface", async () => {
	const room = new FakeRoomSurface("app");
	const provider = derivedPlaces(
		"app",
		surfacePort(() => [room]),
	);
	return { provider, seen: (key) => room.seen(key) };
});

placeProviderContract("a stored pager provider", async () => {
	const pager = new FakePager();
	return {
		provider: pager.provider,
		seen: (key) => pager.seen(key),
		delete: async (id) => pager.delete(id),
		foreign: async () => "other-9",
	};
});

test("a surface that hosts rooms gets a derived provider, one that does not gets none", () => {
	const room = new FakeRoomSurface("app");
	const surfaces = [room, plain("chat")];
	const port = placePort(
		() => ({ surfaces, providers: [] }),
		surfacePort(() => surfaces),
	);
	expect(port.of("app")?.storage).toBe("derived");
	expect(port.of("app:agent.knight")?.surface).toBe("app");
	expect(port.of("chat")).toBeUndefined();
	expect(port.of("chat:1")).toBeUndefined();
	expect(port.of(":1")).toBeUndefined();
	expect(port.stored()).toEqual([]);
});

test("a derived room posts through the surface under the agent, in the thread when it names one", async () => {
	const room = new FakeRoomSurface("app");
	const provider = derivedPlaces(
		"app",
		surfacePort(() => [room]),
	);
	await provider.post(provider.key({ kind: "agent", name: "knight" }), {
		author: { name: "Sir Knight", agent: "knight", avatarUrl: "x" },
		chunks: ["hi"],
		thread: "t-1",
		failed: true,
	});
	expect(room.replies).toEqual([
		{
			channel: "app:t-1",
			reply: {
				chunks: ["hi"],
				author: { name: "Sir Knight", agent: "knight" },
				failed: true,
			},
		},
	]);
});

test("auto order is the stored providers in contribution order, then the derived ones in surface order", () => {
	const first = new FakePager().provider;
	const second: PlaceProvider = {
		...new FakePager().provider,
		surface: "beeper",
	};
	const web = new FakeRoomSurface("web");
	const app = new FakeRoomSurface("app");
	// A surface with a contributed provider gets no derived one beside it.
	const beeper: ChatSurface = { ...plain("beeper"), agentRooms: true };
	const surfaces = [web, plain("pager"), beeper, app];
	const port = placePort(
		() => ({ surfaces, providers: [second, first] }),
		surfacePort(() => surfaces),
	);
	expect(port.stored().map((p) => p.surface)).toEqual(["beeper", "pager"]);
	expect(port.all().map((p) => `${p.surface}:${p.storage}`)).toEqual([
		"beeper:stored",
		"pager:stored",
		"web:derived",
		"app:derived",
	]);
});

test("a contributed derived provider replaces the one the host would make", () => {
	const room = new FakeRoomSurface("app");
	const own: PlaceProvider = {
		...derivedPlaces(
			"app",
			surfacePort(() => [room]),
		),
		mention: () => "the app room",
	};
	const port = placePort(
		() => ({ surfaces: [room], providers: [own] }),
		surfacePort(() => [room]),
	);
	expect(port.of("app")).toBe(own);
	expect(port.all()).toEqual([own]);
});

test("the port reads nothing until it is linked, and then reads once", () => {
	let linked = false;
	let reads = 0;
	const room = new FakeRoomSurface("app");
	const port = placePort(
		() => {
			reads += 1;
			if (!linked) throw new Error("not linked");
			return { surfaces: [room], providers: [] };
		},
		surfacePort(() => [room]),
	);
	expect(() => port.all()).toThrow("not linked");
	linked = true;
	port.all();
	port.of("app");
	expect(reads).toBe(2);
});
