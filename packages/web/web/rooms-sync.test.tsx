import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { RoomView } from "../src/api-types.ts";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { useRoomsSync } from "./lib/rooms-sync.ts";

const room = (name: string, over: Partial<RoomView> = {}): RoomView => ({
	key: `app:agent.${name}`,
	kind: "agent",
	name,
	displayName: name,
	home: false,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

let page: TestPage;
beforeAll(async () => {
	page = await openPage();
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});

function Sync(props: { enabled: boolean }) {
	useRoomsSync(props.enabled, 0);
	return null;
}

/** A fetch of the room list the test answers by hand, in any order. */
function answers() {
	const pending: Array<(rooms: RoomView[]) => void> = [];
	const spy = spyOn(api, "rooms").mockImplementation(
		() =>
			new Promise((resolve) => {
				pending.push((rooms) => resolve({ rooms, pins: [], folders: [] }));
			}) as ReturnType<typeof api.rooms>,
	);
	return { pending, spy };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a run of changed frames that outpaces the fetch still shows the answers that come back", async () => {
	store.dispatch({ type: "rooms_loaded", rooms: [] });
	const { pending, spy } = answers();
	await page.render(<Sync enabled />);
	// three `changed` frames land before the first answer: each asks again
	for (let i = 0; i < 3; i += 1)
		await page.act(() => store.dispatch({ type: "changed" }));
	expect(pending).toHaveLength(4);
	await page.act(async () => {
		pending[0]?.([room("first")]);
		await settle();
	});
	// the first answer is not thrown away because a newer request is under way
	expect(store.getState().order).toEqual(["app:agent.first"]);
	await page.act(async () => {
		pending[3]?.([room("last")]);
		await settle();
	});
	expect(store.getState().order).toEqual(["app:agent.last"]);
	// an older request that answers late never replaces a newer answer
	await page.act(async () => {
		pending[1]?.([room("stale")]);
		await settle();
	});
	expect(store.getState().order).toEqual(["app:agent.last"]);
	spy.mockRestore();
});

test("nothing is taken once the page no longer syncs", async () => {
	store.dispatch({ type: "rooms_loaded", rooms: [] });
	const { pending, spy } = answers();
	await page.render(<Sync enabled />);
	await page.render(<Sync enabled={false} />);
	await page.act(async () => {
		pending[0]?.([room("late")]);
		await settle();
	});
	expect(store.getState().order).toEqual([]);
	spy.mockRestore();
});
