import { useRef } from "react";
import { closeAgentSheet } from "../lib/agent-sheet.ts";
import { api } from "../lib/api.ts";
import { plural, translate as t } from "../lib/messages.ts";
import {
	clearRoomConfirm,
	type RoomConfirm,
	useRoomConfirm,
} from "../lib/room-confirm.ts";
import { currentRoute, navigate } from "../lib/router.ts";
import { refreshRooms, teamApi } from "../lib/team-api.ts";
import { toast } from "../lib/toast.ts";
import { Confirm } from "./confirm.tsx";
import { FolderDialogHost } from "./folder-dialogs.tsx";

interface ConfirmProps {
	open: boolean;
	room: string;
	name: string;
	restoreFocus?: (() => HTMLElement | null) | undefined;
	onClose(): void;
}

/** Turning yolo mode on: what it does, and what it still asks about. */
export function YoloConfirm(props: ConfirmProps) {
	return (
		<Confirm
			open={props.open}
			title={t("Turn on yolo mode?")}
			confirmLabel={t("Turn on yolo mode")}
			tone="yolo"
			{...(props.restoreFocus ? { restoreFocus: props.restoreFocus } : {})}
			onClose={props.onClose}
			onConfirm={async () => {
				await api.setMode(props.room, { yolo: true });
			}}
		>
			<p>
				{t(
					"In this room, the knight's held actions are approved for you, without a card, as soon as they come up.",
				)}
			</p>
			<p>
				{t(
					"Risky classes still ask: running as another user, deleting files, force pushes, disk, service and firewall changes, and anything that names its own approvers. The host can add more.",
				)}
			</p>
			<p>
				{t(
					"Every approval it makes is written into the conversation, and a banner stays up while yolo mode is on.",
				)}
			</p>
		</Confirm>
	);
}

/** Archiving the conversation to begin a new one. */
export function StartOverConfirm(props: ConfirmProps) {
	return (
		<Confirm
			open={props.open}
			title={t("Start over {name}?", { name: props.name })}
			confirmLabel={t("Start over")}
			tone="danger"
			{...(props.restoreFocus ? { restoreFocus: props.restoreFocus } : {})}
			onClose={props.onClose}
			onConfirm={async () => {
				await api.startRoomOver(props.room);
			}}
		>
			<p>
				{t(
					"The current conversation is archived and the next message begins a new one. Long-term memory is kept. A turn that is running finishes first.",
				)}
			</p>
		</Confirm>
	);
}

/** Archiving an agent or group: it stops answering, and can be restored from the archive. */
export function ArchiveConfirm(props: ConfirmProps) {
	return (
		<Confirm
			open={props.open}
			title={t("Archive {name}?", { name: props.name })}
			confirmLabel={t("Archive")}
			tone="danger"
			{...(props.restoreFocus ? { restoreFocus: props.restoreFocus } : {})}
			onClose={props.onClose}
			onConfirm={async () => {
				// The room key is `<surface>:agent.<name>` or `<surface>:group.<name>`.
				const at = props.room.indexOf(".");
				const name = props.room.slice(at + 1);
				if (props.room.slice(0, at).endsWith(":group"))
					await teamApi.archiveGroup(name);
				else await teamApi.archiveAgent(name);
				closeAgentSheet();
				await refreshRooms();
				toast(t("Archived {name}.", { name: props.name }));
				// A room that is archived is no room to stay in.
				if (currentRoute().key === props.room) navigate("rooms");
			}}
		>
			<p>
				{t(
					"{name} stops answering and its schedules are cancelled. A group loses it as a member. The history is kept, and Archived in the room list restores it.",
					{ name: props.name },
				)}
			</p>
		</Confirm>
	);
}

/** Clearing many finished threads at once: they leave the list for every owner, and Undo brings them back. */
export function ClearThreadsConfirm(
	props: ConfirmProps & { threads: readonly string[] },
) {
	return (
		<Confirm
			open={props.open}
			title={plural(
				props.threads.length,
				"Clear {count} finished thread?",
				"Clear {count} finished threads?",
			)}
			confirmLabel={t("Clear all finished")}
			tone="danger"
			{...(props.restoreFocus ? { restoreFocus: props.restoreFocus } : {})}
			onClose={props.onClose}
			onConfirm={async () => {
				const { dismissThreads } = await import("../lib/thread-actions.ts");
				await dismissThreads(props.room || undefined, props.threads);
			}}
		>
			<p>
				{t(
					"They leave the list for every owner. Each one stays readable by its address, and Undo brings them back.",
				)}
			</p>
		</Confirm>
	);
}

/** Draws the question that `askRoomConfirm` asks, wherever in the page it was asked, and the folder dialogs. */
export function RoomConfirmHost() {
	return (
		<>
			<RoomConfirms />
			<FolderDialogHost />
		</>
	);
}

function RoomConfirms() {
	const ask = useRoomConfirm();
	const last = useRef<RoomConfirm | undefined>(undefined);
	if (ask) last.current = ask;
	const shown = last.current;
	if (!shown) return null;
	const common = {
		room: shown.room,
		name: shown.name,
		restoreFocus: shown.restoreFocus,
		onClose: clearRoomConfirm,
	};
	return (
		<>
			<YoloConfirm open={ask?.kind === "yolo"} {...common} />
			<StartOverConfirm open={ask?.kind === "start-over"} {...common} />
			<ArchiveConfirm open={ask?.kind === "archive"} {...common} />
			<ClearThreadsConfirm
				open={ask?.kind === "clear-threads"}
				{...common}
				threads={shown.threads ?? []}
			/>
		</>
	);
}
