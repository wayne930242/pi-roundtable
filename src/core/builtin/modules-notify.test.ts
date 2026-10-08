import { describe, expect, test } from "bun:test";
import {
	type Principal,
	SYSTEM_PRINCIPAL,
} from "../identity/principal-store.ts";
import { addresseeOf } from "../identity.ts";
import type { SessionContext } from "../sessions.ts";
import type { Speaker, Tier } from "../speakers.ts";
import {
	ANN,
	context,
	contextOf,
	HOME,
	notifyIn,
	privateTo,
	registered,
} from "../testing/module-sessions.ts";
import {
	MODULES_OWNER,
	OWNER_CHANNEL,
	setUpModules,
} from "../testing/modules.ts";
import { OWNER_PRINCIPAL, OWNER_SPEAKER } from "../testing/owner.ts";

describe("notify", () => {
	test("is named notify, and with only Discord's direct messages reads word for word as notify_owner did", async () => {
		// The owner's own conversation, which addresses them as configured.
		const [notify, ...rest] = await registered(
			await setUpModules(),
			privateTo(context(), OWNER_SPEAKER.principalId, MODULES_OWNER),
			"notify",
		);
		expect(rest).toEqual([]);
		expect(notify?.name).toBe("notify");
		expect((notify as unknown as { description: string }).description).toBe(
			"Send Owner a direct message on Discord. Use only when they asks to be notified or reminded by DM; your normal reply already reaches them.",
		);
	});

	test("names whom it notifies: a private conversation's person, the only owner, or else the speaker", async () => {
		const description = async (
			session: SessionContext,
			host: {
				tiers?: Readonly<Record<string, Tier>>;
				owners?: Principal[];
			} = {},
		) => {
			const setup = await setUpModules({
				direct: { "1": OWNER_CHANNEL, p_ann: "discord:ann-dm" },
				toolTiers: host.tiers ?? {},
				...(host.owners ? { owners: host.owners } : {}),
			});
			const [notify] = await registered(setup, session, "notify");
			return (notify as unknown as { description: string }).description;
		};
		expect(
			await description(
				privateTo(
					contextOf(ANN, "other:ann"),
					"p_ann",
					addresseeOf({ displayName: "Ann" }),
				),
			),
		).toBe(
			"Send Ann a direct message on Discord. Use only when Ann asks to be notified or reminded by DM; your normal reply already reaches Ann.",
		);
		// In a shared conversation of a single-owner host only the owner may notify, so it names them.
		expect(await description(contextOf(ANN, HOME))).toBe(
			"Send Owner a direct message on Discord. Use only when they asks to be notified or reminded by DM; your normal reply already reaches them.",
		);
		// Once another owner, or anyone else, may use it, the notice is whoever speaks.
		const second = { id: "p_bo", displayName: "Bo", disabled: false };
		expect(
			await description(contextOf(ANN, HOME), {
				owners: [OWNER_PRINCIPAL, second],
			}),
		).toContain("Send the speaker");
		expect(
			await description(contextOf(ANN, HOME), { owners: [OWNER_PRINCIPAL] }),
		).toContain("Send Owner");
		expect(
			await description(contextOf(ANN, HOME), { tiers: { notify: "admin" } }),
		).toBe(
			"Send the speaker a direct message on Discord. Use only when the speaker asks to be notified or reminded by DM; your normal reply already reaches the speaker.",
		);
	});

	test("each person's notice goes to their own direct channel, in their conversation or as the speaker of a shared one", async () => {
		const setup = await setUpModules({
			direct: { "1": OWNER_CHANNEL, p_ann: "discord:ann-dm" },
		});
		const owner = { ...OWNER_SPEAKER };
		const ann = { ...ANN, tier: "owner" as const };
		await notifyIn(
			setup,
			privateTo(contextOf(ann, "other:ann"), "p_ann"),
			"to ann",
		);
		await notifyIn(
			setup,
			privateTo(contextOf(owner, "other:own"), "1"),
			"to the owner",
		);
		await notifyIn(setup, contextOf(ann, HOME), "to the speaker");
		expect(setup.record.notified).toEqual([
			{ principalId: "p_ann", text: "to ann" },
			{ principalId: "1", text: "to the owner" },
			{ principalId: "p_ann", text: "to the speaker" },
		]);
		expect(setup.record.ownerChannelAsked).toBe(0);
	});

	test("in someone else's private conversation, a speaker's notice is refused and nothing is sent to either", async () => {
		const setup = await setUpModules({
			direct: { "1": OWNER_CHANNEL, p_ann: "discord:ann-dm" },
		});
		const answer = await notifyIn(
			setup,
			privateTo(contextOf({ ...ANN, tier: "owner" }, "other:own"), "1"),
			"from ann",
		);
		expect(answer?.error).toBe(true);
		expect(answer?.text).toContain("private to someone else");
		expect(setup.record.notified).toEqual([]);
	});

	test("a private conversation of someone no direct channel reaches gets no notify", async () => {
		const setup = await setUpModules();
		expect(
			await registered(
				setup,
				privateTo(contextOf(OWNER_SPEAKER, "other:kai"), "p_kai"),
				"notify",
			),
		).toEqual([]);
	});

	test("in a shared conversation, a speaker no direct channel reaches is told so, and nothing is sent", async () => {
		const setup = await setUpModules();
		const answer = await notifyIn(setup, contextOf(ANN, HOME));
		expect(answer?.error).toBe(true);
		expect(answer?.text).toContain("no direct channel");
		expect(setup.record.notified).toEqual([]);
	});

	test("the host's own turn, such as a report's, notifies the primary owner, as notify_owner did", async () => {
		const setup = await setUpModules();
		const system: Speaker = {
			id: SYSTEM_PRINCIPAL,
			name: SYSTEM_PRINCIPAL,
			tier: "owner",
			principalId: SYSTEM_PRINCIPAL,
		};
		await notifyIn(setup, contextOf(system, HOME), "the job failed");
		expect(setup.record.notified).toEqual([
			{ principalId: "1", text: "the job failed" },
		]);
	});
});
