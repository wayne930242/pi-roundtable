/** One choice a question offers. */
export interface AskOption {
	label: string;
	description?: string;
	/** A markdown mock-up or snippet shown beside the option, where the surface can; see `AskSupport.previews`. */
	preview?: string;
}

export interface OwnerQuestion {
	question: string;
	/** A short name for the question in a set (see `QUESTIONNAIRE_LIMITS.headerChars`); surfaces that take one question drop it. */
	header?: string;
	/** Up to 25; none means a free-text answer. */
	options: readonly AskOption[];
	/** More than one option may be chosen. */
	multi: boolean;
	/** They may write an answer of their own besides the options. */
	allowOther: boolean;
}

export interface OwnerAnswer {
	/** The chosen options' labels, in the order they were offered. */
	choices: string[];
	/** What they wrote themselves, if anything. */
	text?: string;
}

/** One to four related questions asked on a single card. */
export interface Questionnaire {
	questions: readonly OwnerQuestion[];
}

/** The answer to a `Questionnaire`: `answers[i]` is for `questions[i]`, undefined when left blank. */
export interface QuestionnaireAnswer {
	answers: readonly (OwnerAnswer | undefined)[];
	/** A note on the whole set, where the surface takes one. */
	note?: string;
}

/**
 * What a surface can show of a questionnaire. A `Prompts` without `asks` is the 0.19 contract:
 * one question, no previews, no note.
 */
export interface AskSupport {
	/** The most questions one card holds (1 to 4). */
	questions: number;
	/** Options may carry a `preview`. */
	previews: boolean;
	/** The card takes a note on the whole set. */
	note: boolean;
}

export const SINGLE_QUESTION: AskSupport = {
	questions: 1,
	previews: false,
	note: false,
};

/** Every limit of a questionnaire, one table for the tool schema, the validation and the tests. */
export const QUESTIONNAIRE_LIMITS = {
	questions: 4,
	/** A question's text, alone in a call. */
	questionChars: 1500,
	/** Question texts and headers together when a call holds several questions. */
	setChars: 3000,
	headerChars: 30,
	options: 25,
	labelChars: 100,
	descriptionChars: 100,
	/** One option's preview. */
	previewChars: 1200,
	/** All previews of a call together. */
	previewTotalChars: 10000,
	/** Their own answer to one question, and the note. */
	answerChars: 1000,
} as const;

const L = QUESTIONNAIRE_LIMITS;

const pointsOf = (text: string) => Array.from(text).length;
const units = (text: string) => Math.max(pointsOf(text), text.length);

function duplicate(values: readonly string[]): string | undefined {
	return values.find((v, i) => values.indexOf(v) !== i);
}

/** The model-facing reason a questionnaire is refused, or undefined when it is sound. */
export function validateQuestionnaire(q: Questionnaire): string | undefined {
	const n = q.questions.length;
	if (n < 1 || n > L.questions)
		return `Ask between 1 and ${L.questions} questions in one call (got ${n}).`;
	const many = n > 1;
	let setChars = 0;
	let previews = 0;
	for (const [i, question] of q.questions.entries()) {
		const at = many ? `Question ${i + 1}: ` : "";
		const text = question.question.trim();
		if (text === "") return `${at}the question is empty.`;
		if (!many && pointsOf(question.question) > L.questionChars)
			return `${at}the question is over ${L.questionChars} characters.`;
		if (
			question.header !== undefined &&
			pointsOf(question.header) > L.headerChars
		)
			return `${at}the header is over ${L.headerChars} characters.`;
		// Discord counts UTF-16 units, so an emoji or rare character weighs two here.
		setChars += units(question.question) + units(question.header ?? "");
		if (question.options.length > L.options)
			return `${at}offer at most ${L.options} options.`;
		for (const option of question.options) {
			if (option.label.trim() === "") return `${at}an option has no label.`;
			if (pointsOf(option.label) > L.labelChars)
				return `${at}an option label is over ${L.labelChars} characters.`;
			if (pointsOf(option.description ?? "") > L.descriptionChars)
				return `${at}an option description is over ${L.descriptionChars} characters.`;
			const preview = pointsOf(option.preview ?? "");
			if (preview > L.previewChars)
				return `${at}the preview of "${option.label}" is over ${L.previewChars} characters.`;
			previews += preview;
		}
		const same = duplicate(question.options.map((o) => o.label));
		if (same !== undefined)
			return `${at}the option "${same}" is offered twice.`;
	}
	if (many && setChars > L.setChars)
		return `The questions and headers together are over ${L.setChars} characters (an emoji or rare character counts as two); shorten them or ask fewer.`;
	if (previews > L.previewTotalChars)
		return `The previews together are over ${L.previewTotalChars} characters.`;
	const twice = duplicate(q.questions.map((x) => x.question.trim()));
	if (twice !== undefined) return `The question "${twice}" is asked twice.`;
	return undefined;
}

/** Whether an answer is one the question allows: offered labels, one unless multi, own text only where allowed. */
export function checkAnswer(q: OwnerQuestion, a: OwnerAnswer): boolean {
	const labels = q.options.map((option) => option.label);
	const text = a.text?.trim();
	if (!a.choices.every((choice) => labels.includes(choice))) return false;
	if (new Set(a.choices).size !== a.choices.length) return false;
	if (!q.multi && a.choices.length > 1) return false;
	if (labels.length === 0) return a.choices.length === 0 && Boolean(text);
	if (text && !q.allowOther) return false;
	return a.choices.length > 0 || Boolean(text);
}

/** Whether an answer fits the set: aligned with the questions, each given answer allowed, something given. */
export function checkQuestionnaireAnswer(
	q: Questionnaire,
	a: QuestionnaireAnswer,
): boolean {
	if (a.answers.length !== q.questions.length) return false;
	const note = a.note?.trim();
	if (a.note !== undefined && pointsOf(a.note) > L.answerChars) return false;
	let given = Boolean(note);
	for (const [i, answer] of a.answers.entries()) {
		const question = q.questions[i];
		if (answer === undefined || !question) continue;
		if (!checkAnswer(question, answer)) return false;
		if (answer.text !== undefined && pointsOf(answer.text) > L.answerChars)
			return false;
		given = true;
	}
	return given;
}

/** `text` cut to `max` characters with a closing `…`. */
function cut(text: string, max: number): string {
	const chars = Array.from(text);
	return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** A fenced block for `body`, its fence longer than any backtick run inside. */
function fenced(body: string): string {
	const longest = Math.max(
		0,
		...(body.match(/`+/g) ?? []).map((run) => run.length),
	);
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}\n${body}\n${fence}`;
}

function foldPreviews(question: OwnerQuestion): OwnerQuestion {
	if (!question.options.some((o) => o.preview)) return question;
	const shown = question.options
		.filter((o) => o.preview)
		.map((o) => `**${o.label}**\n${fenced(o.preview ?? "")}`);
	return {
		...question,
		question: cut(
			`${question.question}\n\n${shown.join("\n\n")}`,
			L.questionChars,
		),
		options: question.options.map(({ preview: _preview, ...rest }) => rest),
	};
}

/**
 * The questionnaire a surface with `support` can show; the same questions, in the same order.
 * A surface without previews gets each preview appended to its question as a fenced block, cut
 * to the question limit. A surface that takes one question drops the headers. Questions beyond
 * `support.questions` are not removed here: the runtime asks a surface that takes fewer one
 * question at a time.
 */
export function shapeFor(q: Questionnaire, support: AskSupport): Questionnaire {
	return {
		questions: q.questions.map((question) => {
			const shaped = support.previews ? question : foldPreviews(question);
			if (support.questions > 1) return shaped;
			const { header: _header, ...rest } = shaped;
			return rest;
		}),
	};
}
