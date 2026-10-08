import { describe, expect, test } from "bun:test";
import { SYSTEM_PRINCIPAL } from "../identity/principal-store.ts";
import type { Speaker } from "../speakers.ts";
import {
	ANN,
	context,
	contextOf,
	HOME,
	notifyIn,
	privately,
	registered,
} from "../testing/module-sessions.ts";
import { OWNER_CHANNEL, setUpModules } from "../testing/modules.ts";
import { OWNER_SPEAKER } from "../testing/owner.ts";

describe("notify", () => {
	test("is named notify, and with only Discord's direct messages reads word for word as notify_owner did", async () => {
		const [notify, ...rest] = await registered(
			await setUpModules(),
			context(),
			"notify",
		);
		expect(rest).toEqual([]);
		expect(notify?.name).toBe("notify");
		expect((notify as unknown as { description: string }).description).toBe(
			"Send Owner a direct message on Discord. Use only when they asks to be notified or reminded by DM; your normal reply already reaches them.",
		);
	});

	test("each person's notice goes to their own direct channel, in their conversation or as the speaker of a shared one", async () => {
		const setup = await setUpModules({
			direct: { "1": OWNER_CHANNEL, p_ann: "discord:ann-dm" },
			conversations: {
				get: privately({ "other:ann": "p_ann", "other:own": "1" }),
			},
		});
		const owner = { ...OWNER_SPEAKER };
		const ann = { ...ANN, tier: "owner" as const };
		await notifyIn(setup, contextOf(ann, "other:ann"), "to ann");
		await notifyIn(setup, contextOf(owner, "other:own"), "to the owner");
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
			conversations: { get: privately({ "other:own": "1" }) },
		});
		const answer = await notifyIn(
			setup,
			contextOf({ ...ANN, tier: "owner" }, "other:own"),
			"from ann",
		);
		expect(answer?.error).toBe(true);
		expect(answer?.text).toContain("private to someone else");
		expect(setup.record.notified).toEqual([]);
	});

	test("a private conversation of someone no direct channel reaches gets no notify", async () => {
		const setup = await setUpModules({
			conversations: { get: privately({ "other:kai": "p_kai" }) },
		});
		expect(
			await registered(setup, contextOf(OWNER_SPEAKER, "other:kai"), "notify"),
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
