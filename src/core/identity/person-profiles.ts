import type { SQL } from "bun";
import { IdentityError } from "../domain/errors.ts";
import type { Logger } from "../log.ts";
import { ProfileChoices } from "./profile-choices.ts";
import { cleanName, ExpiringMap } from "./profile-memory.ts";
import {
	fetchPicture,
	type Picture,
	pictureResponse,
} from "./profile-picture.ts";
import type {
	PersonDisplay,
	PersonProfiles,
	ProfileRules,
	ProfileSource,
} from "./profiles.ts";

const HOUR_MS = 60 * 60_000;
const MISS_MS = 10 * 60_000;
const CHOICE_MS = 30_000;
const FETCH_BUDGET_MS = 2_000;
const PICTURES_MAX_BYTES = 32 * 1024 * 1024;

/** What a person's linked identities and display name are, as the directory reads them. */
export interface ProfileLinks {
	/** The providers and subjects linked to the principal. */
	identities(
		principalId: string,
	): Promise<readonly { provider: string; subject: string }[]>;
	/** The principal's own display name; undefined for an unknown principal. */
	displayName(principalId: string): Promise<string | undefined>;
}

export interface PersonProfilesOptions {
	sql: SQL;
	links: ProfileLinks;
	rules: ProfileRules;
	logger: Logger;
	/** The clock, in milliseconds; a test gives its own. */
	now?: () => number;
	/** What a source's fetch may take; default two seconds. */
	fetchBudgetMs?: number;
	/** Replaces `fetch` for pictures, for a test. */
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

interface Fetched {
	name?: string;
	pictureUrl?: string;
}

/** A call that did not finish in its budget. */
class Slow extends Error {}

const sleepFor = (ms: number): { done: Promise<never>; cancel(): void } => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const done = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Slow("budget")), ms);
	});
	return { done, cancel: () => clearTimeout(timer) };
};

/**
 * The directory behind `PROFILES`: sources, the names they and the sessions report (memory only,
 * an hour at most), each person's stored choice, and the picture proxy. Names reach
 * `Speaker.name` only through `modelName`, which the identity service calls, and only for a
 * provider the host lists in `profiles.modelVisible`.
 */
export class PersonDirectory implements PersonProfiles {
	readonly #sources = new Map<string, ProfileSource>();
	readonly #observed = new ExpiringMap<string>(10_000);
	readonly #fetched = new ExpiringMap<Fetched | null>(10_000);
	readonly #pending = new Map<string, Promise<Fetched | null>>();
	readonly #pictures = new ExpiringMap<Picture | null>(512);
	readonly #choices: ProfileChoices;
	readonly #chosen = new ExpiringMap<string | null>(10_000);
	readonly #links: ProfileLinks;
	readonly #prefer: readonly string[];
	readonly #modelVisible: ReadonlySet<string>;
	readonly #logger: Logger;
	readonly #now: () => number;
	readonly #budget: number;
	readonly #fetch: PersonProfilesOptions["fetch"];

	constructor(options: PersonProfilesOptions) {
		this.#choices = new ProfileChoices(options.sql);
		this.#links = options.links;
		this.#prefer = options.rules.prefer;
		this.#modelVisible = new Set(options.rules.modelVisible);
		this.#logger = options.logger;
		this.#now = options.now ?? Date.now;
		this.#budget = options.fetchBudgetMs ?? FETCH_BUDGET_MS;
		this.#fetch = options.fetch;
	}

	register(source: ProfileSource): void {
		if (source.provider.trim() === "")
			throw new IdentityError("a profile source needs a provider");
		if (this.#sources.has(source.provider))
			throw new IdentityError(
				`a profile source for ${source.provider} is already registered`,
			);
		this.#sources.set(source.provider, source);
	}

	sources(): readonly { provider: string; label: string }[] {
		return [...this.#sources.values()].map(({ provider, label }) => ({
			provider,
			label,
		}));
	}

	observed(principalId: string, provider: string, name: string): void {
		const clean = cleanName(name);
		if (clean)
			this.#observed.set(
				`${principalId}\0${provider}`,
				clean,
				this.#now(),
				HOUR_MS,
			);
	}

	async sourceOf(principalId: string): Promise<string | undefined> {
		const linked = new Set(
			(await this.#links.identities(principalId)).map((link) => link.provider),
		);
		const chosen = await this.#choice(principalId);
		if (chosen && linked.has(chosen)) return chosen;
		return this.#prefer.find((provider) => linked.has(provider));
	}

	async choose(principalId: string, provider: string | null): Promise<void> {
		if ((await this.#links.displayName(principalId)) === undefined)
			throw new IdentityError(`there is no principal ${principalId}`);
		if (provider === null) await this.#choices.clear(principalId);
		else {
			const linked = (await this.#links.identities(principalId)).some(
				(link) => link.provider === provider,
			);
			if (!linked)
				throw new IdentityError(
					`${provider} is not linked to principal ${principalId}, so it cannot name them`,
				);
			await this.#choices.set(principalId, provider);
		}
		this.#chosen.delete(principalId);
	}

	async of(principalId: string): Promise<PersonDisplay> {
		const provider = await this.sourceOf(principalId);
		const profile = provider
			? await this.#profile(principalId, provider)
			: undefined;
		if (provider && profile?.name)
			return {
				name: profile.name,
				source: provider,
				picture: profile.pictureUrl !== undefined,
			};
		return {
			name: (await this.#links.displayName(principalId)) ?? principalId,
			picture: false,
		};
	}

	async picture(principalId: string): Promise<Response | undefined> {
		const provider = await this.sourceOf(principalId);
		const source = provider ? this.#sources.get(provider) : undefined;
		if (!provider || !source) return undefined;
		const address = (await this.#profile(principalId, provider))?.pictureUrl;
		if (!address) return undefined;
		const now = this.#now();
		let picture = this.#pictures.get(address, now);
		if (picture === undefined) {
			picture =
				(await fetchPicture(address, source.pictureHosts, this.#fetch)) ?? null;
			const at = this.#now();
			this.#pictures.set(address, picture, at, picture ? HOUR_MS : MISS_MS);
			while (
				this.#pictures.weigh((held) => held?.bytes.byteLength ?? 0) >
				PICTURES_MAX_BYTES
			)
				if (!this.#pictures.evictOldest()) break;
		}
		return picture ? pictureResponse(picture) : undefined;
	}

	/**
	 * The name `Speaker.name` takes for the principal: their source's name when the host lists its
	 * provider in `profiles.modelVisible`, else undefined. Core-internal: `PROFILES` does not carry it.
	 */
	async modelName(principalId: string): Promise<string | undefined> {
		if (this.#modelVisible.size === 0) return undefined;
		const provider = await this.sourceOf(principalId);
		if (!provider || !this.#modelVisible.has(provider)) return undefined;
		return (await this.#profile(principalId, provider))?.name;
	}

	async #choice(principalId: string): Promise<string | undefined> {
		const now = this.#now();
		const held = this.#chosen.get(principalId, now);
		if (held !== undefined) return held ?? undefined;
		const stored = (await this.#choices.get(principalId)) ?? null;
		this.#chosen.set(principalId, stored, now, CHOICE_MS);
		return stored ?? undefined;
	}

	/** The name a session reported or the source fetched for this provider, and the picture address. */
	async #profile(
		principalId: string,
		provider: string,
	): Promise<Fetched | undefined> {
		const observed = this.#observed.get(
			`${principalId}\0${provider}`,
			this.#now(),
		);
		const source = this.#sources.get(provider);
		const link = (await this.#links.identities(principalId)).find(
			(candidate) => candidate.provider === provider,
		);
		const fetched =
			source && link ? await this.#fetchOnce(source, link.subject) : null;
		const name = observed ?? fetched?.name;
		if (!name) return undefined;
		return {
			name,
			...(fetched?.pictureUrl ? { pictureUrl: fetched.pictureUrl } : {}),
		};
	}

	#fetchOnce(source: ProfileSource, subject: string): Promise<Fetched | null> {
		const key = `${source.provider}\0${subject}`;
		const held = this.#fetched.get(key, this.#now());
		if (held !== undefined) return Promise.resolve(held);
		const running = this.#pending.get(key);
		if (running) return running;
		const call = this.#ask(source, subject).then((found) => {
			this.#fetched.set(key, found, this.#now(), found ? HOUR_MS : MISS_MS);
			this.#pending.delete(key);
			return found;
		});
		this.#pending.set(key, call);
		return call;
	}

	/** One fetch inside its budget; a miss, a failure and a timeout all read as nothing. */
	async #ask(source: ProfileSource, subject: string): Promise<Fetched | null> {
		const controller = new AbortController();
		const budget = sleepFor(this.#budget);
		try {
			const found = await Promise.race([
				source.fetch(subject, controller.signal),
				budget.done,
			]);
			const name = cleanName(found?.name);
			return found && (name || found.pictureUrl)
				? {
						...(name ? { name } : {}),
						...(found.pictureUrl ? { pictureUrl: found.pictureUrl } : {}),
					}
				: null;
		} catch (error) {
			// Only the provider and the kind of failure: no subject, no name, no address.
			this.#logger.warn(
				{ provider: source.provider, slow: error instanceof Slow },
				"a profile source gave no profile",
			);
			return null;
		} finally {
			budget.cancel();
			controller.abort();
		}
	}
}
