import {
	type PlaceAuthor,
	type PlacePort,
	type PlaceProvider,
	roomKey,
	roomRef,
} from "../contract/places.ts";
import type { ChatSurface, SurfacePort } from "../contract/surface.ts";
import { channelKey } from "../contract/surface.ts";
import type { PostAuthor } from "../domain/conversation.ts";

/** What the host collected for the port: the surfaces and the providers plugins contributed, each in contribution order. */
export interface LinkedPlaces {
	surfaces: readonly ChatSurface[];
	providers: readonly PlaceProvider[];
}

/** An author as a surface shows it: the name and the agent's own name, without the avatar a webhook needs. */
const asPostAuthor = (author: PlaceAuthor): PostAuthor => ({
	name: author.name,
	...(author.agent === undefined ? {} : { agent: author.agent }),
});

/**
 * The provider a surface that hosts agent rooms gets when no plugin contributes one: its places
 * are the rooms `<surface>:agent.<name>` and `<surface>:group.<name>`, derived from the name, and
 * it posts through the surface's own `sendReply` and `interim` with the agent as author.
 */
export function derivedPlaces(
	surface: string,
	surfaces: SurfacePort,
): PlaceProvider {
	return {
		surface,
		storage: "derived",
		key: (ref) => roomKey(surface, ref),
		placeOf: (key) => roomRef(key, surface),
		post: (key, post) =>
			surfaces.sendReply(
				// A thread of the room's surface is a channel of that surface, and speaks there.
				post.thread === undefined ? key : channelKey(surface, post.thread),
				{
					...(post.thinking ? { thinking: post.thinking } : {}),
					chunks: post.chunks,
					...(post.files?.length ? { files: post.files } : {}),
					author: asPostAuthor(post.author),
					...(post.failed ? { failed: post.failed } : {}),
					...(post.intercom ? { intercom: post.intercom } : {}),
				},
			),
		interim: (key, author) => surfaces.interim(key, asPostAuthor(author)),
	};
}

/**
 * The port over the place providers, each chosen by a surface or by the prefix of a channel's key.
 * `linked` gives the surfaces and contributed providers once every plugin is set up and throws
 * NotLinkedError before. A surface that hosts agent rooms and has no contributed provider gets a
 * derived one. "Auto" order is the stored providers in contribution order, then the derived ones
 * in surface order.
 */
export function placePort(
	linked: () => LinkedPlaces,
	surfaces: SurfacePort,
): PlacePort {
	let cached: { all: PlaceProvider[]; stored: PlaceProvider[] } | undefined;
	const read = () => {
		if (cached) return cached;
		const { surfaces: registered, providers } = linked();
		const stored = providers.filter((p) => p.storage === "stored");
		const derived = registered.flatMap((surface) => {
			const own = providers.find(
				(p) => p.surface === surface.surface && p.storage === "derived",
			);
			if (own) return [own];
			const served = providers.some((p) => p.surface === surface.surface);
			return surface.agentRooms === true && !served
				? [derivedPlaces(surface.surface, surfaces)]
				: [];
		});
		cached = { all: [...stored, ...derived], stored };
		return cached;
	};
	return {
		of: (surfaceOrKey) => {
			const at = surfaceOrKey.indexOf(":");
			if (at === 0) return undefined;
			const surface = at < 0 ? surfaceOrKey : surfaceOrKey.slice(0, at);
			return read().all.find((p) => p.surface === surface);
		},
		stored: () => read().stored,
		all: () => read().all,
	};
}
