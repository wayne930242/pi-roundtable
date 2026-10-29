import {
	IdentityError,
	type IdentityService,
	type PersonProfiles,
} from "pi-roundtable";
import type { ProfileView } from "../api-types.ts";
import type { Gate } from "../gate.ts";
import { ConsoleHttpError as HttpError, json } from "../http.ts";
import { readLimited } from "../request-body.ts";
import type { RouteArea, Viewer } from "../web-app.ts";
import { LinkRefused, type LinkService } from "./links.ts";

const MAX_BODY_BYTES = 4 * 1024;

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
	const raw = await readLimited(request, MAX_BODY_BYTES);
	if (!raw) throw new HttpError(413, "The body is too large.");
	let value: unknown;
	try {
		value = JSON.parse(raw.toString("utf8"));
	} catch {
		throw new HttpError(400, "The body is not JSON.");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new HttpError(400, "The body is not an object.");
	return value as Record<string, unknown>;
}

/** Turns what a handler throws into the response a person reads; anything else is a bug and rethrown. */
function answer(error: unknown): Response {
	if (error instanceof HttpError)
		return json({ error: error.message }, error.status);
	if (error instanceof LinkRefused)
		return json({ error: error.message }, error.status);
	if (error instanceof IdentityError)
		return json({ error: error.message }, 400);
	throw error;
}

export interface ProfileAreaOptions {
	profiles: PersonProfiles;
	identity: Pick<IdentityService, "identities">;
	/**
	 * What the account the person signed in with is called when it is not a registered source: a
	 * sign-in reports its name to `PROFILES.observed`, so it can name the person without a fetch.
	 */
	sessionLabel: string;
}

/** `GET api/profile` and `PUT api/profile/source`: how the person is shown and which account names them. */
export function profileArea(options: ProfileAreaOptions): RouteArea {
	const view = async (viewer: Viewer, sessionProvider: string | undefined) => {
		const { profiles, identity } = options;
		const [display, linked] = await Promise.all([
			profiles.of(viewer.principalId),
			identity.identities(viewer.principalId),
		]);
		const linkedProviders = new Set(linked.map((link) => link.provider));
		const sources: ProfileView["sources"] = profiles
			.sources()
			.filter((source) => linkedProviders.has(source.provider))
			.map((source) => ({ provider: source.provider, label: source.label }));
		if (
			sessionProvider &&
			linkedProviders.has(sessionProvider) &&
			!sources.some((source) => source.provider === sessionProvider)
		)
			sources.push({ provider: sessionProvider, label: options.sessionLabel });
		return {
			name: display.name,
			...(display.source ? { source: display.source } : {}),
			picture: display.picture,
			principal: viewer.principalId,
			tier: viewer.tier,
			sources,
		} satisfies ProfileView;
	};
	return {
		area: "profile",
		async handle(request, parts, { viewer, visitor }) {
			try {
				const provider = visitor.speakerId.split(":").slice(0, -1).join(":");
				if (parts.length === 0 && request.method === "GET")
					return json(await view(viewer, provider || undefined));
				if (parts.length === 1 && parts[0] === "source") {
					if (request.method !== "PUT")
						throw new HttpError(405, "Method not allowed.");
					const body = await bodyOf(request);
					const chosen = body.provider;
					if (chosen !== null && typeof chosen !== "string")
						throw new HttpError(
							400,
							"Send provider: the account's provider, or null for the default.",
						);
					await options.profiles.choose(viewer.principalId, chosen);
					return json(await view(viewer, provider || undefined));
				}
				throw new HttpError(404, "There is no such API.");
			} catch (error) {
				return answer(error);
			}
		},
	};
}

/**
 * `GET api/people/<principal>/picture`: the person's picture through the picture proxy. Anyone past
 * the gate may fetch another person's picture; a person still at the gate only their own.
 */
export function peopleArea(options: {
	profiles: Pick<PersonProfiles, "picture">;
	gate: Pick<Gate, "required">;
}): RouteArea {
	return {
		area: "people",
		async handle(request, parts, { viewer }) {
			try {
				const [id, what] = parts;
				if (id === undefined || what !== "picture" || parts.length !== 2)
					throw new HttpError(404, "There is no such API.");
				if (request.method !== "GET" && request.method !== "HEAD")
					throw new HttpError(405, "Method not allowed.");
				if (
					id !== viewer.principalId &&
					(await options.gate.required(viewer)).length > 0
				)
					throw new HttpError(403, "Finish setting up first.");
				const picture = await options.profiles.picture(id);
				if (!picture) throw new HttpError(404, "There is no picture.");
				return picture;
			} catch (error) {
				return answer(error);
			}
		},
	};
}

/** `GET api/links`, `POST api/links/<provider>/issue|confirm|cancel` and `DELETE api/links/<provider>`. */
export function linksArea(links: LinkService): RouteArea {
	return {
		area: "links",
		async handle(request, parts, { viewer }) {
			try {
				const me = viewer.principalId;
				const [provider, action] = parts;
				const { method } = request;
				if (provider === undefined && method === "GET")
					return json(await links.list(me));
				if (provider !== undefined && action === undefined) {
					if (method === "GET") return json(await links.one(provider, me));
					if (method === "DELETE")
						return json(await links.unlink(provider, me));
					throw new HttpError(405, "Method not allowed.");
				}
				if (provider !== undefined && parts.length === 2 && method === "POST") {
					if (action === "issue") return json(await links.issue(provider, me));
					if (action === "cancel")
						return json(await links.cancel(provider, me));
					if (action === "confirm") {
						const { request: ref } = await bodyOf(request);
						if (typeof ref !== "string" || ref.length === 0 || ref.length > 200)
							throw new HttpError(
								400,
								"Send request: the id the code came with.",
							);
						return json(await links.confirm(provider, me, ref));
					}
				}
				throw new HttpError(404, "There is no such API.");
			} catch (error) {
				return answer(error);
			}
		},
	};
}
