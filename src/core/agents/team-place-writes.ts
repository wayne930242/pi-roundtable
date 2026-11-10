import type { PlaceProvider, PlaceRef, PlaceSpec } from "../contract/places.ts";
import type { ChannelKey } from "../domain/conversation.ts";
import type { Agent } from "./agent-store.ts";
import type { TeamContext } from "./team-options.ts";

/** A place made or brought back on a surface, by its id there. */
export interface MadePlace {
	surface: string;
	id: string;
}

/** What a place is made or kept for: its owner, and the texts the surface shows it under. */
export interface PlaceWish extends PlaceRef {
	displayName: string;
	/** An agent's display name; a group's members and host on one line. */
	topic: string;
	/** What the creating tool was given for the providers' own arguments, such as `category`. */
	hints?: Readonly<Record<string, string>>;
}

/** Where a temp knight's place goes: under its parent's place, on the surface it was made from. */
export interface HelperOrigin {
	parent: Agent;
	/** The conversation it was made from; absent, every surface that has a place for the parent. */
	origin?: string | undefined;
}

const specOf = (wish: PlaceWish): PlaceSpec => ({
	kind: wish.kind,
	name: wish.name,
	displayName: wish.displayName,
	topic: wish.topic,
	...(wish.hints ? { hints: wish.hints } : {}),
});

/**
 * The team's writes to the places of its agents and groups, through the stored place providers
 * that make them: `ensure` makes a place or brings an archived one back, `remove` keeps it where
 * nobody answers, and `describe` writes a group's topic. A provider that does not make places
 * (a derived one's rooms exist with the name) is left out; so is one the owner has no place on.
 */
export class TeamPlaceWrites {
	readonly #ctx: TeamContext;

	constructor(ctx: TeamContext) {
		this.#ctx = ctx;
	}

	/** The stored providers that make places, in contribution order. */
	#makers(): PlaceProvider[] {
		return this.#ctx.options.places
			.stored()
			.filter((provider) => provider.ensure !== undefined);
	}

	/**
	 * Makes the places of a new agent or group, one on each provider that makes them, or, for a
	 * temp knight, under its parent's place on each surface it was made from. Nothing is recorded:
	 * `record` does that once the owner exists.
	 */
	async make(wish: PlaceWish, under?: HelperOrigin): Promise<MadePlace[]> {
		const made: MadePlace[] = [];
		for (const provider of this.#makers()) {
			const colon = under?.origin?.indexOf(":") ?? -1;
			const from = colon > 0 ? under?.origin?.slice(0, colon) : undefined;
			if (from && from !== provider.surface) continue;
			const place = await this.makeOn(provider.surface, wish, under?.parent);
			if (place) made.push(place);
		}
		return made;
	}

	/**
	 * Makes the owner's place on one surface, or brings back the one it has there; for a temp
	 * knight, under its parent's place on that surface. None when the surface makes no places or the
	 * parent has none there. Nothing is recorded.
	 */
	async makeOn(
		surface: string,
		wish: PlaceWish,
		parent?: Agent,
	): Promise<MadePlace | undefined> {
		const { places } = this.#ctx.options;
		const provider = places.providerOf(surface);
		if (provider?.storage !== "stored" || !provider.ensure) return undefined;
		const spec = specOf(wish);
		if (parent) {
			const above = places.idOf(
				{ kind: "agent", name: parent.name },
				provider.surface,
			);
			if (above === undefined) return undefined;
			spec.parent = above;
		}
		const existing = places.idOf(wish, provider.surface);
		if (existing !== undefined) spec.existing = existing;
		return { surface, id: await provider.ensure(spec) };
	}

	/** Records the places an owner now has, in place of any it had on those surfaces. */
	async record(ref: PlaceRef, made: readonly MadePlace[]): Promise<void> {
		const { store } = this.#ctx.options;
		for (const place of made)
			await store.setPlace(ref.kind, ref.name, place.surface, place.id);
	}

	/**
	 * Brings an owner's archived places back, each under its own id (a place deleted meanwhile is
	 * made again), and makes one for an agent that had none on a surface that makes them; a group
	 * is given none it never had. Recorded by the caller.
	 */
	async bringBack(wish: PlaceWish): Promise<MadePlace[]> {
		const { places } = this.#ctx.options;
		const made: MadePlace[] = [];
		for (const provider of this.#makers()) {
			if (
				wish.kind === "group" &&
				places.idOf(wish, provider.surface) === undefined
			)
				continue;
			const place = await this.makeOn(provider.surface, wish);
			if (place) made.push(place);
		}
		return made;
	}

	/**
	 * Keeps an archived owner's places where nobody answers, with their history; says, for the
	 * archive tool's answer, what each provider did. A provider that fails is logged, and the rest
	 * go on.
	 */
	async keep(wish: PlaceWish, helper: boolean): Promise<string> {
		const { places, logger } = this.#ctx.options;
		let said = "";
		for (const provider of places.stored()) {
			const id = places.idOf(wish, provider.surface);
			if (id === undefined || !provider.remove) continue;
			try {
				const line = await provider.remove(id, { ...specOf(wish), helper });
				// A line that brings no separator of its own (a provider of the first contract) gets one.
				if (line) said += /^[;,]/.test(line) ? line : `; ${line}`;
			} catch (error) {
				logger.warn(
					{ name: wish.name, surface: provider.surface, err: error },
					"archived place not kept",
				);
			}
		}
		return said;
	}

	/** Closes the places made for an owner that was never recorded, logging a failure. */
	async discard(wish: PlaceWish, made: readonly MadePlace[]): Promise<void> {
		const { places, logger } = this.#ctx.options;
		for (const place of made)
			await places
				.providerOf(place.surface)
				?.remove?.(place.id, { ...specOf(wish), helper: true })
				.catch((err: unknown) =>
					logger.warn({ err }, "orphan place not closed"),
				);
	}

	/** Writes a group's topic on every surface that has a place for it, without waiting. */
	describe(wish: PlaceWish): void {
		const { places, logger } = this.#ctx.options;
		for (const provider of places.stored()) {
			const id = places.idOf(wish, provider.surface);
			if (id === undefined || !provider.describe) continue;
			provider
				.describe(id, wish.topic)
				.catch((error: unknown) =>
					logger.warn(
						{ group: wish.name, err: error },
						"group topic not updated",
					),
				);
		}
	}

	/** How the model names the made places in text, such as `<#id>`. */
	mentions(ref: PlaceRef, made: readonly MadePlace[]): string {
		const { places } = this.#ctx.options;
		return made
			.flatMap((place) => {
				const key: ChannelKey | undefined = places
					.providerOf(place.surface)
					?.key(ref, place.id);
				return key === undefined ? [] : [places.mention(key)];
			})
			.join(", ");
	}
}
