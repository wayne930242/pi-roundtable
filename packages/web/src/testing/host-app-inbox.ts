import {
	type ChannelKey,
	type ConversationTurns,
	definePlugin,
	IDENTITY,
	type InboundMessage,
	type Speaker,
} from "pi-roundtable";
import {
	type ActionResult,
	type HostRoomKind,
	type RoomAccess,
	type Viewer,
	WEB_APP,
	type WebApp,
} from "../web-app.ts";

export const RUN = Math.random().toString(36).slice(2, 8);
export const ROOM_A_ID = `a${RUN}room`;
export const ROOM_B_ID = `b${RUN}room`;
/** The agent of this run: its room, and every person's cursor in it, starts clean in the shared database. */
export const GUIDE = `guide${RUN}`;
export const AGENT_ROOM = `app:agent.${GUIDE}` as ChannelKey;
export const ROOM_A = `app:inbox.${ROOM_A_ID}` as ChannelKey;
export const ROOM_B = `app:inbox.${ROOM_B_ID}` as ChannelKey;

export const PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
]);

/** What the fixture "support inbox" host remembers of what the app asked it. */
export interface Inbox {
	/** Who reads which room, and what they may do there. */
	grants: Map<string, Map<string, RoomAccess>>;
	admitted: InboundMessage[];
	sends: { who: string; id: string; mode: string; text: string }[];
	acts: {
		who: string;
		id: string;
		action: string;
		card?: string;
		input: object;
	}[];
	pageActs: { who: string; action: string; input: object }[];
	/** What the claim does with a turn it was given. */
	script:
		| ((message: InboundMessage, speaker: Speaker | undefined) => Promise<void>)
		| undefined;
	/** Refuses the next send. */
	refuse: string | undefined;
	/** When set, `access` answers only for viewers who carry this role. */
	needRole: string | undefined;
	web: WebApp | undefined;
	/** Runs a turn on the host's runtime, which shows typing on the room; set when the plugin is set up. */
	turns: ConversationTurns | undefined;
	/** While set, the runtime's turn waits for it. */
	hold: Promise<void> | undefined;
}

export const READ_WRITE: RoomAccess = {
	read: true,
	send: ["note", "turn"],
	act: true,
};

export function inbox(): Inbox {
	return {
		grants: new Map(),
		admitted: [],
		sends: [],
		acts: [],
		pageActs: [],
		script: undefined,
		refuse: undefined,
		needRole: undefined,
		web: undefined,
		turns: undefined,
		hold: undefined,
	};
}

export function inboxPlugin(state: Inbox) {
	return definePlugin({
		name: "inbox-host",
		requires: [WEB_APP, IDENTITY],
		setup: (context) => {
			const web = context.services.get(WEB_APP);
			state.web = web;
			state.turns = context.turns;
			const principals = new Map<string, string>();
			const nameOf = (viewer: Viewer) => viewer.name.toLowerCase();
			const kind: HostRoomKind = {
				kind: "inbox",
				label: "Inbox",
				icon: "chat",
				// Padding is trimmed, text only is kept, and a label is cut to forty characters.
				sendWording: {
					note: { placeholder: "  Write to the team…  " },
					turn: {
						label: "@Atlas".padEnd(60, "x"),
						placeholder: 42 as unknown as string,
					},
				},
				list: async (viewer) => {
					const mine = state.grants.get(viewer.principalId);
					if (!mine) return undefined;
					return {
						rooms: [...mine.keys()].map((id) => ({
							id,
							title: `Thread ${id}`,
							subtitle: "Support",
							picture: { initials: "TH", color: "#336699" },
							unread: 99,
						})),
					};
				},
				access: async (viewer, id) =>
					state.needRole && !viewer.roles.includes(state.needRole)
						? undefined
						: state.grants.get(viewer.principalId)?.get(id),
				header: async (_viewer, id) => ({
					title: `Thread ${id}`,
					fields: [{ label: "Status", value: "Open" }],
					actions: [
						{
							id: "assign",
							label: "Assign",
							form: {
								title: "Assign",
								submit: "Assign",
								fields: [
									{
										name: "owner",
										label: "Owner",
										type: "select",
										required: true,
										options: [
											{ value: "ada", label: "Ada" },
											{ value: "mel", label: "Mel" },
										],
									},
								],
							},
						},
					],
					banner: { tone: "warn", text: "Nobody owns this thread" },
				}),
				send: async (viewer, id, message) => {
					state.sends.push({
						who: nameOf(viewer),
						id,
						mode: message.mode,
						text: message.text,
					});
					if (state.refuse) return { refused: state.refuse };
					return "accepted";
				},
				act: async (viewer, id, action, input): Promise<ActionResult> => {
					state.acts.push({
						who: nameOf(viewer),
						id,
						action: action.action,
						...(action.card ? { card: action.card } : {}),
						input,
					});
					return {
						ok: true,
						notice: "Done",
						open: { room: ROOM_B, message: 7 },
					};
				},
				buttons: async (viewer, _id, card) =>
					nameOf(viewer) === "mel"
						? (card.buttons ?? [])
								.filter((button) => button.id === "reply")
								.map((b) => b.id)
						: (card.buttons ?? []).map((button) => button.id),
			};
			web.registerRoomKind(kind);
			web.registerPage({
				id: "mailboxes",
				label: "Mailboxes",
				icon: "megaphone",
				place: "main",
				visible: (viewer) => viewer.tier === "owner",
				view: async (_viewer, query) => ({
					title: "Mailboxes",
					sections: [
						{ kind: "markdown", text: `filter: ${query.q ?? ""}` },
						{
							kind: "form",
							action: "connect",
							form: {
								title: "Connect",
								submit: "Connect",
								fields: [
									{
										name: "address",
										label: "Address",
										type: "text",
										required: true,
									},
								],
							},
						},
					],
				}),
				act: async (viewer, action, input) => {
					state.pageActs.push({ who: nameOf(viewer), action, input });
					return { ok: true, notice: "Connected" };
				},
			});
			void principals;
			return {
				channels: [
					{
						name: "inbox",
						priority: 10,
						owns: (channel: ChannelKey) => channel.startsWith("app:inbox."),
						admit: (message: InboundMessage) => {
							state.admitted.push(message);
							return {
								kind: "turn" as const,
								run: async () => state.script?.(message, message.speaker),
								failure: "an inbox turn failed",
							};
						},
						startFresh: async () => "inbox",
					},
				],
			};
		},
	});
}
