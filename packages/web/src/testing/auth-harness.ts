import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActorFacts, ListenerAddress } from "pi-roundtable";
import { recordingLogger } from "pi-roundtable/testing";
import type { AssetBundle } from "../assets.ts";
import {
	type Authenticator,
	type AuthenticatorOptions,
	createAuthenticator,
} from "../auth/authenticator.ts";
import { ConsoleServer } from "../console-server.ts";
import type { Identified, Visitor } from "../visitors.ts";

export const OWNER: Visitor = {
	principal: { id: "owner", displayName: "Owner", disabled: false },
	tier: "owner",
	speakerId: "owner",
	roles: [],
};
export const HTTP_ORIGIN = "http://console.example.test";
export const HTTPS_ORIGIN = "https://console.example.test";
export const PASSWORD = "correct horse battery";
export const OTHER_PASSWORD = "another long secret";
export const START = Date.parse("2026-10-28T00:00:00Z");

export const assets: AssetBundle = new Map([
	[
		"index.html",
		{ body: Buffer.from("<html>console</html>"), type: "text/html" },
	],
]);

const dirs: string[] = [];
/** Registers the removal of the temporary directories a test made, after each test. */
export function removeAuthDirsAfterEach(): void {
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
	});
}
export const tempDir = () => {
	const dir = mkdtempSync(join(tmpdir(), "web-auth-"));
	dirs.push(dir);
	return dir;
};

/** The identify step of a host whose only owner is linked to the web console's own identity. */
export const identifyConsole = async (
	actor: ActorFacts | undefined,
): Promise<Identified> =>
	actor?.provider === "token" && actor.subject === "web-console"
		? { visitor: OWNER }
		: { refusal: "no such identity" };

export const loopback: ListenerAddress = { port: 8080, hostname: "127.0.0.1" };

export interface Harness {
	authenticator: Authenticator;
	server: ConsoleServer;
	recorder: ReturnType<typeof recordingLogger>;
	apiPaths: string[];
	clock: { now: number };
	dataDir: string;
}

export function build(
	options: Partial<AuthenticatorOptions> & Pick<AuthenticatorOptions, "auth">,
	extra: { clock?: { now: number }; dataDir?: string } = {},
): Harness {
	const recorder = recordingLogger();
	const clock = extra.clock ?? { now: START };
	const dataDir = extra.dataDir ?? tempDir();
	const authenticator = createAuthenticator({
		identify: identifyConsole,
		origin: HTTP_ORIGIN,
		mount: "/console",
		title: "Test console",
		logger: recorder.logger,
		dataDir,
		listener: { id: "public", address: loopback },
		env: { ROUNDTABLE_WEB_PASSWORD: PASSWORD },
		loginDelayMs: 0,
		now: () => clock.now,
		...options,
	});
	const apiPaths: string[] = [];
	const server = new ConsoleServer({
		mount: "/console",
		assets,
		authenticator,
		api: {
			handle: async (_request, path) => {
				apiPaths.push(path);
				return Response.json({ ok: true });
			},
		},
		subscribe: () => undefined,
		logger: recorder.logger,
	});
	return { authenticator, server, recorder, apiPaths, clock, dataDir };
}

export const password = (auth: Partial<{ sessionDays: number }> = {}) => ({
	mode: "password" as const,
	passwordEnv: "ROUNDTABLE_WEB_PASSWORD",
	sessionDays: 30,
	...auth,
});
export const none = (trustNetwork = false) => ({
	mode: "none" as const,
	trustNetwork,
});

export const request = (path: string, init: RequestInit = {}) =>
	new Request(`http://host${path}`, init);

export const login = (
	server: ConsoleServer,
	given: string | undefined,
	headers: Record<string, string> = { origin: HTTP_ORIGIN },
) =>
	server.handle(
		request("/console/auth/login", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				...headers,
			},
			body: new URLSearchParams(
				given === undefined ? {} : { password: given },
			).toString(),
		}),
	);

/** The `name=value` pair of the session cookie a response sets. */
export const cookieOf = (response: Response): string => {
	const set = response.headers.getSetCookie()[0];
	if (!set) throw new Error("no cookie set");
	return set.split(";")[0] ?? "";
};

export const withCookie = (
	cookie: string,
	init: RequestInit = {},
): RequestInit => ({
	...init,
	headers: { ...(init.headers as Record<string, string>), cookie },
});

export async function signedIn(harness: Harness): Promise<string> {
	return cookieOf(await login(harness.server, PASSWORD));
}
