import { expect, test } from "bun:test";
import { chatsConfig, GUIDE, loadChats, T1, T2 } from "./chats-fixture.tsx";
import { RoomThreadsButton } from "./components/room-threads.tsx";
import {
	all,
	foldersPage,
	page,
	q,
	SCOUT,
	until,
	view,
} from "./folders-fixture.tsx";
import { ConfigContext } from "./lib/config.ts";
import { setHomeMode } from "./lib/home-mode.ts";

foldersPage();

const Button = (props: { room: string; config?: typeof chatsConfig }) => (
	<ConfigContext.Provider value={props.config ?? chatsConfig}>
		<RoomThreadsButton room={props.room} />
	</ConfigContext.Provider>
);
const withThreads = () =>
	loadChats({}, [
		view(GUIDE, { home: true }),
		view(SCOUT),
		view(T1, {
			kind: "thread",
			parent: SCOUT,
			readOnly: true,
			displayName: "Open one",
		}),
		view(T2, {
			kind: "thread",
			parent: SCOUT,
			readOnly: true,
			closed: true,
			displayName: "Done one",
		}),
	]);

test("a room with threads has a header control with their count, and it opens them as cards in a sheet", async () => {
	withThreads();
	await page.render(<Button room={SCOUT} />);
	const button = q<HTMLButtonElement>(".room-threads");
	expect(button?.getAttribute("aria-label")).toBe("2 threads");
	expect(button?.textContent).toContain("2");
	await page.click(button);
	await until(() => q("dialog[open] .thread-card") !== null);
	expect(q("dialog[open]")?.getAttribute("aria-label")).toBe(
		"Dispatch threads",
	);
	expect(all("dialog[open] .thread-card").length).toBeGreaterThan(0);
});

test("a room with no thread, and a host that keeps the room list, show no control", async () => {
	withThreads();
	await page.render(<Button room={GUIDE} />);
	expect(q(".room-threads")).toBeNull();
	setHomeMode("rooms");
	await page.render(
		<Button
			room={SCOUT}
			config={{ ...chatsConfig, app: { surface: "app", protocol: "x" } }}
		/>,
	);
	expect(q(".room-threads")).toBeNull();
});
