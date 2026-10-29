/**
 * How the core names a person. A person's accounts each carry a name and maybe a picture; the
 * person picks which account represents them (or the host's `profiles.prefer` order does), and
 * the core shows that name where it names the person: the web app, transcripts, and, when the
 * host lists the provider in `profiles.modelVisible`, the `Speaker.name` the agents read.
 */

/**
 * Where a provider's names and pictures come from. Example: a support inbox registers a
 * `github` source that reads a user's public profile.
 */
export interface ProfileSource {
	/** The identity provider the source reads, an open string such as `line`, `discord` or `github`. */
	provider: string;
	/** What the person sees when choosing, such as "LINE". */
	label: string;
	/**
	 * The source's own default. It never widens anything on its own: the names reach
	 * `Speaker.name` only for a provider the host lists in `profiles.modelVisible`.
	 */
	modelVisible: boolean;
	/** The https hosts its pictures come from; the picture proxy fetches only these. */
	pictureHosts: readonly string[];
	/**
	 * The name and picture address of one account, or undefined when the provider knows none. It
	 * has two seconds; a miss, a failure or a timeout is remembered for ten minutes.
	 */
	fetch(
		subject: string,
		signal: AbortSignal,
	): Promise<{ name?: string; pictureUrl?: string } | undefined>;
}

/** How one person is shown. */
export interface PersonDisplay {
	name: string;
	/** The provider the name comes from; absent when it is the principal's own display name. */
	source?: string;
	/** Whether `picture` has one to give. */
	picture: boolean;
}

/**
 * The names and pictures of the people the host serves, provided as `PROFILES` by the `identity`
 * plugin. Fetched and observed names and picture addresses live in memory for at most an hour and
 * are never stored; only a person's choice of source is.
 */
export interface PersonProfiles {
	/** Adds a source; call it from a plugin's `setup`. A second source for one provider throws. */
	register(source: ProfileSource): void;
	/** The registered sources. */
	sources(): readonly { provider: string; label: string }[];
	/**
	 * A name a signed-in session reported for one of the person's linked identities, such as an
	 * OIDC `name` claim. It is held in memory for an hour, renewed by each sign-in, and never
	 * stored, so an identity provider becomes a source without a fetch.
	 */
	observed(principalId: string, provider: string, name: string): void;
	/**
	 * The provider that names the person: their stored choice while it stays linked, else the
	 * first `profiles.prefer` provider they have linked, else undefined.
	 */
	sourceOf(principalId: string): Promise<string | undefined>;
	/** Stores the person's choice; the provider must be linked to them. `null` returns to the default. */
	choose(principalId: string, provider: string | null): Promise<void>;
	/** How the person is shown; their display name when no source names them. */
	of(principalId: string): Promise<PersonDisplay>;
	/**
	 * The person's picture, fetched through the source's allowed hosts, or undefined: an address
	 * on another host, a redirect, anything but PNG, JPEG, GIF or WebP, and a body over 2 MiB are
	 * all refused. The answer is `nosniff` and cacheable for an hour by the one browser.
	 */
	picture(principalId: string): Promise<Response | undefined>;
}

/** The `profiles` key of the host's configuration, filled. */
export interface ProfileRules {
	/** Providers in the order that names a person who has not chosen, such as `["line", "oidc:<base64url issuer>"]`. */
	prefer: readonly string[];
	/** Providers whose names may become `Speaker.name`, which agents read. */
	modelVisible: readonly string[];
}
