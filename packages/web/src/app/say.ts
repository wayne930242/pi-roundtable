import type { ChannelKey, InboundMessage } from "pi-roundtable";
import { PluginError } from "pi-roundtable";
import type { RoomFile, RoomMessage } from "../api-types.ts";
import type { Answerer } from "./desk.ts";
import { coreMessageId } from "./queued-delivery.ts";
import type { AppSocket, Sockets } from "./sockets.ts";
import type { AppSurface } from "./surface.ts";
import type { Uploads } from "./uploads.ts";

/** What an owner's message in a room is taken with. */
export interface SayDeps {
	surface: Pick<AppSurface, "publish" | "deliver">;
	uploads: Pick<Uploads, "use" | "refOf">;
	sockets: Pick<Sockets, "deliver">;
}

/**
 * Keeps an owner's internal note in a room: stored and shown to the other readers, and given to
 * no one else. It does not reach the host, so the agent runs no turn, the note is not in its
 * conversation, and nothing about the room reads as asked.
 */
export async function keepNote(
	deps: SayDeps,
	connection: AppSocket,
	who: Answerer,
	room: ChannelKey,
	id: string,
	text: string,
	files: readonly RoomFile[],
): Promise<void> {
	const { surface, uploads, sockets } = deps;
	const message = await surface.publish(
		{
			room,
			kind: "owner",
			principalId: who.principalId,
			author: who.name,
			text,
			files: [...files],
			note: true,
		},
		connection,
	);
	uploads.use(files.map((file) => file.id));
	sockets.deliver({ type: "accepted", id, room, message }, { connection });
}

/**
 * Takes a message of the owner into a room: stores it, shows it to the other sockets, and
 * hands it to the host as the owner's. `files` are uploads the sender claimed, which move to
 * the stored files once the message is stored. `stored` hears the stored message, and is waited for, before the
 * host does, so a reply cannot overtake it.
 */
export async function say(
	deps: Pick<SayDeps, "surface" | "uploads">,
	room: ChannelKey,
	who: Answerer,
	text: string,
	files: readonly RoomFile[],
	except?: AppSocket,
	stored?: (message: RoomMessage) => void | Promise<void>,
): Promise<void> {
	const { surface, uploads } = deps;
	if (!who.actor)
		throw new PluginError(
			"a message needs the actor its sender's credential vouched for",
		);
	const message = await surface.publish(
		{
			room,
			kind: "owner",
			principalId: who.principalId,
			author: who.name,
			text,
			files: [...files],
		},
		except,
	);
	uploads.use(files.map((file) => file.id));
	await stored?.(message);
	const inbound: InboundMessage = {
		channel: room,
		messageId: coreMessageId(message.id),
		actor: who.actor,
		authorId: who.principalId,
		authorName: who.name,
		authorIsBot: false,
		isDirect: false,
		mentionsBot: false,
		repliesToBot: false,
		text,
		attachments: files.map((file) => uploads.refOf(file)),
	};
	surface.deliver(inbound);
}
