import type { Tier } from "../speakers.ts";
import type {
	IdentityRef,
	LinkSource,
	NewPrincipal,
	PrincipalStore,
	Pronouns,
	RoleSource,
} from "./principal-store.ts";

/** How long a read of the store is reused; a change another process makes is seen after it. */
export const CACHE_MS = 30_000;

/**
 * The store with its reads reused for `CACHE_MS`; any write through it drops them all, so this
 * process sees its own changes at once. Recording a principal as seen drops only theirs.
 */
export class CachingPrincipalStore implements PrincipalStore {
	readonly #store: PrincipalStore;
	readonly #now: () => number;
	readonly #reads = new Map<string, { at: number; value: Promise<unknown> }>();

	constructor(store: PrincipalStore, now: () => number) {
		this.#store = store;
		this.#now = now;
	}

	#cached<T>(key: string, read: () => Promise<T>): Promise<T> {
		const now = this.#now();
		const hit = this.#reads.get(key);
		if (hit && now - hit.at < CACHE_MS) return hit.value as Promise<T>;
		const value = read();
		this.#reads.set(key, { at: now, value });
		value.catch(() => this.#reads.delete(key));
		return value;
	}

	async #write<T>(write: Promise<T>): Promise<T> {
		try {
			return await write;
		} finally {
			this.#reads.clear();
		}
	}

	get(id: string) {
		return this.#cached(`p\0${id}`, () => this.#store.get(id));
	}
	list() {
		return this.#store.list();
	}
	identity(provider: string, subject: string) {
		return this.#cached(`i\0${provider}\0${subject}`, () =>
			this.#store.identity(provider, subject),
		);
	}
	identitiesOf(principalId: string) {
		return this.#store.identitiesOf(principalId);
	}
	rolesOf(principalId: string) {
		return this.#cached(`r\0${principalId}`, () =>
			this.#store.rolesOf(principalId),
		);
	}
	holders(role: Tier) {
		return this.#store.holders(role);
	}
	linksFrom(source: LinkSource) {
		return this.#store.linksFrom(source);
	}
	create(input: NewPrincipal) {
		return this.#write(this.#store.create(input));
	}
	update(
		id: string,
		change: { displayName?: string; pronouns?: Pronouns | null },
	) {
		return this.#write(this.#store.update(id, change));
	}
	link(principalId: string, identity: IdentityRef, source: LinkSource) {
		return this.#write(this.#store.link(principalId, identity, source));
	}
	claim(principalId: string, identity: IdentityRef) {
		return this.#write(this.#store.claim(principalId, identity));
	}
	admit(identity: IdentityRef, displayName: string) {
		return this.#write(this.#store.admit(identity, displayName));
	}
	unlink(provider: string, subject: string) {
		return this.#write(this.#store.unlink(provider, subject));
	}
	grant(principalId: string, role: Tier, source: RoleSource) {
		return this.#write(this.#store.grant(principalId, role, source));
	}
	revoke(principalId: string, role: Tier, source?: RoleSource) {
		return this.#write(this.#store.revoke(principalId, role, source));
	}
	disable(id: string) {
		return this.#write(this.#store.disable(id));
	}
	enable(id: string) {
		return this.#write(this.#store.enable(id));
	}
	async touch(id: string, tier: Tier | null, at?: Date) {
		try {
			await this.#store.touch(id, tier, at);
		} finally {
			this.#reads.delete(`p\0${id}`);
		}
	}
}
