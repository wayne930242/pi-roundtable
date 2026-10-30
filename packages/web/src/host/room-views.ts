import type { ChannelKey } from "pi-roundtable";
import type {
	HostCardView,
	PictureRef,
	ReadMarkView,
	RoomMessage,
} from "../api-types.ts";
import type { FileDir } from "../app/files.ts";
import type {
	HostRoomKind,
	RoomAccess,
	StoredHostCard,
	Viewer,
} from "../web-app.ts";
import { pressable } from "./forms.ts";
import type { RoomReads } from "./reads.ts";

const FILE_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;

/** Throws when a picture is not one the page may draw: a stored file, a person, or initials. */
export function checkPicture(picture: PictureRef): PictureRef {
	const bad = (): never => {
		throw new Error(
			"a picture is a stored file, a principal, or initials with a #rrggbb color; never an outside URL",
		);
	};
	if (typeof picture !== "object" || picture === null) return bad();
	if ("file" in picture)
		return typeof picture.file === "string" && FILE_ID.test(picture.file)
			? { file: picture.file }
			: bad();
	if ("principal" in picture)
		return typeof picture.principal === "string" &&
			picture.principal.length > 0 &&
			picture.principal.length <= 200
			? { principal: picture.principal }
			: bad();
	if ("initials" in picture)
		return typeof picture.initials === "string" &&
			picture.initials.length >= 1 &&
			picture.initials.length <= 4 &&
			typeof picture.color === "string" &&
			COLOR.test(picture.color)
			? { initials: picture.initials, color: picture.color }
			: bad();
	return bad();
}

/**
 * The messages as the page is shown them: a file whose bytes retention deleted is taken out of the
 * message's files and counted in `expiredFiles`, so the page says "file expired" instead of
 * offering a download that answers 404.
 */
export function withExpiredFiles(
	messages: readonly RoomMessage[],
	files: Pick<FileDir, "has">,
): RoomMessage[] {
	return messages.map((message) => {
		if (message.files.length === 0) return message;
		const present = message.files.filter((file) => files.has(file.id));
		const gone = message.files.length - present.length;
		return gone === 0
			? message
			: { ...message, files: present, expiredFiles: gone };
	});
}

/** A host room a key names. */
export interface FoundRoom {
	kind: HostRoomKind;
	id: string;
}

/**
 * The buttons of a host card this viewer may press: none once the card is settled, none without
 * `access.act`, and otherwise the card's own, narrowed by the kind's `buttons` when it has one.
 */
export async function buttonsFor(
	viewer: Viewer,
	found: FoundRoom,
	access: RoomAccess,
	card: StoredHostCard,
): Promise<NonNullable<StoredHostCard["buttons"]>> {
	const all = card.buttons ?? [];
	if (!access.act || !pressable(card) || all.length === 0) return [];
	if (!found.kind.buttons) return all;
	const allowed = new Set(await found.kind.buttons(viewer, found.id, card));
	return all.filter((button) => allowed.has(button.id));
}

/** A host card as one viewer sees it. */
export async function cardView(
	viewer: Viewer,
	found: FoundRoom,
	access: RoomAccess,
	card: StoredHostCard,
): Promise<HostCardView> {
	const buttons = await buttonsFor(viewer, found, access, card);
	return {
		id: card.id,
		room: card.room,
		title: card.title,
		body: card.body,
		...(card.tone ? { tone: card.tone } : {}),
		...(card.state ? { state: card.state } : {}),
		...(card.links?.length
			? { links: card.links.map((link) => ({ ...link })) }
			: {}),
		...(buttons.length
			? { buttons: buttons.map((button) => structuredClone(button)) }
			: {}),
		at: card.createdAt.toISOString(),
		updatedAt: card.updatedAt.toISOString(),
	};
}

/** Where the others have read a room up to, each with a name; the viewer's own mark is left out. */
export async function readsOf(
	reads: Pick<RoomReads, "marks">,
	room: ChannelKey | string,
	viewerPrincipal: string,
	nameOf: (principalId: string) => Promise<string>,
): Promise<ReadMarkView[]> {
	const marks = (await reads.marks(room)).filter(
		(mark) => mark.principalId !== viewerPrincipal,
	);
	return Promise.all(
		marks.map(async (mark) => ({
			principal: mark.principalId,
			name: await nameOf(mark.principalId),
			upTo: mark.upTo,
			at: mark.at,
		})),
	);
}
