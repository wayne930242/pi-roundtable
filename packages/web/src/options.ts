import { join, resolve } from "node:path";
import { checkRoots, type WorkspaceRoot } from "./app/workspace-files.ts";
import { checkAuth } from "./options-auth.ts";
import { fail } from "./options-common.ts";
import { checkPanes } from "./options-panes.ts";
import {
	checkOnboarding,
	checkPush,
	checkUploadMax,
	checkUploads,
} from "./options-push.ts";
import {
	DEFAULT_CARD_GRACE_SECONDS,
	DEFAULT_RELAY_NOTE,
	DEFAULT_SURFACE,
	type ResolvedOptions,
	type WebConsoleOptions,
} from "./options-types.ts";

export * from "./options-types.ts";

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

function checkMount(path: string): string {
	const mount = path.replace(/\/+$/, "");
	const segments = mount.split("/").slice(1);
	if (
		!mount.startsWith("/") ||
		segments.length === 0 ||
		!segments.every(
			(segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..",
		)
	)
		fail(
			`mountPath ${JSON.stringify(path)} must be a path of at least one segment, such as /console`,
		);
	return mount;
}

function checkOrigin(origin: string): string {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		fail(
			`origin ${JSON.stringify(origin)} is not a URL such as https://console.example.com`,
		);
	}
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.origin !== origin.replace(/\/+$/, "")
	)
		fail(
			`origin ${JSON.stringify(origin)} must be only a scheme and host, such as https://console.example.com`,
		);
	return url.origin;
}

/**
 * What no place of the files pane may be or contain: the host's data directory, and Pi's agent
 * directory in its default place beside the sessions (`auth.json` lives there).
 */
export function protectedDirs(dataDir: string): string[] {
	return [resolve(dataDir), resolve(dataDir, "pi")];
}

function checkWorkspace(
	options: WebConsoleOptions,
	dataDir: string,
): ResolvedOptions["workspace"] {
	const given = options.workspace;
	if (given === undefined) return { roots: [], agents: true, scratch: true };
	if (typeof given !== "object" || given === null)
		return fail("workspace must be an object such as { roots: [...] }");
	for (const key of ["agents", "scratch"] as const)
		if (given[key] !== undefined && typeof given[key] !== "boolean")
			fail(`workspace.${key} must be true or false`);
	const list = given.roots ?? [];
	if (!Array.isArray(list)) fail("workspace.roots must be a list");
	const roots: WorkspaceRoot[] = list.map((root, index) => {
		if (
			typeof root !== "object" ||
			root === null ||
			typeof root.id !== "string" ||
			typeof root.label !== "string" ||
			!root.label.trim() ||
			typeof root.dir !== "string" ||
			(root.writable !== undefined && typeof root.writable !== "boolean")
		)
			return fail(
				`workspace.roots[${index}] must be { id, label, dir, writable? } with text for the first three`,
			);
		return {
			id: root.id,
			label: root.label.trim(),
			dir: root.dir,
			writable: root.writable === true,
		};
	});
	for (const reserved of ["agents", "scratch"])
		if (roots.some((root) => root.id === reserved))
			fail(
				`workspace.roots may not use the id ${reserved}, which names the agents' own directory`,
			);
	checkRoots(roots, protectedDirs(dataDir));
	return {
		roots,
		agents: given.agents !== false,
		scratch: given.scratch !== false,
	};
}

function checkSurface(surface: string | undefined): string {
	if (surface === undefined) return DEFAULT_SURFACE;
	if (typeof surface !== "string" || !/^[a-z][a-z0-9-]*$/.test(surface))
		fail(
			`surface ${JSON.stringify(surface)} must be a lower-case word such as app`,
		);
	if (surface === "discord")
		fail("surface cannot be discord, whose channels the Discord plugin serves");
	return surface;
}

function checkGrace(seconds: number | undefined): number {
	if (seconds === undefined) return DEFAULT_CARD_GRACE_SECONDS;
	if (typeof seconds !== "number" || !(seconds > 0) || seconds > 3600)
		fail(
			"cardGraceSeconds must be a number of seconds above 0 and at most 3600",
		);
	return seconds;
}

/** Checks the options at the point the plugin is created, so a bad setting stops the host before anything starts. */
export function resolveOptions(options: WebConsoleOptions): ResolvedOptions {
	const auth = checkAuth(options);
	if (
		options.routing !== undefined &&
		options.routing !== "path" &&
		options.routing !== "hash"
	)
		fail("routing must be hash or path");
	if (options.presentation?.locale !== undefined) {
		try {
			new Intl.DateTimeFormat(options.presentation.locale);
		} catch {
			fail("presentation.locale is not a valid locale");
		}
	}
	const admission = options.admission ?? "owners";
	if (admission !== "owners" && admission !== "access")
		fail('admission must be "owners" or "access"');
	if (
		admission === "access" &&
		(auth.mode === "none" || auth.mode === "password")
	)
		fail(
			`admission "access" needs a credential that names a person, but auth ${auth.mode} speaks for one shared actor; use auth oidc or a verifier that reports who signed in`,
		);
	const origin = checkOrigin(options.origin);
	if (auth.mode === "oidc" && !origin.startsWith("https:"))
		fail("auth oidc needs an https origin: the session cookie is Secure");
	if (options.modes !== undefined && options.modes !== false)
		fail("modes can only be false, to leave the mode switches out");
	const panes = checkPanes(options.panes, admission);
	const ownerId = options.ownerId?.trim();
	if (options.ownerId !== undefined && !ownerId)
		fail(
			"ownerId is empty. Leave it out: the console finds each visitor's principal, and a verifier that reports no actor speaks for the primary owner",
		);
	const look = options.appearance?.look ?? "modern";
	if (look !== "modern" && look !== "camelot")
		fail("appearance.look must be modern or camelot");
	const title = options.title?.trim() ?? "Roundtable";
	if (!title) fail("title is empty");
	const description = options.description?.trim();
	if (
		options.description !== undefined &&
		(typeof options.description !== "string" || !description)
	)
		fail("description is empty. Leave it out for the default");
	return {
		auth,
		origin,
		webhookOrigin:
			options.webhookOrigin === undefined
				? origin
				: checkOrigin(options.webhookOrigin),
		ownerId,
		dataDir: options.dataDir ?? "data",
		sessionsDir: join(options.dataDir ?? "data", "sessions"),
		mount: checkMount(options.mountPath ?? "/console"),
		listener: options.listener ?? "public",
		routing: options.routing ?? "hash",
		admission,
		panes: panes.owner,
		tierPanes: { owner: panes.owner, admin: panes.admin, member: panes.member },
		panesGiven: panes.given,
		workspace: checkWorkspace(options, options.dataDir ?? "data"),
		surface: checkSurface(options.surface),
		cardGraceSeconds: checkGrace(options.cardGraceSeconds),
		uploadMaxBytes: checkUploadMax(options.uploadMaxBytes),
		push: checkPush(options, origin),
		onboarding: checkOnboarding(options),
		modes: options.modes !== false,
		uploadKeepDays: checkUploads(options),
		title,
		description,
		iconsDir: options.icons?.dir,
		look,
		relayNotes: options.relayNotes ?? [DEFAULT_RELAY_NOTE],
		exclude: options.exclude,
		assetDir: options.assetDir,
		features: options.features,
		presentation: options.presentation,
	};
}
