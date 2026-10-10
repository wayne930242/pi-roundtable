import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	definePlugin,
	defineTool,
	ToolRefusal,
	type ToolTurn,
} from "./define.ts";
import { PluginError } from "./errors.ts";
import { messages } from "./i18n/index.ts";
import type { SessionContext } from "./sessions.ts";
import type { Speaker } from "./speakers.ts";

const speaker: Speaker = {
	id: "1",
	name: "Ann",
	tier: "admin",
	principalId: "1",
};

const note = {
	name: "note_add",
	description: "Save a note.",
	parameters: Type.Object({ text: Type.String() }),
	minTier: "member" as const,
	run: (args: { text: string }) => `saved ${args.text}`,
};

type Registered = {
	name: string;
	execute(
		id: string,
		params: unknown,
		signal?: AbortSignal,
	): Promise<{ content: { text: string }[]; isError?: boolean }>;
};

/** Registers the tool in a fake Pi session the way the runtime does, and returns what it registered. */
function register(tool: ReturnType<typeof defineTool>): Registered {
	const registered: Registered[] = [];
	const context = {
		speaker: () => speaker,
		turnChannel: "discord:2",
		agent: { name: "helper", session: "discord:2", home: "discord:2" },
	} as unknown as SessionContext;
	const factory = tool.session.snapshot().factory(context);
	factory?.({
		registerTool: (def: Registered) => registered.push(def),
	} as unknown as ExtensionAPI);
	const [one] = registered;
	if (!one) throw new Error("nothing was registered");
	return one;
}

describe("defineTool", () => {
	test("registers the tool in a session and runs it with the turn's speaker", async () => {
		let seen: unknown;
		const tool = defineTool({
			...note,
			run: (args, turn) => {
				seen = { args, speaker: turn.speaker, channel: turn.channel };
				return "ok";
			},
		});
		const result = await register(tool).execute("call", { text: "milk" });
		expect(result.content[0]?.text).toBe("ok");
		expect(seen).toEqual({
			args: { text: "milk" },
			speaker,
			channel: "discord:2",
		});
		expect(tool.session.snapshot().requiredTools).toEqual(["note_add"]);
		expect(tool.minTier).toBe("member");
		expect(tool.agent).toBe(true);
	});

	test("a ToolRefusal becomes an error result the model reads; any other error fails the call", async () => {
		const refuse = defineTool({
			...note,
			run: () => {
				throw new ToolRefusal("no empty notes");
			},
		});
		const refused = await register(refuse).execute("c", { text: "" });
		expect(refused.isError).toBe(true);
		expect(refused.content[0]?.text).toBe("no empty notes");
		const fail = defineTool({
			...note,
			run: () => {
				throw new Error("disk gone");
			},
		});
		await expect(register(fail).execute("c", { text: "x" })).rejects.toThrow(
			"disk gone",
		);
	});

	test("its hold rule describes the tool's own calls and no other", () => {
		const tool = defineTool({
			...note,
			hold: (args) => (args.text === "rm" ? "delete everything" : undefined),
		});
		const rule = tool.hold;
		expect(rule?.name).toBe("tool:note_add");
		expect(rule?.describe("note_add", { text: "rm" }, {})).toBe(
			"delete everything",
		);
		expect(rule?.describe("note_add", { text: "hi" }, {})).toBeUndefined();
		expect(rule?.describe("other", { text: "rm" }, {})).toBeUndefined();
	});

	test("a hold that looks things up gets the turn in a turn, and the generic description where there is none", async () => {
		const seen: ToolTurn[] = [];
		const tool = defineTool({
			...note,
			hold: async (args, turn) => {
				seen.push(turn);
				return `save ${args.text} for ${turn.speaker?.name}`;
			},
		});
		const rule = tool.hold;
		const turn = {
			speaker,
			channel: "discord:2",
			signal: undefined,
		} as unknown as ToolTurn;
		expect(
			await rule?.describeInTurn?.("note_add", { text: "hi" }, {}, turn),
		).toBe("save hi for Ann");
		expect(seen).toEqual([turn]);
		expect(
			await rule?.describeInTurn?.("other", { text: "hi" }, {}, turn),
		).toBeUndefined();
		// Without a turn the hold is not called; the call is still held.
		expect(rule?.describe("note_add", { text: "hi" }, {})).toBe(
			messages().holdGeneric("note_add"),
		);
		expect(seen).toHaveLength(1);
	});

	test("a hold that answers later without declaring the turn is held generically where there is none, and its rejection stays quiet", async () => {
		const tool = defineTool({
			...note,
			hold: async () => {
				throw new Error("directory is down");
			},
		});
		expect(tool.hold?.describe("note_add", { text: "hi" }, {})).toBe(
			messages().holdGeneric("note_add"),
		);
		await Bun.sleep(5);
	});

	test("a hold that declares only its arguments is called as before in a turn too", async () => {
		const tool = defineTool({
			...note,
			hold: (args) => (args.text === "rm" ? "delete everything" : undefined),
		});
		const turn = { speaker } as unknown as ToolTurn;
		expect(
			await tool.hold?.describeInTurn?.("note_add", { text: "rm" }, {}, turn),
		).toBe("delete everything");
		expect(
			await tool.hold?.describeInTurn?.("note_add", { text: "hi" }, {}, turn),
		).toBeUndefined();
	});

	test("each mistake is refused with the tool's name and the fix", () => {
		const refused = (change: Record<string, unknown>) => () =>
			defineTool({ ...note, ...change } as typeof note);
		expect(refused({ name: "NoteAdd" })).toThrow(PluginError);
		expect(refused({ name: "NoteAdd" })).toThrow(
			'tool "NoteAdd": the name must be lowercase words joined by underscores, such as note_add. Rename the tool.',
		);
		expect(refused({ name: "bash" })).toThrow(
			"tool bash: the agents already have a tool of this name. Rename the tool.",
		);
		expect(refused({ minTier: undefined })).toThrow(
			"tool note_add: minTier must be one of member, admin, owner; got undefined. Set the lowest tier that may use it.",
		);
		expect(refused({ description: " " })).toThrow(
			"tool note_add: the description is empty. Tell the model when to call the tool.",
		);
		expect(refused({ run: undefined })).toThrow(
			"tool note_add: run is missing. Give the function the tool runs.",
		);
	});
});

describe("definePlugin", () => {
	const setup = () => ({});

	test("returns the plugin it was given", () => {
		const plugin = { name: "my-notes", setup };
		expect(definePlugin(plugin)).toBe(plugin);
	});

	test("refuses a name that is not lowercase words joined by dashes, and a missing setup", () => {
		expect(() => definePlugin({ name: "My Notes", setup })).toThrow(
			'plugin "My Notes": the name must be lowercase words joined by dashes, such as my-notes. Rename the plugin.',
		);
		expect(() =>
			definePlugin({ name: "notes" } as unknown as Parameters<
				typeof definePlugin
			>[0]),
		).toThrow(
			"plugin notes: setup is missing. Give the function that returns what the plugin adds.",
		);
	});
});
