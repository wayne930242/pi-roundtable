import { describe, test } from "bun:test";
import type {
	PlaceAuthor,
	PlaceCheck,
	PlaceProvider,
	PlaceRef,
	PlaceSpec,
} from "../contract/places.ts";
import { parseChannelKey } from "../contract/surface.ts";
import type { ChannelKey } from "../domain/sessions.ts";
import { ContractBroken, expectThat } from "./surface-contract-support.ts";

/** One message a person watching a place has seen. */
export interface PlaceSeen {
	/** The name it was posted under. */
	author: string;
	text: string;
}

/**
 * A place provider under the contract, and what a person watching its surface sees. The contract
 * makes the places it needs through `ensure`, or, for a provider that cannot make them, asks
 * `bound` for one that exists.
 */
export interface PlaceContractSubject {
	provider: PlaceProvider;
	/** Every message a person watching the place has seen so far, oldest first, edits applied. */
	seen(key: ChannelKey): Promise<readonly PlaceSeen[]> | readonly PlaceSeen[];
	/** A stored place of the surface that exists, for a provider without `ensure`; the stored checks are skipped without it. */
	bound?(ref: PlaceRef): Promise<string>;
	/**
	 * A person deletes the place on the surface, and the surface reports it as it would: through the
	 * provider's `onRemoved` listeners. Without it the checks of a gone place are skipped.
	 */
	delete?(id: string): Promise<void>;
	/** An id that is no place of the provider's space, such as a channel of another server; without it the `foreign` check is skipped. */
	foreign?(): Promise<string>;
	close?(): Promise<void>;
}

/** One way the subject broke the contract. */
export interface PlaceContractFailure {
	name: string;
	error: unknown;
}

interface Check {
	name: string;
	/** Whether the check applies to this subject; a check that does not is skipped. */
	applies?(subject: PlaceContractSubject): boolean;
	run(subject: PlaceContractSubject): Promise<void>;
}

const AGENT: PlaceRef = { kind: "agent", name: "knight" };
const OTHER_AGENT: PlaceRef = { kind: "agent", name: "scribe" };
const GROUP: PlaceRef = { kind: "group", name: "round-table" };
const AUTHOR: PlaceAuthor = {
	name: "Sir Knight",
	agent: "knight",
	avatarUrl: "https://example.test/knight.png",
};

const specOf = (ref: PlaceRef): PlaceSpec => ({
	...ref,
	displayName: ref === AGENT ? "Sir Knight" : ref.name,
	topic: ref.kind === "agent" ? "Sir Knight" : "Knight and Scribe",
});

/** Waits until `done` holds, polling; what a person sees on a network can lag the call that showed it. */
async function until(
	done: () => boolean | Promise<boolean>,
	what: string,
	ms = 2000,
): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await done())) {
		if (Date.now() > deadline)
			throw new ContractBroken(`timed out waiting until ${what}`);
		await Bun.sleep(10);
	}
}

const stored = (subject: PlaceContractSubject) =>
	subject.provider.storage === "stored";

/** The id of a stored place for `ref`, made through `ensure` or bound by the subject; undefined when the subject offers neither. */
async function placeFor(
	subject: PlaceContractSubject,
	ref: PlaceRef,
): Promise<string | undefined> {
	if (subject.provider.ensure) return subject.provider.ensure(specOf(ref));
	return subject.bound?.(ref);
}

/** The key of a place of `ref`: from the name when derived, from a stored place's id otherwise; undefined without a place. */
async function keyFor(
	subject: PlaceContractSubject,
	ref: PlaceRef,
): Promise<{ key: ChannelKey; id?: string } | undefined> {
	const { provider } = subject;
	if (!stored(subject)) return { key: provider.key(ref) };
	const id = await placeFor(subject, ref);
	return id === undefined ? undefined : { key: provider.key(ref, id), id };
}

async function seenIn(
	subject: PlaceContractSubject,
	key: ChannelKey,
): Promise<readonly PlaceSeen[]> {
	return subject.seen(key);
}

function sameRef(found: unknown, ref: PlaceRef): boolean {
	return (
		typeof found === "object" &&
		found !== null &&
		(found as PlaceRef).kind === ref.kind &&
		(found as PlaceRef).name === ref.name
	);
}

const CHECKS: readonly Check[] = [
	{
		name: "names a surface without a colon, and a stored one says so",
		run: async ({ provider }) => {
			expectThat(
				provider.surface !== "" && !provider.surface.includes(":"),
				`"${provider.surface}" is not a surface name`,
			);
			expectThat(
				provider.storage === "derived" || provider.storage === "stored",
				`storage is ${String(provider.storage)}, not derived or stored`,
			);
			expectThat(
				provider.storage === "stored" || provider.ensure === undefined,
				"a derived provider makes no places, so it has no ensure",
			);
		},
	},
	{
		name: "a derived key comes from the name and reads back as it",
		applies: (subject) => !stored(subject),
		run: async ({ provider }) => {
			for (const ref of [AGENT, GROUP]) {
				const key = provider.key(ref);
				expectThat(
					parseChannelKey(key).surface === provider.surface,
					`${key} is no key of ${provider.surface}`,
				);
				expectThat(
					sameRef(provider.placeOf(key), ref),
					`${key} reads back as ${JSON.stringify(provider.placeOf(key))}, not ${ref.kind} ${ref.name}`,
				);
			}
			expectThat(
				provider.key(AGENT) !== provider.key(OTHER_AGENT) &&
					provider.key(AGENT) !== provider.key({ ...AGENT, kind: "group" }),
				"two places share a key",
			);
		},
	},
	{
		name: "a stored key carries the place's id and reads back as it",
		applies: (subject) => stored(subject),
		run: async ({ provider }) => {
			const key = provider.key(AGENT, "p-1");
			expectThat(
				parseChannelKey(key).surface === provider.surface,
				`${key} is no key of ${provider.surface}`,
			);
			const found = provider.placeOf(key);
			expectThat(
				typeof found === "object" && found !== null && "id" in found,
				`${key} reads back as ${JSON.stringify(found)}, not an id`,
			);
			expectThat(provider.key(AGENT, "p-2") !== key, "two ids share a key");
			expectThat(
				provider.placeOf(provider.key(GROUP, "p-1")) !== undefined,
				"a group's key does not read back",
			);
			let refused = false;
			try {
				provider.key(AGENT);
			} catch {
				refused = true;
			}
			expectThat(refused, "a stored key was made with no id");
		},
	},
	{
		name: "reads no key of another surface, and none that is no key, as its place",
		run: async ({ provider }) => {
			expectThat(
				provider.placeOf("other-surface:agent.knight") === undefined,
				"a key of another surface read as a place",
			);
			expectThat(
				provider.placeOf("not a key" as ChannelKey) === undefined,
				"a text that is no key read as a place",
			);
		},
	},
	{
		name: "posts under the author's name, with every chunk and the thinking",
		run: async (subject) => {
			const place = await keyFor(subject, AGENT);
			if (!place) return;
			await subject.provider.post(place.key, {
				author: AUTHOR,
				thinking: "mulling it over",
				chunks: ["first part", "second part"],
			});
			await until(
				async () => (await seenIn(subject, place.key)).length > 0,
				"the person sees the post",
			);
			const shown = await seenIn(subject, place.key);
			const text = shown.map((m) => m.text).join("\n");
			for (const part of ["mulling it over", "first part", "second part"])
				expectThat(text.includes(part), `the person did not see "${part}"`);
			expectThat(
				shown.every((m) => m.author === AUTHOR.name),
				`posted under ${[...new Set(shown.map((m) => m.author))].join(", ")}, not ${AUTHOR.name}`,
			);
		},
	},
	{
		name: "posts a group's place apart from an agent's",
		run: async (subject) => {
			const agent = await keyFor(subject, AGENT);
			const group = await keyFor(subject, GROUP);
			if (!agent || !group) return;
			await subject.provider.post(group.key, {
				author: AUTHOR,
				chunks: ["for the table"],
			});
			await until(
				async () => (await seenIn(subject, group.key)).length > 0,
				"the person sees the group's post",
			);
			expectThat(
				(await seenIn(subject, agent.key)).length === 0,
				"a group's post showed in an agent's place",
			);
		},
	},
	{
		name: "interim posts speak under the author and are edited in place",
		applies: (subject) => subject.provider.interim !== undefined,
		run: async (subject) => {
			const place = await keyFor(subject, AGENT);
			if (!place) return;
			const posts = subject.provider.interim?.(place.key, AUTHOR);
			if (!posts) return;
			const message = await posts.post("working on it");
			await until(
				async () =>
					(await seenIn(subject, place.key)).some(
						(m) => m.text === "working on it",
					),
				"the person sees the interim post",
			);
			await message.edit("nearly done");
			await until(
				async () =>
					(await seenIn(subject, place.key)).some(
						(m) => m.text === "nearly done",
					),
				"the person sees the edit",
			);
			const shown = await seenIn(subject, place.key);
			expectThat(
				!shown.some((m) => m.text === "working on it"),
				"the edit left the first text beside it",
			);
			expectThat(
				shown.every((m) => m.author === AUTHOR.name),
				"an interim post was not under the author's name",
			);
		},
	},
	{
		name: "ensure makes a place of its own for each owner, with a key that reads back",
		applies: (subject) => subject.provider.ensure !== undefined,
		run: async (subject) => {
			const { provider } = subject;
			const first = await provider.ensure?.(specOf(AGENT));
			const second = await provider.ensure?.(specOf(OTHER_AGENT));
			expectThat(
				typeof first === "string" && first !== "",
				"ensure did not resolve to an id",
			);
			expectThat(
				typeof second === "string" && second !== "" && second !== first,
				"two owners got one place",
			);
			const found = provider.placeOf(provider.key(AGENT, first as string));
			expectThat(
				typeof found === "object" &&
					found !== null &&
					"id" in found &&
					found.id === first,
				`the key of ${first} reads back as ${JSON.stringify(found)}`,
			);
		},
	},
	{
		name: "ensure brings an existing place back under its own id",
		applies: (subject) => subject.provider.ensure !== undefined,
		run: async ({ provider }) => {
			const id = await provider.ensure?.(specOf(AGENT));
			if (id === undefined) return;
			const again = await provider.ensure?.({ ...specOf(AGENT), existing: id });
			expectThat(again === id, `ensure with existing ${id} made ${again}`);
		},
	},
	{
		name: "remove keeps the place, and ensure brings it back",
		applies: (subject) =>
			subject.provider.ensure !== undefined &&
			subject.provider.remove !== undefined,
		run: async ({ provider }) => {
			const spec = specOf(AGENT);
			const id = await provider.ensure?.(spec);
			if (id === undefined) return;
			const line = await provider.remove?.(id, { ...spec, helper: false });
			expectThat(
				line === undefined || typeof line === "string",
				"remove resolved to something that is no line of text",
			);
			if (provider.check)
				expectThat(
					(await provider.check(id)) !== "gone",
					"remove deleted the place; it should keep it with its history",
				);
			const back = await provider.ensure?.({ ...spec, existing: id });
			expectThat(back === id, `the restored place is ${back}, not ${id}`);
		},
	},
	{
		name: "check finds a place that is there ok",
		applies: (subject) => subject.provider.check !== undefined,
		run: async (subject) => {
			const id = await placeFor(subject, AGENT);
			if (id === undefined) return;
			const found = await subject.provider.check?.(id);
			expectThat(found === "ok", `check of a place that is there: ${found}`);
		},
	},
	{
		name: "check finds a place a person deleted gone, and tells the listeners",
		applies: (subject) =>
			subject.provider.check !== undefined && subject.delete !== undefined,
		run: async (subject) => {
			const id = await placeFor(subject, AGENT);
			if (id === undefined) return;
			const heard: string[] = [];
			subject.provider.onRemoved?.((removed) => heard.push(removed));
			await subject.delete?.(id);
			const found: PlaceCheck | undefined = await subject.provider.check?.(id);
			expectThat(found === "gone", `check of a deleted place: ${found}`);
			if (subject.provider.onRemoved)
				await until(
					() => heard.includes(id),
					"the provider reports the deleted place",
				);
		},
	},
	{
		name: "check finds a place of another space foreign, not gone",
		applies: (subject) =>
			subject.provider.check !== undefined && subject.foreign !== undefined,
		run: async (subject) => {
			const id = await subject.foreign?.();
			if (id === undefined) return;
			const found = await subject.provider.check?.(id);
			expectThat(found === "foreign", `check of a foreign place: ${found}`);
		},
	},
	{
		name: "describe writes a topic without failing",
		applies: (subject) => subject.provider.describe !== undefined,
		run: async (subject) => {
			const id = await placeFor(subject, GROUP);
			if (id === undefined) return;
			await subject.provider.describe?.(
				id,
				"Knight and Scribe, hosted by Knight",
			);
		},
	},
	{
		name: "mentions a place in words",
		applies: (subject) => subject.provider.mention !== undefined,
		run: async (subject) => {
			const place = await keyFor(subject, AGENT);
			if (!place) return;
			const mention = subject.provider.mention?.(place.key);
			expectThat(
				typeof mention === "string" && mention !== "",
				"a mention is no text",
			);
		},
	},
	{
		name: "a group's seats and log are conversations of their own",
		applies: (subject) => subject.provider.conversations !== undefined,
		run: async ({ provider }) => {
			const forms = provider.conversations;
			if (!forms) return;
			const seat = forms.seat("g-1", "knight");
			const log = forms.log("round-table");
			expectThat(
				forms.seat("g-1", "knight") === seat &&
					forms.log("round-table") === log,
				"a seat's key or a log name changes between calls",
			);
			expectThat(
				seat !== forms.seat("g-1", "scribe") &&
					seat !== forms.seat("g-2", "knight") &&
					log !== forms.log("other-table"),
				"two seats or two logs share a key",
			);
		},
	},
];

async function runCheck(
	check: Check,
	make: () => Promise<PlaceContractSubject>,
): Promise<"passed" | "skipped"> {
	const subject = await make();
	try {
		if (check.applies && !check.applies(subject)) return "skipped";
		await check.run(subject);
		return "passed";
	} finally {
		await subject.close?.();
	}
}

/**
 * Runs the place provider contract on fresh subjects from `make`, one per check, and returns the
 * checks the provider broke. `placeProviderContract` registers the same checks as tests.
 */
export async function checkPlaceProviderContract(
	make: () => Promise<PlaceContractSubject>,
): Promise<PlaceContractFailure[]> {
	const failures: PlaceContractFailure[] = [];
	for (const check of CHECKS) {
		try {
			await runCheck(check, make);
		} catch (error) {
			failures.push({ name: check.name, error });
		}
	}
	return failures;
}

/**
 * Registers the place provider contract as one test per check, under `name`: the provider names
 * a surface and a storage, its keys read back as the places they came from (a derived one's from
 * the name, a stored one's from the id) and no foreign key does, a post shows under the author's
 * name with every chunk, and, where it offers them, interim posts are edited in place, `ensure`
 * makes a place for each owner and brings an existing one back under its id, `remove` keeps the
 * place, `check` tells a place that is there from one deleted (`gone`) or of another space
 * (`foreign`), a deleted place is reported to `onRemoved`, and a group's seats and log are
 * conversations of their own. Each check gets a fresh subject from `make`; a check for an
 * optional part the provider lacks passes.
 */
export function placeProviderContract(
	name: string,
	make: () => Promise<PlaceContractSubject>,
): void {
	describe(`${name} keeps the place provider contract`, () => {
		for (const check of CHECKS)
			test(check.name, async () => {
				await runCheck(check, make);
			});
	});
}
