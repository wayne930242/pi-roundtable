import { describe, expect, test } from "bun:test";
import type { Interaction } from "discord.js";
import type { OwnerQuestion } from "../domain/owner-prompts.ts";
import { messages } from "../i18n/index.ts";
import { silentLogger } from "../log.ts";
import { mapIdentity } from "../testing/map-identity.ts";
import {
	CARD_PREFIX,
	type CardPayload,
	OwnerCards,
	type OwnerCardsOptions,
} from "./owner-cards.ts";

const OWNER = "100000000000000001";

/** The card's JSON, where its text, custom ids, and disabled flags can be read. */
const json = (payload: CardPayload | undefined) =>
	JSON.stringify(payload?.components.map((c) => c.toJSON()));

/** A channel, or a thread, that records the cards sent to it and every edit of them. */
function fakeChannel(thread = false) {
	const sent: CardPayload[] = [];
	const edits: CardPayload[] = [];
	return {
		sent,
		edits,
		/** The id of the latest card sent. */
		cardId: () =>
			json(sent.at(-1)).match(new RegExp(`${CARD_PREFIX}([0-9a-f-]+):`))?.[1] ??
			"",
		channel: async () => ({
			thread,
			send: async (payload: CardPayload) => {
				sent.push(payload);
				return {
					edit: async (change: CardPayload) => {
						edits.push(change);
					},
				};
			},
		}),
	};
}

type Kind = "button" | "select" | "modal";

/** A press of a card's control, recording how it was answered. */
function press(
	kind: Kind,
	customId: string,
	options: {
		user?: string;
		roles?: string[];
		values?: string[];
		text?: string;
	} = {},
) {
	const replies: string[] = [];
	const updates: CardPayload[] = [];
	const modals: unknown[] = [];
	const interaction = {
		isButton: () => kind === "button",
		isStringSelectMenu: () => kind === "select",
		isModalSubmit: () => kind === "modal",
		isFromMessage: () => true,
		customId,
		user: { id: options.user ?? OWNER },
		member: {
			roles: { cache: new Map((options.roles ?? []).map((r) => [r, r])) },
		},
		values: options.values ?? [],
		fields: { getTextInputValue: () => options.text ?? "" },
		reply: async (answer: { content: string }) => {
			replies.push(answer.content);
		},
		update: async (payload: CardPayload) => {
			updates.push(payload);
		},
		showModal: async (modal: unknown) => {
			modals.push(modal);
		},
		deferUpdate: async () => undefined,
	} as unknown as Interaction;
	return { interaction, replies, updates, modals };
}

function setup(options: Partial<OwnerCardsOptions> = {}) {
	const fake = fakeChannel();
	const cards = new OwnerCards({
		ownerId: OWNER,
		channel: fake.channel,
		logger: silentLogger(),
		...options,
	});
	const prompts = cards.prompts("discord:555");
	if (!prompts) throw new Error("no prompts for a Discord channel");
	return { fake, cards, prompts };
}

const tick = () => Bun.sleep(1);

describe("OwnerCards", () => {
	test("a dispatch thread's cards are posted in the thread", async () => {
		const asked: string[] = [];
		const fake = fakeChannel();
		const cards = new OwnerCards({
			ownerId: OWNER,
			channel: async (channelId) => {
				asked.push(channelId);
				return fake.channel();
			},
			logger: silentLogger(),
			timeoutMs: 5,
		});
		await cards.prompts("discord:900")?.confirm("t", "m");
		expect(asked).toEqual(["900"]);
		expect(fake.sent).toHaveLength(1);
	});

	test("the owner approves; the card then shows the outcome with its buttons disabled", async () => {
		const { fake, cards, prompts } = setup();
		const answer = prompts.confirm(
			"The assistant wants to run this action",
			"**send mail**",
		);
		await tick();
		expect(json(fake.sent[0])).toContain("send mail");
		expect(json(fake.sent[0])).toContain(messages().cardRunLabel);
		const yes = press("button", `${CARD_PREFIX}${fake.cardId()}:yes`);
		expect(await cards.handle(yes.interaction)).toBe(true);
		expect(await answer).toBe("approved");
		expect(json(yes.updates[0])).toContain(messages().cardApproved);
		expect(json(yes.updates[0])).toContain('"disabled":true');
	});

	test("a card in a channel mentions nobody", async () => {
		const { fake, prompts } = setup({ timeoutMs: 5 });
		await prompts.confirm(
			"The assistant wants to run this action",
			"**send mail**",
		);
		expect(fake.sent[0]?.allowedMentions).toEqual({ parse: [] });
		expect(json(fake.sent[0])).not.toContain(`<@${OWNER}>`);
	});

	test("a card in a thread mentions the owner alone, above the unchanged card", async () => {
		const inChannel = fakeChannel();
		const inThread = fakeChannel(true);
		const cards = (fake: ReturnType<typeof fakeChannel>) =>
			new OwnerCards({
				ownerId: OWNER,
				channel: fake.channel,
				logger: silentLogger(),
			});
		const threadCards = cards(inThread);
		void cards(inChannel).prompts("discord:555")?.confirm("t", "**m**");
		const answer = threadCards.prompts("discord:900")?.confirm("t", "**m**");
		await tick();
		const card = inThread.sent[0];
		expect(card?.allowedMentions).toEqual({ users: [OWNER] });
		const [mention, ...panel] = card?.components ?? [];
		expect(mention?.toJSON()).toMatchObject({ content: `<@${OWNER}>` });
		// Past the mention the card is the one a channel gets.
		expect(JSON.stringify(panel.map((c) => c.toJSON()))).toBe(
			json(inChannel.sent[0]).replaceAll(inChannel.cardId(), inThread.cardId()),
		);
		const yes = press("button", `${CARD_PREFIX}${inThread.cardId()}:yes`);
		await threadCards.handle(yes.interaction);
		expect(await answer).toBe("approved");
		// The closed card keeps its mention line.
		expect(json(yes.updates[0])).toContain(`<@${OWNER}>`);
	});

	test("only the owner may answer; anyone else is refused and the card stays open", async () => {
		const { fake, cards, prompts } = setup();
		const answer = prompts.confirm("t", "m");
		await tick();
		const id = fake.cardId();
		const stranger = press("button", `${CARD_PREFIX}${id}:yes`, { user: "1" });
		await cards.handle(stranger.interaction);
		expect(stranger.replies).toEqual([messages().cardOwnerOnly]);
		expect(stranger.updates).toHaveLength(0);
		const no = press("button", `${CARD_PREFIX}${id}:no`);
		await cards.handle(no.interaction);
		expect(await answer).toBe("declined");
		expect(json(no.updates[0])).toContain(messages().cardDeclined);
	});

	test("an unanswered card expires and is edited to say so", async () => {
		const { fake, cards, prompts } = setup({ timeoutMs: 5 });
		expect(await prompts.confirm("t", "m")).toBe("expired");
		await tick();
		expect(json(fake.edits[0])).toContain(messages().cardExpired);
		expect(json(fake.edits[0])).toContain('"disabled":true');
		// A late press finds the card gone.
		const late = press("button", `${CARD_PREFIX}${fake.cardId()}:yes`);
		await cards.handle(late.interaction);
		expect(late.replies[0]).toContain(messages().cardInactive);
	});

	test("a stopped turn cancels its card", async () => {
		const { fake, prompts } = setup();
		const stop = new AbortController();
		const answer = prompts.confirm("t", "m", stop.signal);
		await tick();
		stop.abort();
		expect(await answer).toBe("cancelled");
		await tick();
		expect(json(fake.edits[0])).toContain(messages().cardStopped);
	});

	test("a card that cannot be posted counts as expired", async () => {
		const { prompts } = setup({
			channel: async () => {
				throw new Error("missing access");
			},
		});
		expect(await prompts.confirm("t", "m")).toBe("expired");
	});

	test("a press of a card from before a restart says it no longer works", async () => {
		const { cards } = setup();
		const old = press("button", `${CARD_PREFIX}gone:yes`);
		expect(await cards.handle(old.interaction)).toBe(true);
		expect(old.replies[0]).toContain(messages().cardInactive);
	});

	test("other components are left to other modules", async () => {
		const { cards } = setup();
		expect(
			await cards.handle(press("button", "roundtable:stop").interaction),
		).toBe(false);
	});

	describe("questions", () => {
		const question = (q: Partial<OwnerQuestion>): OwnerQuestion => ({
			question: "Which day?",
			options: [
				{ label: "Saturday", description: "morning" },
				{ label: "Sunday" },
				{ label: "Monday" },
			],
			multi: false,
			allowOther: false,
			...q,
		});

		test("a single choice", async () => {
			const { fake, cards, prompts } = setup();
			const answer = prompts.ask(
				"The assistant has a question for you",
				question({}),
			);
			await tick();
			const card = json(fake.sent[0]);
			expect(card).toContain("Which day?");
			expect(card).toContain('"max_values":1');
			expect(card).not.toContain(messages().cardOtherLabel);
			const pick = press("select", `${CARD_PREFIX}${fake.cardId()}:pick`, {
				values: ["1"],
			});
			await cards.handle(pick.interaction);
			expect(await answer).toEqual({ choices: ["Sunday"] });
			expect(json(pick.updates[0])).toContain(
				messages().cardAnswered(["Sunday"]),
			);
		});

		test("several choices, in the order they were offered", async () => {
			const { fake, cards, prompts } = setup();
			const answer = prompts.ask("t", question({ multi: true }));
			await tick();
			expect(json(fake.sent[0])).toContain('"max_values":3');
			await cards.handle(
				press("select", `${CARD_PREFIX}${fake.cardId()}:pick`, {
					values: ["2", "0"],
				}).interaction,
			);
			expect(await answer).toEqual({ choices: ["Saturday", "Monday"] });
		});

		test("the other option opens a form, and its text comes back with the other choices", async () => {
			const { fake, cards, prompts } = setup();
			const answer = prompts.ask(
				"t",
				question({ multi: true, allowOther: true }),
			);
			await tick();
			const id = fake.cardId();
			expect(json(fake.sent[0])).toContain(messages().cardOtherLabel);
			const pick = press("select", `${CARD_PREFIX}${id}:pick`, {
				values: ["0", "other"],
			});
			await cards.handle(pick.interaction);
			expect(pick.modals).toHaveLength(1);
			expect(pick.updates).toHaveLength(0);
			const submit = press("modal", `${CARD_PREFIX}${id}:text`, {
				text: "Wednesday evening",
			});
			await cards.handle(submit.interaction);
			expect(await answer).toEqual({
				choices: ["Saturday"],
				text: "Wednesday evening",
			});
			expect(json(submit.updates[0])).toContain("Wednesday evening");
		});

		test("without options, a button opens the answer form", async () => {
			const { fake, cards, prompts } = setup();
			const answer = prompts.ask("t", question({ options: [] }));
			await tick();
			const id = fake.cardId();
			const write = press("button", `${CARD_PREFIX}${id}:write`);
			await cards.handle(write.interaction);
			expect(write.modals).toHaveLength(1);
			await cards.handle(
				press("modal", `${CARD_PREFIX}${id}:text`, { text: "anything" })
					.interaction,
			);
			expect(await answer).toEqual({ choices: [], text: "anything" });
		});

		test("an unanswered question has no answer", async () => {
			const { prompts } = setup({ timeoutMs: 5 });
			expect(await prompts.ask("t", question({}))).toBeUndefined();
		});
	});
});

describe("cards for lower tiers", () => {
	const ADMIN = "100000000000000002";
	const MEMBER = "100000000000000003";
	const ROLE = "100000000000000004";
	const identity = mapIdentity({
		owners: [OWNER],
		admins: { users: [ADMIN] },
		members: { roles: [ROLE] },
	});
	const askAdminApproval = () => {
		const fake = fakeChannel();
		const cards = new OwnerCards({
			ownerId: OWNER,
			identity,
			channel: fake.channel,
			logger: silentLogger(),
		});
		const speaker = {
			id: ADMIN,
			name: "Ada",
			tier: "admin",
			principalId: ADMIN,
		} as const;
		const answer = cards
			.prompts("discord:555", speaker)
			?.confirm("t", "**create an agent**", undefined, "admin");
		return { fake, cards, answer };
	};

	test("an approval for admin tools shows who may approve and takes an admin's press", async () => {
		const { fake, cards, answer } = askAdminApproval();
		await tick();
		expect(json(fake.sent[0])).toContain(messages().cardApproversNote(ADMIN));
		const admin = press("button", `${CARD_PREFIX}${fake.cardId()}:yes`, {
			user: ADMIN,
		});
		await cards.handle(admin.interaction);
		expect(await answer).toBe("approved");
		expect(admin.replies).toEqual([]);
	});

	test("the owner may approve it too, but a member may not", async () => {
		const { fake, cards, answer } = askAdminApproval();
		await tick();
		const member = press("button", `${CARD_PREFIX}${fake.cardId()}:yes`, {
			user: MEMBER,
			roles: [ROLE],
		});
		await cards.handle(member.interaction);
		expect(member.replies).toEqual([messages().cardApproversRefusal]);
		const owner = press("button", `${CARD_PREFIX}${fake.cardId()}:no`, {
			user: OWNER,
		});
		await cards.handle(owner.interaction);
		expect(await answer).toBe("declined");
	});

	/** A member-tier call held in `speaker`'s turn, where two members share the channel. */
	const askMemberApproval = (speaker: {
		id: string;
		name: string;
		tier: "owner" | "member";
	}) => {
		const fake = fakeChannel();
		const cards = new OwnerCards({
			ownerId: OWNER,
			identity,
			channel: fake.channel,
			logger: silentLogger(),
		});
		const answer = cards
			.prompts("discord:555", { ...speaker, principalId: speaker.id })
			?.confirm("t", "**search the web**", undefined, "member");
		return { fake, cards, answer };
	};
	const OTHER_MEMBER = "100000000000000005";

	test("another member may not approve a member's held call; the speaker may", async () => {
		const { fake, cards, answer } = askMemberApproval({
			id: MEMBER,
			name: "Mo",
			tier: "member",
		});
		await tick();
		const other = press("button", `${CARD_PREFIX}${fake.cardId()}:yes`, {
			user: OTHER_MEMBER,
			roles: [ROLE],
		});
		await cards.handle(other.interaction);
		expect(other.replies).toEqual([messages().cardApproversRefusal]);
		const own = press("button", `${CARD_PREFIX}${fake.cardId()}:yes`, {
			user: MEMBER,
			roles: [ROLE],
		});
		await cards.handle(own.interaction);
		expect(await answer).toBe("approved");
	});

	test("in the owner's turn, a member may not approve a member-tier call", async () => {
		const { fake, cards, answer } = askMemberApproval({
			id: OWNER,
			name: "Owner",
			tier: "owner",
		});
		await tick();
		const member = press("button", `${CARD_PREFIX}${fake.cardId()}:yes`, {
			user: MEMBER,
			roles: [ROLE],
		});
		await cards.handle(member.interaction);
		expect(member.replies).toEqual([messages().cardOwnerOnly]);
		const owner = press("button", `${CARD_PREFIX}${fake.cardId()}:no`, {
			user: OWNER,
		});
		await cards.handle(owner.interaction);
		expect(await answer).toBe("declined");
	});

	test("a speaker below the call's tier leaves the approval to the owner", async () => {
		const fake = fakeChannel();
		const cards = new OwnerCards({
			ownerId: OWNER,
			identity,
			channel: fake.channel,
			logger: silentLogger(),
		});
		const speaker = {
			id: MEMBER,
			name: "Mo",
			tier: "member",
			principalId: MEMBER,
		} as const;
		void cards
			.prompts("discord:555", speaker)
			?.confirm("t", "**create an agent**", undefined, "admin");
		await tick();
		for (const [user, roles] of [
			[MEMBER, [ROLE]],
			[ADMIN, []],
		] as const) {
			const pressed = press("button", `${CARD_PREFIX}${fake.cardId()}:yes`, {
				user,
				roles: [...roles],
			});
			await cards.handle(pressed.interaction);
			expect(pressed.replies).toEqual([messages().cardOwnerOnly]);
		}
	});

	test("a report turn at the owner tier mentions the owner in a thread, as an owner's own card does", async () => {
		// The ops reporter speaks as "assistant"; a Discord webhook report as the webhook's id.
		for (const id of ["assistant", "100000000000000009"]) {
			const card = async (speaker?: {
				id: string;
				name: string;
				tier: "owner";
				principalId: string;
			}) => {
				const fake = fakeChannel(true);
				const cards = new OwnerCards({
					ownerId: OWNER,
					identity,
					channel: fake.channel,
					logger: silentLogger(),
					timeoutMs: 5,
				});
				void cards.prompts("discord:555", speaker)?.confirm("t", "**fix CI**");
				await tick();
				const sent = fake.sent[0];
				return {
					text: json(sent).replaceAll(fake.cardId(), "<card>"),
					mentions: sent?.allowedMentions,
				};
			};
			const report = await card({
				id,
				name: "reporter",
				tier: "owner",
				principalId: id,
			});
			expect(report.text).toContain(`<@${OWNER}>`);
			expect(report.text).not.toContain(`<@${id}>`);
			expect(report.text).not.toContain(
				JSON.stringify(messages().cardApproversNote(id)).slice(1, -1),
			);
			expect(report.mentions).toEqual({ users: [OWNER] });
			expect(report).toEqual(await card());
		}
	});

	test("a shell approval stays the owner's even when the speaker is an admin", async () => {
		const fake = fakeChannel();
		const cards = new OwnerCards({
			ownerId: OWNER,
			identity,
			channel: fake.channel,
			logger: silentLogger(),
		});
		const speaker = {
			id: ADMIN,
			name: "Ada",
			tier: "admin",
			principalId: ADMIN,
		} as const;
		void cards.prompts("discord:555", speaker)?.confirm("t", "**rm**");
		await tick();
		const admin = press("button", `${CARD_PREFIX}${fake.cardId()}:yes`, {
			user: ADMIN,
		});
		await cards.handle(admin.interaction);
		expect(admin.replies).toEqual([messages().cardOwnerOnly]);
	});

	test("a question is for the speaker who is asked, and the owner", async () => {
		const fake = fakeChannel();
		const cards = new OwnerCards({
			ownerId: OWNER,
			identity,
			channel: fake.channel,
			logger: silentLogger(),
		});
		const speaker = {
			id: ADMIN,
			name: "Ada",
			tier: "admin",
			principalId: ADMIN,
		} as const;
		const question = {
			question: "Which one?",
			options: [{ label: "First" }, { label: "Second" }],
			multi: false,
			allowOther: false,
		};
		const answer = cards.prompts("discord:555", speaker)?.ask("t", question);
		await tick();
		const stranger = press("select", `${CARD_PREFIX}${fake.cardId()}:pick`, {
			user: MEMBER,
			values: ["0"],
		});
		await cards.handle(stranger.interaction);
		expect(stranger.replies).toEqual([messages().cardAskerRefusal]);
		const asked = press("select", `${CARD_PREFIX}${fake.cardId()}:pick`, {
			user: ADMIN,
			values: ["1"],
		});
		await cards.handle(asked.interaction);
		expect(await answer).toEqual({ choices: ["Second"] });
	});
});
