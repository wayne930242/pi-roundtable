import { afterAll, beforeAll, expect, test } from "bun:test";
import { describeDb } from "pi-roundtable/testing";
import type {
	LinkIssuedView,
	LinksView,
	OnboardingView,
	ProfileView,
	SessionView,
} from "../api-types.ts";
import {
	bootE,
	Client,
	type EHost,
	MEL,
	ofType,
	principalOf,
	rest,
	SAM,
} from "../testing/e-host.ts";
import { fakePushService, receiver } from "../testing/push.ts";
import type { LinkProver } from "../web-app.ts";

/** A prover that keeps its state in memory and records the principal every call carried. */
function fakeProver(
	provider: string,
	label: string,
	requires: string[] = [],
): LinkProver & {
	calls: { call: string; principalId: string }[];
	linked: Set<string>;
} {
	const linked = new Set<string>();
	const issued = new Map<string, string>();
	const calls: { call: string; principalId: string }[] = [];
	const note = (call: string, principalId: string) =>
		calls.push({ call, principalId });
	return {
		provider,
		label,
		requires,
		calls,
		linked,
		status: async (principalId) => {
			note("status", principalId);
			return linked.has(principalId)
				? {
						linked: { subject: "u", linkedAt: new Date(0), displayName: label },
					}
				: issued.has(principalId)
					? {
							pending: {
								request: issued.get(principalId) ?? "",
								expiresAt: new Date(Date.now() + 60_000),
							},
						}
					: {};
		},
		issue: async (principalId) => {
			note("issue", principalId);
			issued.set(principalId, `req-${provider}`);
			return {
				code: "123456",
				request: `req-${provider}`,
				expiresAt: new Date(Date.now() + 60_000),
				instructions: `Send 123456 to ${label}.`,
			};
		},
		confirm: async (principalId, request) => {
			note("confirm", principalId);
			if (issued.get(principalId) !== request) throw new Error("wrong request");
			issued.delete(principalId);
			linked.add(principalId);
		},
		cancel: async (principalId) => {
			note("cancel", principalId);
			issued.delete(principalId);
		},
		unlink: async (principalId) => {
			note("unlink", principalId);
			linked.delete(principalId);
		},
	};
}

const SESSIONS = (who: string, app: EHost) =>
	rest(app, "session", { who }).then((r) => r.json() as Promise<SessionView>);

describeDb("onboarding, links and the profile over a real host", () => {
	const line = fakeProver("line", "LINE");
	const crm = fakeProver("crm", "CRM", ["line"]);
	const push = fakePushService();
	let app: EHost;
	let mel = "";
	let sam = "";
	beforeAll(async () => {
		app = await bootE({
			fetch: push.fetch,
			console: {
				push: { quietHours: false, tiers: ["owner", "member"] },
				onboarding: {
					links: { line: "required", crm: "nudge" },
					push: "required",
					pushWaiver: true,
				},
			},
			extra: (web) => {
				web.registerLinkProver(line);
				web.registerLinkProver(crm);
			},
		});
		mel = await principalOf(app.host, MEL);
		sam = await principalOf(app.host, SAM);
		const sql = app.host.context.database();
		await sql`DELETE FROM web_onboarding`;
		await sql`DELETE FROM web_push_receipts`;
		await sql`DELETE FROM web_push_subscriptions`;
	}, 30_000);
	afterAll(async () => {
		const sql = app.host.context.database();
		await sql`DELETE FROM web_onboarding`;
		await sql`DELETE FROM web_push_receipts`;
		await sql`DELETE FROM web_push_subscriptions`;
		await app.stop();
	});

	test("a member who owes a required step meets the gate; an owner whose configuration links the provider does not", async () => {
		const gated = await SESSIONS("mel", app);
		// The gate holds the required steps; the nudge for crm is on the steps page.
		expect(gated.gate?.map((s) => s.id)).toEqual(["link:line", "push"]);
		expect(gated.gate?.[0]?.builtin).toBe("link");
		expect(gated.gate?.[1]?.builtin).toBe("push");
		// The owner's configuration links line, so only the push step is theirs to owe.
		const owner = await SESSIONS("owner", app);
		expect(owner.gate?.map((s) => s.id)).toEqual(["push"]);
		// A gated person gets 403 with gate: true everywhere but the routes marked G.
		const shut = await rest(app, "conversations", { who: "mel" });
		expect(shut.status).toBe(403);
		expect(((await shut.json()) as { gate?: boolean }).gate).toBe(true);
		expect((await rest(app, "onboarding", { who: "mel" })).status).toBe(200);
		expect((await rest(app, "links", { who: "mel" })).status).toBe(200);
		expect((await rest(app, "profile", { who: "mel" })).status).toBe(200);
		expect((await rest(app, "notices", { who: "mel" })).status).toBe(200);
	});

	test("the steps list shows what is done, waived and open, with the push state", async () => {
		const view = (await (
			await rest(app, "onboarding", { who: "mel" })
		).json()) as OnboardingView;
		expect(view.steps.map((s) => [s.id, s.done, s.waived])).toEqual([
			["link:line", false, false],
			["link:crm", false, false],
			["push", false, false],
		]);
		expect(view.steps[2]?.waiver?.label).toBe("Skip for now");
		expect(view.push).toEqual({ devices: 0, waived: false });
		// The service answers the same for a host plugin.
		expect((await app.app.onboarding.status(mel)).map((s) => s.id)).toEqual([
			"link:line",
			"link:crm",
			"push",
		]);
	});

	test("a link whose provider requires another is refused until that one is linked; every prover call carries the session's principal", async () => {
		const early = await rest(app, "links/crm/issue", {
			method: "POST",
			who: "mel",
		});
		expect(early.status).toBe(409);
		expect(((await early.json()) as { error: string }).error).toContain("LINE");
		const issued = await rest(app, "links/line/issue", {
			method: "POST",
			who: "mel",
			// A principal named in the request is never trusted.
			body: JSON.stringify({ principalId: sam }),
		});
		expect(issued.status).toBe(200);
		const code = (await issued.json()) as LinkIssuedView;
		expect(code.code).toBe("123456");
		const view = (await (
			await rest(app, "links", { who: "mel" })
		).json()) as LinksView;
		expect(
			view.links.find((l) => l.provider === "line")?.pending?.request,
		).toBe("req-line");
		expect(view.links.find((l) => l.provider === "crm")?.blockedBy).toEqual([
			"line",
		]);
		const wrong = await rest(app, "links/line/confirm", {
			method: "POST",
			who: "mel",
			body: JSON.stringify({ request: "other" }),
		});
		expect(wrong.status).toBe(500);
		const socket = await Client.open(app, "mel");
		if (!socket) throw new Error("the socket was refused");
		expect(
			(await socket.take(ofType("ready"))).gate?.map((s) => s.id),
		).toContain("link:line");
		const done = await rest(app, "links/line/confirm", {
			method: "POST",
			who: "mel",
			body: JSON.stringify({ request: "req-line" }),
		});
		expect(done.status).toBe(200);
		// The socket is told what is owed now, without a reload.
		const after = await socket.take(ofType("gate"));
		expect(after.steps.map((s) => s.id)).toEqual(["push"]);
		socket.close();
		const acting = line.calls.filter((entry) => entry.call !== "status");
		expect(acting.map((entry) => entry.call)).toEqual([
			"issue",
			"confirm",
			"confirm",
		]);
		for (const entry of acting) expect(entry.principalId).toBe(mel);
		// The request named Sam, and Sam was never asked about.
		expect(line.calls.some((entry) => entry.principalId === sam)).toBe(false);
		// Now crm may be linked, and unlinking works for a link that is the prover's own.
		expect(
			(await rest(app, "links/crm/issue", { method: "POST", who: "mel" }))
				.status,
		).toBe(200);
		await rest(app, "links/crm/cancel", { method: "POST", who: "mel" });
		const undone = await rest(app, "links/line", {
			method: "DELETE",
			who: "mel",
		});
		expect(
			((await undone.json()) as { linked?: unknown }).linked,
		).toBeUndefined();
		line.linked.add(mel);
	});

	test("a link the configuration made cannot be removed here, and a required link step cannot be waived", async () => {
		const owner = (await (
			await rest(app, "links", { who: "owner" })
		).json()) as LinksView;
		expect(owner.links.find((l) => l.provider === "line")?.linked?.locked).toBe(
			true,
		);
		const removed = await rest(app, "links/line", {
			method: "DELETE",
			who: "owner",
		});
		expect(removed.status).toBe(409);
		const waived = await rest(app, "onboarding/link%3Aline/waive", {
			method: "POST",
			who: "sam",
		});
		expect(waived.status).toBe(400);
		expect((await SESSIONS("sam", app)).gate?.map((s) => s.id)).toContain(
			"link:line",
		);
		expect(
			(await rest(app, "links/nothing/issue", { method: "POST", who: "mel" }))
				.status,
		).toBe(404);
	});

	test("a waiver unlocks the gate and is listed; the push step also finishes when a device reports back", async () => {
		// Sam waives the push step (required, with a waiver) and links the account.
		line.linked.add(sam);
		const waive = await rest(app, "onboarding/push/waive", {
			method: "POST",
			who: "sam",
		});
		expect(waive.status).toBe(200);
		const view = (await waive.json()) as OnboardingView;
		expect(view.steps.find((s) => s.id === "push")?.waived).toBe(true);
		expect(view.push.waived).toBe(true);
		// Only the nudge to link crm is left, and a nudge never gates.
		expect((await SESSIONS("sam", app)).gate).toBeUndefined();
		expect(
			(await app.app.onboarding.status(sam))
				.filter((s) => !s.done && !s.waived)
				.map((s) => s.id),
		).toEqual(["link:crm"]);
		const stored = await app.app.onboarding.status(sam);
		expect(stored.find((s) => s.id === "push")?.waived).toBe(true);
		// Mel turns push on, tests it, and the receipt finishes the step.
		line.linked.add(mel);
		const device = await receiver();
		await rest(app, "push/subscriptions", {
			method: "POST",
			who: "mel",
			body: JSON.stringify(
				device.subscription(
					"https://fcm.googleapis.com/fcm/send/mel-onb",
					"Phone",
				),
			),
		});
		const made = await rest(app, "push/test", { method: "POST", who: "mel" });
		const { tag } = (await made.json()) as { tag: string };
		expect((await SESSIONS("mel", app)).gate?.map((s) => s.id)).toContain(
			"push",
		);
		await rest(app, "push/receipts", {
			method: "POST",
			who: "mel",
			body: JSON.stringify({ tag, event: "received" }),
		});
		// Only a nudge is left: the app opens.
		expect((await SESSIONS("mel", app)).gate).toBeUndefined();
		expect(
			(
				(await (
					await rest(app, "onboarding", { who: "mel" })
				).json()) as OnboardingView
			).push.lastReceiptAt,
		).toBeDefined();
		expect((await rest(app, "conversations", { who: "mel" })).status).not.toBe(
			403,
		);
	});

	test("the profile page: the choice of display account refuses an account that is not linked", async () => {
		const view = (await (
			await rest(app, "profile", { who: "mel" })
		).json()) as ProfileView;
		expect(view.principal).toBe(mel);
		expect(view.name).toBe("Mel");
		const refused = await rest(app, "profile/source", {
			method: "PUT",
			who: "mel",
			body: JSON.stringify({ provider: "github" }),
		});
		expect(refused.status).toBe(400);
		const reset = await rest(app, "profile/source", {
			method: "PUT",
			who: "mel",
			body: JSON.stringify({ provider: null }),
		});
		expect(reset.status).toBe(200);
		// There is no picture to serve, and another person's is not asked for while gated.
		expect(
			(await rest(app, `people/${mel}/picture`, { who: "mel" })).status,
		).toBe(404);
	});

	test("a gated person reaches their profile and settings, never the rest of the app", async () => {
		// Tom is Sam with the line link taken away again.
		line.linked.delete(sam);
		app.app.onboarding.changed(sam);
		expect((await SESSIONS("sam", app)).gate?.map((s) => s.id)).toEqual([
			"link:line",
		]);
		expect((await rest(app, "profile", { who: "sam" })).status).toBe(200);
		expect((await rest(app, "settings", { who: "sam" })).status).toBe(404);
		expect((await rest(app, "host/inbox", { who: "sam" })).status).toBe(403);
		// Another person's picture waits until the steps are done; their own does not.
		expect(
			(await rest(app, `people/${mel}/picture`, { who: "sam" })).status,
		).toBe(403);
		expect(
			(await rest(app, `people/${sam}/picture`, { who: "sam" })).status,
		).toBe(404);
	});
});

describeDb(
	"onboarding that cannot work is refused when the web service starts",
	() => {
		test("a required link with no prover stops the start and names the provider", async () => {
			await expect(
				bootE({
					console: { onboarding: { links: { line: "required" } } },
				}),
			).rejects.toThrow("line");
		});

		test("a push step with push off stops the start", async () => {
			await expect(
				bootE({
					console: {
						origin: "http://app.example.test",
						onboarding: { push: "required" },
					},
				}),
			).rejects.toThrow("onboarding.push");
		});
	},
);
