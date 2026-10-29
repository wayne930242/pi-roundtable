import { expect, test } from "bun:test";
import type { SQL } from "bun";
import { RoomLayout } from "./layout.ts";

// A reading that spans three SELECTs must see one snapshot, so a change that commits between them is
// seen whole or not at all. The database's behavior is `layout.test.ts`'s; this checks how the read asks for it.
test("the layout is read in one repeatable-read transaction, all three tables in it", async () => {
	const begun: string[] = [];
	const inside: string[] = [];
	const tx = (strings: TemplateStringsArray): Promise<unknown[]> => {
		const text = strings.join("?");
		inside.push(/FROM (\w+)/.exec(text)?.[1] ?? text);
		if (text.includes("web_room_folders"))
			return Promise.resolve([{ id: "folder.1", name: "Work" }]);
		if (text.includes("web_room_folder_rooms"))
			return Promise.resolve([{ room: "app:agent.scout", folder: "folder.1" }]);
		return Promise.resolve([{ room: "app:agent.build" }]);
	};
	const sql = {
		begin: async (
			options: string | ((tx: unknown) => Promise<unknown>),
			run?: (tx: unknown) => Promise<unknown>,
		) => {
			if (typeof options !== "string")
				throw new Error("the read must name its isolation");
			begun.push(options);
			return run?.(tx);
		},
	} as unknown as SQL;
	const view = await new RoomLayout(sql).view();
	expect(begun).toHaveLength(1);
	expect(begun[0]).toMatch(/isolation level repeatable read/i);
	expect(inside).toEqual([
		"web_room_folders",
		"web_room_folder_rooms",
		"web_room_pins",
	]);
	expect(view).toEqual({
		pins: ["app:agent.build"],
		folders: [{ id: "folder.1", name: "Work", rooms: ["app:agent.scout"] }],
	});
});
