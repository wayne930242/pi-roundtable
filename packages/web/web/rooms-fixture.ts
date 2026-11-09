import type {
	PromptFrame,
	RoomMessage,
	RoomView,
	ServerFrame,
} from "../src/api-types.ts";
import {
	type Action,
	initialState,
	type RoomsState,
	reduce,
} from "./lib/rooms.ts";

export const GUIDE = "app:agent.guide";
export const SCOUT = "app:agent.scout";

export const READY: ServerFrame = {
	type: "ready",
	protocol: 1,
	principal: "ada",
	name: "Ada",
	uploads: { perMessage: 4, maxBytes: 100 * 1024 * 1024 },
};

export const message = (
	id: number,
	room: string,
	over: Partial<RoomMessage> = {},
): RoomMessage => ({
	id,
	room,
	kind: "agent",
	agent: room.slice(room.indexOf(".") + 1),
	author: "Guide",
	text: `message ${id}`,
	files: [],
	at: "2026-10-28T10:00:00.000Z",
	...over,
});

export const view = (key: string, over: Partial<RoomView> = {}): RoomView => ({
	key,
	kind: "agent",
	name: key.slice(key.indexOf(".") + 1),
	displayName: key.slice(key.indexOf(".") + 1),
	home: key === GUIDE,
	readOnly: false,
	mode: { yolo: false, longRunning: false },
	typing: false,
	stoppable: false,
	...over,
});

export const approval = (
	id: string,
	over: Partial<PromptFrame> = {},
): PromptFrame =>
	({
		id,
		kind: "approval",
		title: "Send it?",
		message: "Send the note",
		purpose: "action",
		...over,
	}) as PromptFrame;

export const run = (actions: Action[], from: RoomsState = initialState()) =>
	actions.reduce(reduce, from);
