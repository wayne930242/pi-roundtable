import { definePlugin } from "pi-roundtable";
import { WEB_APP } from "../src/web-app.ts";

/** A plugin that declares an extension command as safe for chat, to see it in a room's command menu. */
export const commandFixture = definePlugin({
	name: "fixture-commands",
	setup: () => ({
		chatCommands: [{ name: "stats", description: "Show this week's usage" }],
	}),
});

/** A host room kind and a page, as a plugin that sits on the web app would register them. */
export const hostFixture = definePlugin({
	name: "fixture-host",
	requires: [WEB_APP],
	setup: (context) => {
		const web = context.services.get(WEB_APP);
		const all = [
			{ id: "inbox-empty", title: "Empty thread" },
			{ id: "inbox-busy", title: "Support thread" },
		];
		// A member reads one room of the two, as a kind that gives the tiers different rooms would.
		const roomsOf = (viewer: { tier: string }) =>
			viewer.tier === "owner"
				? all
				: all.filter((room) => room.id === "inbox-busy");
		web.registerRoomKind({
			kind: "inbox",
			label: "Inbox",
			icon: "users",
			list: async (viewer) => ({
				rooms: roomsOf(viewer).map((room) => ({
					...room,
					subtitle: "Support",
					picture: { initials: "IN", color: "#336699" },
				})),
			}),
			access: async (viewer, id) =>
				roomsOf(viewer).some((room) => room.id === id)
					? {
							read: true,
							send: viewer.tier === "owner" ? ["note", "turn"] : ["note"],
							act: true,
						}
					: undefined,
			header: async (_viewer, id) => ({
				title: all.find((room) => room.id === id)?.title ?? id,
				fields: [{ label: "Status", value: "Open" }],
				actions: [],
			}),
			send: async () => "accepted",
		});
		web.registerPage({
			id: "mailboxes",
			label: "Mailboxes",
			icon: "megaphone",
			place: "main",
			visible: () => true,
			view: async () => ({
				title: "Mailboxes",
				sections: [{ kind: "markdown", text: "Two mailboxes." }],
			}),
		});
		return {};
	},
});
