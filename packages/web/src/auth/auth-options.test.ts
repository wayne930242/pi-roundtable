import { describe, expect, test } from "bun:test";
import type { ActorFacts } from "pi-roundtable";
import { PluginError } from "pi-roundtable";
import { recordingLogger } from "pi-roundtable/testing";
import { resolveOptions } from "../options.ts";
import {
	build,
	HTTP_ORIGIN,
	HTTPS_ORIGIN,
	loopback,
	OWNER,
	removeAuthDirsAfterEach,
	request,
	START,
	tempDir,
} from "../testing/auth-harness.ts";
import { admit, admitAs, refuse } from "../verifier.ts";
import {
	type AuthenticatorOptions,
	createAuthenticator,
} from "./authenticator.ts";

removeAuthDirsAfterEach();

describe("auth verifier", () => {
	test("admits as the verifier says, and carries the expiry it reports", async () => {
		const actor: ActorFacts = { provider: "test", subject: "a", name: "A" };
		const expiresAt = new Date(START + 3600_000);
		const seen: (ActorFacts | undefined)[] = [];
		const { authenticator } = build({
			auth: {
				mode: "verifier",
				verifier: () => ({ admitted: true, actor, expiresAt }),
			},
			identify: async (given) => {
				seen.push(given);
				return { visitor: OWNER };
			},
		});
		expect(await authenticator.authenticate(request("/console/"))).toEqual({
			visitor: OWNER,
			actor,
			expiresAt,
		});
		expect(seen).toEqual([actor]);
	});

	test("refuses with 403 when the verifier refuses, throws, or rejects, and never says why to the client", async () => {
		for (const verifier of [
			() => refuse("no assertion"),
			() => {
				throw new Error("keys unreachable");
			},
			async () => {
				throw new Error("keys unreachable");
			},
		]) {
			const { server, apiPaths } = build({
				auth: { mode: "verifier", verifier },
			});
			const response = await server.handle(request("/console/api/config"));
			expect(response.status).toBe(403);
			expect(await response.text()).toBe("Forbidden");
			expect(apiPaths).toEqual([]);
		}
	});

	test("a verdict with no actor is the primary owner's, and admitAs carries an expiry", async () => {
		const { authenticator } = build({
			auth: { mode: "verifier", verifier: () => admit() },
			identify: async (actor) =>
				actor === undefined ? { visitor: OWNER } : { refusal: "unexpected" },
		});
		expect(await authenticator.authenticate(request("/console/"))).toEqual({
			visitor: OWNER,
		});
		const actor: ActorFacts = { provider: "test", subject: "a", name: "A" };
		const expiresAt = new Date(START);
		expect(admitAs(actor, expiresAt)).toEqual({
			admitted: true,
			actor,
			expiresAt,
		});
		expect(admitAs(actor)).toEqual({ admitted: true, actor });
	});
});

describe("auth options", () => {
	const base = { origin: HTTP_ORIGIN };

	test("the verifier option is shorthand for auth verifier", () => {
		const verifier = () => admit();
		expect(resolveOptions({ ...base, verifier }).auth).toEqual({
			mode: "verifier",
			verifier,
		});
		expect(
			resolveOptions({ ...base, auth: { mode: "verifier", verifier } }).auth,
		).toEqual({ mode: "verifier", verifier });
	});

	test("giving both auth and verifier throws", () => {
		expect(() =>
			resolveOptions({
				...base,
				verifier: () => admit(),
				auth: { mode: "none" },
			}),
		).toThrow(/both/);
	});

	test("with neither, the plugin refuses to start", () => {
		expect(() => resolveOptions({ ...base })).toThrow(/auth/);
	});

	test("none and password take their defaults", () => {
		expect(resolveOptions({ ...base, auth: { mode: "none" } }).auth).toEqual({
			mode: "none",
			trustNetwork: false,
		});
		expect(
			resolveOptions({ ...base, auth: { mode: "password" } }).auth,
		).toEqual({
			mode: "password",
			passwordEnv: "ROUNDTABLE_WEB_PASSWORD",
			sessionDays: 30,
		});
		expect(
			resolveOptions({
				...base,
				auth: { mode: "none", principal: "owner" },
			}).auth,
		).toEqual({ mode: "none", trustNetwork: false, principal: "owner" });
	});

	test("bad settings throw before anything starts", () => {
		for (const auth of [
			{ mode: "magic" },
			{ mode: "password", sessionDays: 0 },
			{ mode: "password", sessionDays: 400 },
			{ mode: "password", sessionDays: 1.5 },
			{ mode: "password", passwordEnv: "" },
			{ mode: "none", principal: " " },
			{ mode: "none", trustNetwork: "yes" },
			{ mode: "verifier" },
		])
			expect(() => resolveOptions({ ...base, auth: auth as never })).toThrow(
				PluginError,
			);
	});
});

describe("an oidc session reports itself as verified", () => {
	const fakeOidc = (verified: [string, string][]) => ({
		login: {
			open: async () => undefined,
			credential: async () => ({
				admitted: true as const,
				actor: { provider: "idp", subject: "u-1", name: "Ada" },
				session: "s-1",
			}),
			verified: (session: string, principalId: string) =>
				void verified.push([session, principalId]),
		},
		sessions: { alive: async () => true },
	});
	const build = (verified: [string, string][]) => {
		const recorder = recordingLogger();
		return createAuthenticator({
			auth: {
				mode: "oidc",
			} as unknown as AuthenticatorOptions["auth"],
			identify: async () => ({ visitor: OWNER }),
			origin: HTTPS_ORIGIN,
			mount: "/console",
			title: "Test console",
			logger: recorder.logger,
			dataDir: tempDir(),
			listener: { id: "public", address: loopback },
			oidc: fakeOidc(verified),
		});
	};

	test("a request and an open socket name the session and the person", async () => {
		const verified: [string, string][] = [];
		const authenticator = build(verified);
		const answer = await authenticator.authenticate(
			new Request(`${HTTPS_ORIGIN}/console/api/session`),
		);
		expect("visitor" in answer).toBe(true);
		expect(verified).toEqual([["s-1", "owner"]]);
		await authenticator.recheck({ actor: undefined, session: "s-1" });
		expect(verified).toEqual([
			["s-1", "owner"],
			["s-1", "owner"],
		]);
	});

	test("recheck hands reauthHours to the session lookup, and a lapsed session is signed out without a report", async () => {
		const verified: [string, string][] = [];
		const seen: (number | undefined)[] = [];
		const authenticator = createAuthenticator({
			auth: { mode: "oidc" } as unknown as AuthenticatorOptions["auth"],
			identify: async () => ({ visitor: OWNER }),
			origin: HTTPS_ORIGIN,
			mount: "/console",
			title: "Test console",
			logger: recordingLogger().logger,
			dataDir: tempDir(),
			listener: { id: "public", address: loopback },
			oidc: {
				...fakeOidc(verified),
				reauthHours: 24,
				sessions: {
					alive: async (_id: string, hours?: number) => {
						seen.push(hours);
						return false;
					},
				},
			},
		});
		expect(
			await authenticator.recheck({ actor: undefined, session: "s-1" }),
		).toMatchObject({ status: 401, login: true });
		expect(seen).toEqual([24]);
		expect(verified).toEqual([]);
	});

	test("a refused person is not reported", async () => {
		const verified: [string, string][] = [];
		const authenticator = createAuthenticator({
			auth: { mode: "oidc" } as unknown as AuthenticatorOptions["auth"],
			identify: async () => ({ refusal: "disabled" }),
			origin: HTTPS_ORIGIN,
			mount: "/console",
			title: "Test console",
			logger: recordingLogger().logger,
			dataDir: tempDir(),
			listener: { id: "public", address: loopback },
			oidc: fakeOidc(verified),
		});
		await authenticator.authenticate(
			new Request(`${HTTPS_ORIGIN}/console/api/session`),
		);
		await authenticator.recheck({ actor: undefined, session: "s-1" });
		expect(verified).toEqual([]);
	});
});
