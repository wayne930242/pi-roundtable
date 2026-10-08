import { describe, expect, test } from "bun:test";
import type { BackgroundTurn, ChannelClaim } from "../contract/channels.ts";
import { IdentityError } from "../domain/errors.ts";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import { silentLogger } from "../log.ts";
import { type Speaker, type Tier, tierAtLeast } from "../speakers.ts";
import { ChannelQueue } from "./channel-queue.ts";
import { ChannelRouter } from "./channel-router.ts";
import { systemTurn } from "./system-turns.ts";

/** A claim of every channel that records the speaker each background turn reached it as. */
function recordingClaim(ran: (Speaker | undefined)[]): ChannelClaim {
	return {
		name: "desk",
		priority: 0,
		owns: () => true,
		admit: () => undefined,
		background: async (turn) => {
			ran.push(turn.speaker);
			return { status: "ran" };
		},
		startFresh: async () => "desk",
	};
}

/** The principals a host knows: Ada an owner, Kai a member, Bo disabled, Noa unseen too long. */
const principals = {
	speakerFor: async (principalId: string, tier?: Tier): Promise<Speaker> => {
		if (principalId === "p_bo")
			throw new IdentityError("principal p_bo is disabled");
		if (principalId === "p_noa")
			throw new IdentityError(
				"principal p_noa holds no lasting role and was last seen more than 30 days ago (access.backgroundStaleDays)",
			);
		const own: Tier | undefined =
			principalId === "p_ada"
				? "owner"
				: principalId === "p_kai"
					? "member"
					: undefined;
		if (!own) throw new IdentityError(`there is no principal ${principalId}`);
		return {
			id: principalId,
			name: principalId,
			tier: tier && tierAtLeast(own, tier) ? tier : own,
			principalId,
		};
	},
};

function routerWith(
	ran: (Speaker | undefined)[],
	options: { principals?: boolean } = {},
) {
	return new ChannelRouter({
		claims: [recordingClaim(ran)],
		targets: (name) =>
			name === "main" ? { name, label: () => "Main" } : undefined,
		queue: new ChannelQueue(),
		logger: silentLogger(),
		...(options.principals === false ? {} : { principals }),
	});
}

const turn = (
	author: BackgroundTurn["author"],
	tier: Tier,
): BackgroundTurn => ({
	channel: "fake:1",
	target: "main",
	author,
	tier,
	turnId: "schedule-1",
	text: "reminder",
});

describe("ChannelRouter checking whom a background turn runs as", () => {
	test("a turn runs as its author's principal, at its tier or theirs, whichever is lower, under the name and id it carries", async () => {
		const ran: (Speaker | undefined)[] = [];
		const routing = routerWith(ran);
		const kai = { principalId: "p_kai", id: "966666600000000003", name: "Kai" };
		expect(await routing.background(turn(kai, "owner"))).toEqual({
			status: "ran",
		});
		expect(await routing.background(turn(kai, "member"))).toEqual({
			status: "ran",
		});
		expect(ran).toEqual([
			{ id: kai.id, name: "Kai", tier: "member", principalId: "p_kai" },
			{ id: kai.id, name: "Kai", tier: "member", principalId: "p_kai" },
		]);
	});

	test("a turn of a disabled principal, of one unseen past backgroundStaleDays, or of no principal is skipped, saying why", async () => {
		const ran: (Speaker | undefined)[] = [];
		const routing = routerWith(ran);
		for (const [principalId, why] of [
			["p_bo", "disabled"],
			["p_noa", "access.backgroundStaleDays"],
			["p_gone", "there is no principal p_gone"],
		] as const) {
			const outcome = await routing.background(
				turn({ principalId, id: principalId, name: principalId }, "member"),
			);
			expect(outcome.status).toBe("skipped");
			expect(outcome.status === "skipped" && outcome.reason).toContain(why);
		}
		expect(ran).toEqual([]);
	});

	test("a turn without its author's principal or a tier, as 0.8 wrote one, is skipped and reaches no claim", async () => {
		const ran: (Speaker | undefined)[] = [];
		const routing = routerWith(ran);
		// SAFETY: the 0.8 shape, which a caller outside TypeScript still sends.
		const old = {
			channel: "fake:1",
			target: "main",
			author: { id: "p_ada", name: "Ada" },
			turnId: "schedule-1",
			text: "reminder",
		} as unknown as BackgroundTurn;
		const outcome = await routing.background(old);
		expect(outcome).toMatchObject({ status: "skipped" });
		expect(outcome.status === "skipped" && outcome.reason).toContain(
			"author.principalId",
		);
		const untiered = await routing.background({
			...turn({ principalId: "p_ada", id: "p_ada", name: "Ada" }, "owner"),
			tier: undefined as unknown as Tier,
		});
		expect(untiered.status).toBe("skipped");
		expect(ran).toEqual([]);
	});

	test("the speaker a caller puts on the turn is replaced by the one the router checked", async () => {
		const ran: (Speaker | undefined)[] = [];
		const routing = routerWith(ran);
		await routing.background({
			...turn({ principalId: "p_kai", id: "p_kai", name: "Kai" }, "member"),
			speaker: { id: "x", name: "x", tier: "owner", principalId: "p_ada" },
		});
		expect(ran).toEqual([
			{ id: "p_kai", name: "Kai", tier: "member", principalId: "p_kai" },
		]);
	});

	test("only the host itself runs a turn as the system principal, at the tier its starter gives", async () => {
		const ran: (Speaker | undefined)[] = [];
		const routing = routerWith(ran);
		const forged = await routing.background(
			turn(
				{ principalId: SYSTEM_PRINCIPAL, id: "assistant", name: "Zed" },
				"owner",
			),
		);
		expect(forged.status).toBe("skipped");
		expect(forged.status === "skipped" && forged.reason).toContain(
			"only the host itself",
		);
		expect(ran).toEqual([]);
		const report = systemTurn({
			channel: "fake:1",
			target: "main",
			author: { id: "assistant", name: "Zed" },
			tier: "owner",
			turnId: "error-1",
			text: "a logged error",
			report: true,
		});
		expect(report.author.principalId).toBe(SYSTEM_PRINCIPAL);
		expect(await routing.background(report)).toEqual({ status: "ran" });
		// A copy of the host's turn is no longer the host's.
		expect((await routing.background({ ...report })).status).toBe("skipped");
		expect(ran).toEqual([
			{
				id: SYSTEM_PRINCIPAL,
				name: "Zed",
				tier: "owner",
				principalId: SYSTEM_PRINCIPAL,
			},
		]);
	});

	test("without an identity service, a person's turn is skipped and the host's own still runs", async () => {
		const ran: (Speaker | undefined)[] = [];
		const routing = routerWith(ran, { principals: false });
		const outcome = await routing.background(
			turn({ principalId: "p_ada", id: "p_ada", name: "Ada" }, "owner"),
		);
		expect(outcome.status).toBe("skipped");
		const report = systemTurn({
			channel: "fake:1",
			target: "main",
			author: { id: "assistant", name: "Zed" },
			tier: "owner",
			turnId: "error-2",
			text: "a logged error",
		});
		expect(await routing.background(report)).toEqual({ status: "ran" });
		expect(ran.map((speaker) => speaker?.principalId)).toEqual([
			SYSTEM_PRINCIPAL,
		]);
	});

	test("a failure to read whom the turn runs as fails the turn instead of skipping it", async () => {
		const ran: (Speaker | undefined)[] = [];
		const routing = new ChannelRouter({
			claims: [recordingClaim(ran)],
			targets: (name) => ({ name, label: () => name }),
			queue: new ChannelQueue(),
			logger: silentLogger(),
			principals: {
				speakerFor: async () => {
					throw new Error("database down");
				},
			},
		});
		expect(
			await routing.background(
				turn({ principalId: "p_ada", id: "p_ada", name: "Ada" }, "owner"),
			),
		).toEqual({ status: "failed", error: "Error: database down" });
		expect(ran).toEqual([]);
	});
});
