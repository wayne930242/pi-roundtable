// What each long-pressed thing offers: the actions of a room row, a message, a message's avatar, a
// card and a file. Each builder reads what it needs when the menu opens, so the labels and the
// toggles are as the page is at that moment.

import type {
	PromptFrame,
	PromptQuestion,
	RoomFile,
	RoomMessage,
} from "../../src/api-types.ts";
import type { MenuItem } from "./action-menu.ts";
import { openAgentSheet } from "./agent-sheet.ts";
import { store } from "./app-store.ts";
import { quoteInto } from "./drafts.ts";
import { translate as t } from "./messages.ts";
import { changeMode } from "./modes.ts";
import { setRoomMuted } from "./mute.ts";
import { askRoomConfirm } from "./room-confirm.ts";
import { fileUrl } from "./rooms.ts";
import { openTeamSheet } from "./team-sheet.ts";
import { toast } from "./toast.ts";

export interface MenuSpec {
	title: string;
	items: MenuItem[];
}

/** Runs `go` once whatever the row sits in has stepped aside: the phone's drawer closes before the page changes. */
export type Leave = (go: () => void) => void;
const now: Leave = (go) => go();

/** Puts text on the clipboard, and says so; a browser that refuses is told to the person. */
export async function copyText(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		toast(t("Copied"));
	} catch {
		toast(t("Could not copy."), "danger");
	}
}

/** Hands something to the system's share sheet; a person who closes it is not an error. */
async function share(data: ShareData): Promise<void> {
	try {
		await navigator.share(data);
	} catch (failure) {
		if (failure instanceof DOMException && failure.name === "AbortError")
			return;
		toast(t("Could not share."), "danger");
	}
}

const canShare = (): boolean => typeof navigator.share === "function";

// ── A room row ───────────────────────────────────────────────────────────────────────────────

/** The actions of an agent's or group's row: the agent's sheet and look, the push, the two modes, and starting over. */
export function roomMenu(
	key: string,
	leave: Leave = now,
): MenuSpec | undefined {
	const room = store.getState().rooms[key];
	const view = room?.view;
	if (!view || view.kind === "thread") return undefined;
	const mode = room.mode;
	const items: MenuItem[] = [];
	if (view.kind === "agent") {
		const name = view.name;
		items.push(
			{
				id: "edit",
				label: t("Edit agent"),
				icon: "profile",
				run: () => leave(() => openAgentSheet(name)),
			},
			{
				id: "look",
				label: t("Change look"),
				icon: "sparkle",
				run: () => leave(() => openAgentSheet(name, { look: true })),
			},
		);
	}
	if (view.kind === "group") {
		const name = view.name;
		items.push({
			id: "edit-group",
			label: t("Edit group"),
			icon: "profile",
			run: () => leave(() => openTeamSheet({ kind: "group", name })),
		});
	}
	items.push({
		id: "notifications",
		label: t("Notifications"),
		icon: view.muted ? "bell-off" : "bell",
		checked: !view.muted,
		run: async () => {
			const muted = view.muted !== true;
			if (!(await setRoomMuted(key, muted))) return;
			toast(
				muted
					? t("Notifications are off for {name}", { name: view.displayName })
					: t("Notifications are on for {name}", { name: view.displayName }),
			);
		},
	});
	if (!view.readOnly)
		items.push(
			{
				id: "yolo",
				label: t("Yolo mode"),
				icon: "bolt",
				tone: "yolo",
				checked: mode.yolo,
				run: () => {
					if (mode.yolo) return changeMode(key, { yolo: false });
					askRoomConfirm({ kind: "yolo", room: key, name: view.displayName });
				},
			},
			{
				id: "long",
				label: t("Long-running mode"),
				icon: "timer",
				tone: "long",
				checked: mode.longRunning,
				run: () => changeMode(key, { longRunning: !mode.longRunning }),
			},
			{
				id: "start-over",
				label: t("Start over"),
				icon: "reset",
				tone: "danger",
				run: () =>
					askRoomConfirm({
						kind: "start-over",
						room: key,
						name: view.displayName,
					}),
			},
		);
	// The coordinator is the team's entry and stays.
	if (!view.readOnly && !view.home)
		items.push({
			id: "archive",
			label: view.kind === "group" ? t("Archive group") : t("Archive agent"),
			icon: "archive",
			tone: "danger",
			run: () =>
				askRoomConfirm({ kind: "archive", room: key, name: view.displayName }),
		});
	return { title: view.displayName, items };
}

/** The "+" menu of the room list and the drawer: a new agent, a new group, and the archive. */
export function addMenu(leave: Leave = now): MenuSpec {
	return {
		title: t("Add"),
		items: [
			{
				id: "new-agent",
				label: t("New agent"),
				icon: "profile",
				run: () => leave(() => openTeamSheet({ kind: "new-agent" })),
			},
			{
				id: "new-group",
				label: t("New group"),
				icon: "rooms",
				run: () => leave(() => openTeamSheet({ kind: "group" })),
			},
			{
				id: "archive-list",
				label: t("Archived"),
				icon: "archive",
				run: () => leave(() => openTeamSheet({ kind: "archive" })),
			},
		],
	};
}

// ── A message ────────────────────────────────────────────────────────────────────────────────

/** The words of a message as they read on the page, without the Markdown marks and the file chips. */
function shownText(source: HTMLElement, fallback: string): string {
	const prose = source.querySelector<HTMLElement>(".bubble > .prose");
	if (!prose) return fallback;
	return (prose.innerText || prose.textContent || fallback).trim();
}

function selectAll(element: Element | null): void {
	if (!element) return;
	const selection = window.getSelection();
	if (!selection) return;
	const range = document.createRange();
	range.selectNodeContents(element);
	selection.removeAllRanges();
	selection.addRange(range);
}

/** What a person has selected inside the message, when they have. */
function selectedIn(source: HTMLElement): string {
	const selection = window.getSelection();
	if (!selection || selection.isCollapsed) return "";
	const inside =
		selection.anchorNode && source.contains(selection.anchorNode)
			? selection.toString()
			: "";
	return inside.trim();
}

/** The actions of a stored message; `quotable` is false in a room nobody can write in. */
export function messageMenu(
	message: RoomMessage,
	source: HTMLElement,
	quotable: boolean,
): MenuSpec {
	const items: MenuItem[] = [
		{
			id: "copy",
			label: t("Copy"),
			icon: "copy",
			run: () =>
				copyText(selectedIn(source) || shownText(source, message.text)),
		},
		{
			id: "copy-markdown",
			label: t("Copy as Markdown"),
			icon: "notes",
			run: () => copyText(message.text),
		},
	];
	if (quotable)
		items.push({
			id: "quote",
			label: t("Quote reply"),
			icon: "conversations",
			run: () => quoteInto(message.room, message.text),
		});
	items.push({
		id: "select",
		label: t("Select text"),
		icon: "list",
		run: () => selectAll(source.querySelector(".bubble")),
	});
	if (canShare())
		items.push({
			id: "share",
			label: t("Share"),
			icon: "send",
			run: () => share({ text: shownText(source, message.text) }),
		});
	return { title: message.author, items };
}

/** The one action of a message's picture: the agent's sheet. */
export function avatarMenu(agent: string, author: string): MenuSpec {
	return {
		title: author,
		items: [
			{
				id: "profile",
				label: t("Agent profile"),
				icon: "profile",
				run: () => openAgentSheet(agent),
			},
		],
	};
}

// ── A card ───────────────────────────────────────────────────────────────────────────────────

const questionText = (question: PromptQuestion): string[] => [
	question.header
		? `${question.header}: ${question.question}`
		: question.question,
	...question.options.map((option) =>
		option.description
			? `- ${option.label}: ${option.description}`
			: `- ${option.label}`,
	),
];

/** A card as plain text: what it says and, for an approval, what it would run. */
export function cardDetails(frame: PromptFrame): string {
	const lines: string[] = [frame.title];
	switch (frame.kind) {
		case "approval": {
			lines.push("", frame.message);
			const { approval } = frame;
			if (approval) {
				lines.push(
					"",
					`${t("Tool")}: ${approval.tool}`,
					`${t("Action")}: ${approval.action}`,
				);
				if (Object.keys(approval.input).length)
					lines.push(JSON.stringify(approval.input, null, 2));
				for (const file of approval.files ?? []) lines.push(file.path);
			}
			break;
		}
		case "ask":
			lines.push(
				"",
				...questionText({
					question: frame.question,
					options: frame.options,
					multi: frame.multi,
					allowOther: frame.allowOther,
				}),
			);
			break;
		case "questionnaire":
			for (const question of frame.questions)
				lines.push("", ...questionText(question));
			break;
	}
	return lines.join("\n");
}

export function cardMenu(frame: PromptFrame): MenuSpec {
	return {
		title: frame.title,
		items: [
			{
				id: "copy-details",
				label: t("Copy details"),
				icon: "copy",
				run: () => copyText(cardDetails(frame)),
			},
		],
	};
}

// ── A file ───────────────────────────────────────────────────────────────────────────────────

/** Saves the file as the browser's own download would. */
function download(file: RoomFile): void {
	const link = document.createElement("a");
	link.href = fileUrl(file);
	link.download = file.name;
	link.hidden = true;
	document.body.append(link);
	link.click();
	link.remove();
}

/** Shares the file itself where the browser can, and its address where it cannot. */
async function shareFile(file: RoomFile): Promise<void> {
	const url = new URL(fileUrl(file), window.location.href).href;
	if (typeof navigator.canShare === "function") {
		try {
			const response = await fetch(url);
			if (response.ok) {
				const copy = new File([await response.blob()], file.name, {
					type: file.type,
				});
				if (navigator.canShare({ files: [copy] })) {
					await share({ files: [copy], title: file.name });
					return;
				}
			}
		} catch {
			// The address below still goes.
		}
	}
	await share({ title: file.name, url });
}

export function fileMenu(file: RoomFile): MenuSpec {
	const items: MenuItem[] = [
		{
			id: "download",
			label: t("Download"),
			icon: "download",
			run: () => download(file),
		},
	];
	if (canShare())
		items.push({
			id: "share",
			label: t("Share"),
			icon: "send",
			run: () => shareFile(file),
		});
	return { title: file.name, items };
}
