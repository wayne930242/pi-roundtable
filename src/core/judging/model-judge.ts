import type {
	Api,
	AssistantMessage,
	Context,
	Model,
} from "@earendil-works/pi-ai";
import type {
	ChoiceAnswer,
	ChoiceQuestion,
	Judge,
	ScoreQuestion,
	YesNoQuestion,
} from "../contract/providers.ts";
import { JudgeError } from "../errors.ts";

/** One completion: a system prompt and a user message in, the model's text out. */
export type JudgeModel = (system: string, prompt: string) => Promise<string>;

const SYSTEM = [
	"You judge a situation for a chat assistant. Read the state and the question, then answer",
	"with exactly one JSON object in the requested format: no prose, no code fence.",
	"Every number is a probability from 0 to 1. For a yes-or-no question it is the probability",
	"that the answer is yes, so a clear no is near 0 and a clear yes near 1.",
].join(" ");

type Json = Record<string, unknown>;

// pi-lens-ignore: no-unknown-parameters — a type guard over parsed JSON
const isRecord = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);

// pi-lens-ignore: no-unknown-parameters — a type guard over parsed JSON
const isProbability = (value: unknown): value is number =>
	typeof value === "number" && value >= 0 && value <= 1;

/** The one JSON object in the model's answer, tolerating a code fence or stray words around it. */
function answerObject(text: string): Json {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end < start)
		throw new JudgeError(
			`the judge did not answer with JSON: ${text.slice(0, 200)}`,
		);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		throw new JudgeError(
			`the judge answered malformed JSON: ${text.slice(0, 200)}`,
		);
	}
	if (!isRecord(parsed))
		throw new JudgeError("the judge's answer is not a JSON object");
	return parsed;
}

function prompt(state: Json, question: string, format: string): string {
	return [
		"State:",
		JSON.stringify(state, null, 2),
		"",
		question,
		"",
		`Answer with: ${format}`,
	].join("\n");
}

/**
 * The core's default judge: asks a model for each judgment instead of a hosted judging service.
 * Answers are checked strictly, so a model that strays throws and the caller falls back.
 */
// pi-lens-ignore: large-class — one method per Judge question type, sharing one prompt and parser
export class ModelJudge implements Judge {
	readonly #complete: JudgeModel;

	constructor(complete: JudgeModel) {
		this.#complete = complete;
	}

	async #ask(state: Json, question: string, format: string): Promise<Json> {
		return answerObject(
			await this.#complete(SYSTEM, prompt(state, question, format)),
		);
	}

	async askYesNo(
		state: Json,
		questions: Record<string, YesNoQuestion>,
	): Promise<Record<string, number>> {
		const names = Object.keys(questions);
		const listed = names.map((name) => {
			const { instructions, criteria } = questions[name] as YesNoQuestion;
			const yes = criteria?.true ? ` Yes means: ${criteria.true}.` : "";
			const no = criteria?.false ? ` No means: ${criteria.false}.` : "";
			return `- ${name}: ${instructions}${yes}${no}`;
		});
		const answer = await this.#ask(
			state,
			`Answer each yes-or-no question:\n${listed.join("\n")}`,
			`{${names.map((name) => `"${name}": <probability that the answer is yes>`).join(", ")}}`,
		);
		// pi-lens-ignore: no-known-value-widening — filled per question name below
		const result: Record<string, number> = {};
		for (const name of names) {
			const value = answer[name];
			if (!isProbability(value))
				throw new JudgeError(`the judge gave no probability for ${name}`);
			result[name] = value;
		}
		return result;
	}

	async askChoice(
		state: Json,
		name: string,
		question: ChoiceQuestion,
	): Promise<ChoiceAnswer> {
		const options = Object.entries(question.criteria).map(
			([option, criterion]) => `- ${option}: ${criterion}`,
		);
		const answer = await this.#ask(
			state,
			`${name}: ${question.instructions}\nOptions:\n${options.join("\n")}`,
			'{"choice": "<one option name>", "confidence": <probability>}',
		);
		const { choice, confidence } = answer;
		if (typeof choice !== "string" || !(choice in question.criteria))
			throw new JudgeError(`the judge chose no listed option for ${name}`);
		if (!isProbability(confidence))
			throw new JudgeError(`the judge gave no confidence for ${name}`);
		return { choice, confidence };
	}

	async askScore(
		state: Json,
		name: string,
		question: ScoreQuestion,
	): Promise<number[]> {
		const levels = question.criteria.map(
			(criterion, index) => `${index}. ${criterion}`,
		);
		const answer = await this.#ask(
			state,
			`${name}: ${question.instructions}\nLevels, in order:\n${levels.join("\n")}`,
			`{"probabilities": [<one probability per level, ${levels.length} numbers, summing to 1>]}`,
		);
		const { probabilities } = answer;
		if (
			!Array.isArray(probabilities) ||
			probabilities.length !== question.criteria.length ||
			!probabilities.every(isProbability)
		)
			throw new JudgeError(
				`the judge gave no probability per level for ${name}`,
			);
		const total = probabilities.reduce((sum, p) => sum + p, 0);
		if (total <= 0)
			throw new JudgeError(
				`the judge's probabilities for ${name} are all zero`,
			);
		return probabilities.map((p) => p / total);
	}
}

/** The text of a completed answer; an errored one throws. */
function answerText(message: AssistantMessage): string {
	if (message.stopReason === "error" || message.stopReason === "aborted")
		throw new JudgeError(
			`the judge's model failed: ${message.errorMessage ?? message.stopReason}`,
		);
	return message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("");
}

/** A Pi model as a judge's completion, through the runtime that holds its credentials. */
export function piJudgeModel(
	runtime: {
		completeSimple(
			model: Model<Api>,
			context: Context,
		): Promise<AssistantMessage>;
	},
	model: Model<Api>,
): JudgeModel {
	return async (system, text) =>
		answerText(
			await runtime.completeSimple(model, {
				systemPrompt: system,
				messages: [{ role: "user", content: text, timestamp: Date.now() }],
			}),
		);
}
