import { join } from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { FakeChannels } from "./fake-agent-channels.ts";

/** Channels with ids of their own, which no other test's rows hold. */
export class CaptureChannels extends FakeChannels {
	#next = 1;
	override async createChannel(
		name: string,
		topic: string,
		category: Parameters<FakeChannels["createChannel"]>[2],
	) {
		this.created.push(name);
		const id = `96666661000000000${this.#next++}`;
		this.topics.set(id, topic);
		this.put(id, category);
		return id;
	}
}

/** A faux model whose every answer is "OK." and that records the first request of each turn. */
export async function fauxModel(dir: string) {
	const core = createFauxCore({ provider: "faux", models: [{ id: "faux-1" }] });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider("faux", {
		api: core.api,
		apiKey: "test",
		baseUrl: "http://faux.invalid",
		streamSimple: core.streamSimple,
		models: [
			{
				id: "faux-1",
				name: "Faux",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 1_000,
			},
		],
	});
	/** Runs the action and returns the first request the model saw during it. */
	const capture = async (
		action: () => Promise<unknown>,
	): Promise<TranscriptContext> => {
		let seen: TranscriptContext | undefined;
		const step = (context: TranscriptContext) => {
			seen ??= context;
			return fauxAssistantMessage("OK.");
		};
		core.setResponses([step, step, step, step]);
		await action();
		if (!seen) throw new Error("the turn sent the model nothing");
		return seen;
	};
	return { modelRuntime, capture };
}
