import { afterEach, describe, expect, test } from "bun:test";
import { JudgeError } from "../core/errors.ts";
import { jevJudge } from "./jev-judge.ts";

type Sent = { url: string; init: RequestInit };

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/** A judge over a fake network that answers every request with `answer`, recording the requests. */
function over(answer: () => Response, extra: { timeoutMs?: number } = {}) {
	const sent: Sent[] = [];
	const judge = jevJudge({
		apiKey: "key-1",
		fetch: (async (url: string, init: RequestInit) => {
			sent.push({ url, init });
			return answer();
		}) as unknown as typeof fetch,
		...extra,
	});
	return { judge, sent };
}

const bodyOf = (request: Sent | undefined) =>
	JSON.parse(String(request?.init.body)) as {
		model: string;
		state: unknown;
		questions: Record<string, Record<string, unknown>>;
	};

const failureOf = (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: unknown) => error,
	);

describe("the yes-or-no question", () => {
	test("goes out as the service's own question type and reads each probability", async () => {
		const { judge, sent } = over(() =>
			json({ answers: { a: { noul: 0.9 }, b: { noul: 0.1 } } }),
		);
		const questions = {
			a: { type: "yesno" as const, instructions: "Is a so?" },
			b: {
				type: "yesno" as const,
				instructions: "Is b so?",
				criteria: { true: "b holds", false: "b fails" },
			},
		};
		const result = await judge.askYesNo({ x: 1 }, questions);
		expect(result).toEqual({ a: 0.9, b: 0.1 });
		const body = bodyOf(sent[0]);
		expect(body.questions.a).toEqual({
			type: "noul",
			instructions: "Is a so?",
		});
		expect(body.questions.b?.criteria).toEqual({
			true: "b holds",
			false: "b fails",
		});
		expect(body.state).toEqual({ x: 1 });
		// Counter-proof: the caller's questions keep the core's own type.
		expect(questions.a.type).toBe("yesno");
		expect(JSON.stringify(body)).not.toContain('"yesno"');
	});

	test("rejects an answer that is missing, not a number, or outside 0 to 1", async () => {
		for (const answer of [
			{ answers: {} },
			{ answers: { a: { noul: "0.5" } } },
			{ answers: { a: { noul: 1.5 } } },
			{ answers: { a: { noul: -0.1 } } },
			{ answers: { a: { yesno: 0.5 } } },
			{ answers: { a: null } },
		]) {
			const { judge } = over(() => json(answer));
			const failure = await failureOf(
				judge.askYesNo({}, { a: { type: "yesno", instructions: "?" } }),
			);
			expect(failure).toBeInstanceOf(JudgeError);
			expect((failure as Error).message).toContain("answer for a is malformed");
		}
	});

	test("asks nothing when there is nothing to ask", async () => {
		const { judge, sent } = over(() => json({ answers: {} }));
		expect(await judge.askYesNo({}, {})).toEqual({});
		expect(sent).toHaveLength(0);
	});
});

describe("the choice question", () => {
	const question = {
		type: "choice" as const,
		instructions: "Which?",
		criteria: { red: "it is red", blue: "it is blue" },
	};

	test("returns the listed option it chose, with its confidence", async () => {
		const { judge, sent } = over(() =>
			json({
				answers: {
					pick: { choice: "blue", confidence: 0.8, probabilities: {} },
				},
			}),
		);
		expect(await judge.askChoice({}, "pick", question)).toEqual({
			choice: "blue",
			confidence: 0.8,
		});
		expect(bodyOf(sent[0]).questions.pick).toEqual(question);
	});

	test("rejects a choice that is not an option, including one Object inherits", async () => {
		for (const choice of ["green", "toString", "__proto__"]) {
			const { judge } = over(() =>
				json({ answers: { pick: { choice, confidence: 0.9 } } }),
			);
			const failure = await failureOf(judge.askChoice({}, "pick", question));
			expect(failure).toBeInstanceOf(JudgeError);
			expect((failure as Error).message).toBe(
				`Jev chose ${choice}, which is not an option of pick`,
			);
		}
	});

	test("rejects an answer without a choice or with a confidence that is not a probability", async () => {
		for (const answer of [
			{},
			{ choice: "red" },
			{ choice: "red", confidence: 2 },
			{ choice: 3, confidence: 0.5 },
		]) {
			const { judge } = over(() => json({ answers: { pick: answer } }));
			const failure = await failureOf(judge.askChoice({}, "pick", question));
			expect(failure).toBeInstanceOf(JudgeError);
			expect((failure as Error).message).toContain("malformed");
		}
	});
});

describe("the score question", () => {
	const question = {
		type: "score" as const,
		instructions: "How hard?",
		criteria: ["easy", "medium", "hard"],
	};

	test("reads the probabilities by criterion index", async () => {
		const { judge, sent } = over(() =>
			json({
				answers: {
					level: {
						score: 2,
						confidence: 0.7,
						// Out of order on purpose: the index, not the position, decides.
						probabilities: { "2": 0.6, "0": 0.1, "1": 0.3 },
					},
				},
			}),
		);
		expect(await judge.askScore({}, "level", question)).toEqual([
			0.1, 0.3, 0.6,
		]);
		expect(bodyOf(sent[0]).questions.level).toEqual(question);
	});

	test("rejects probabilities with an index missing or a value outside 0 to 1", async () => {
		for (const probabilities of [
			{ "0": 0.1, "1": 0.2 },
			{ "0": 0.1, "1": "0.2", "2": 0.3 },
			{ "0": 0.1, "1": 0.2, "2": 4 },
		]) {
			const { judge } = over(() =>
				json({ answers: { level: { score: 0, probabilities } } }),
			);
			const failure = await failureOf(judge.askScore({}, "level", question));
			expect(failure).toBeInstanceOf(JudgeError);
			expect((failure as Error).message).toContain("answer for level");
		}
		const { judge } = over(() => json({ answers: { level: { score: 0 } } }));
		expect(
			await failureOf(judge.askScore({}, "level", question)),
		).toBeInstanceOf(JudgeError);
	});
});

describe("the request", () => {
	test("sends the key, the default model and endpoint, or the ones it is given", async () => {
		const plain = over(() => json({ answers: { a: { noul: 0.5 } } }));
		await plain.judge.askYesNo({}, { a: { type: "yesno", instructions: "?" } });
		const headers = plain.sent[0]?.init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer key-1");
		expect(plain.sent[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(bodyOf(plain.sent[0]).model).toBe("jev-latest");

		const sent: Sent[] = [];
		const custom = jevJudge({
			apiKey: "key-2",
			model: "jev-other",
			baseUrl: "https://example.test/ask",
			fetch: (async (url: string, init: RequestInit) => {
				sent.push({ url, init });
				return json({ answers: { a: { noul: 0.5 } } });
			}) as unknown as typeof fetch,
		});
		await custom.askYesNo({}, { a: { type: "yesno", instructions: "?" } });
		expect(sent[0]?.url).toBe("https://example.test/ask");
		expect(bodyOf(sent[0]).model).toBe("jev-other");
	});

	test("every other failure is a JudgeError too", async () => {
		const ask = (answer: () => Response) =>
			failureOf(
				over(answer).judge.askYesNo(
					{},
					{ a: { type: "yesno", instructions: "?" } },
				),
			);
		const cases: [Response, string][] = [
			[new Response("busy", { status: 503 }), "Jev request failed (503): busy"],
			[new Response("not json"), "Jev returned malformed JSON"],
			[json({ nothing: true }), "Jev response is missing answers"],
		];
		for (const [response, message] of cases) {
			const failure = await ask(() => response);
			expect(failure).toBeInstanceOf(JudgeError);
			expect((failure as Error).message).toBe(message);
		}
		const down = jevJudge({
			apiKey: "key-1",
			fetch: (async () => {
				throw new Error("connection refused");
			}) as unknown as typeof fetch,
		});
		const failure = await failureOf(
			down.askYesNo({}, { a: { type: "yesno", instructions: "?" } }),
		);
		expect(failure).toBeInstanceOf(JudgeError);
		expect((failure as Error).message).toBe(
			"Jev request failed: connection refused",
		);
		expect(((failure as Error).cause as Error).message).toBe(
			"connection refused",
		);
	});
});

describe("the API key", () => {
	const KEY = "TYPESAFE_API_KEY";
	const saved = process.env[KEY];
	afterEach(() => {
		if (saved === undefined) delete process.env[KEY];
		else process.env[KEY] = saved;
	});

	test("an empty key is refused even when the environment holds one", () => {
		process.env[KEY] = "env-key-must-not-be-used";
		for (const apiKey of ["", "   "]) {
			const failure = (() => {
				try {
					jevJudge({ apiKey });
				} catch (error) {
					return error;
				}
			})();
			expect(failure).toBeInstanceOf(JudgeError);
			expect((failure as Error).message).toContain("apiKey");
		}
	});

	test("counter-proof: a given key is the one sent, not the environment's", async () => {
		process.env[KEY] = "env-key-must-not-be-used";
		const { judge, sent } = over(() => json({ answers: { a: { noul: 0.5 } } }));
		await judge.askYesNo({}, { a: { type: "yesno", instructions: "?" } });
		const headers = sent[0]?.init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer key-1");
	});
});

describe("the time limit, against a real server", () => {
	const servers: ReturnType<typeof Bun.serve>[] = [];
	afterEach(() => {
		for (const server of servers.splice(0)) server.stop(true);
	});

	/** A server that sends its headers and half of a JSON body, then stalls or finishes it. */
	function serve(finish: boolean) {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				const encoder = new TextEncoder();
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(encoder.encode('{"answers":{"a":'));
							if (!finish) return;
							controller.enqueue(encoder.encode('{"noul":0.25}}}'));
							controller.close();
						},
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});
		servers.push(server);
		return `http://127.0.0.1:${server.port}/`;
	}

	const yesNo = { a: { type: "yesno" as const, instructions: "?" } };

	test("stops a question whose answer stalls while it is read", async () => {
		const judge = jevJudge({
			apiKey: "key-1",
			baseUrl: serve(false),
			timeoutMs: 100,
		});
		const started = Date.now();
		const failure = await failureOf(judge.askYesNo({}, yesNo));
		expect(failure).toBeInstanceOf(JudgeError);
		expect((failure as Error).message).toBe("Jev did not answer within 100 ms");
		expect(((failure as Error).cause as Error).name).toBe("TimeoutError");
		expect(Date.now() - started).toBeLessThan(2000);
	});

	test("counter-proof: the same server finishing its answer resolves inside the limit", async () => {
		const judge = jevJudge({
			apiKey: "key-1",
			baseUrl: serve(true),
			timeoutMs: 2000,
		});
		expect(await judge.askYesNo({}, yesNo)).toEqual({ a: 0.25 });
	});

	test("each question has its own limit", async () => {
		const judge = jevJudge({
			apiKey: "key-1",
			baseUrl: serve(true),
			timeoutMs: 300,
		});
		expect(await judge.askYesNo({}, yesNo)).toEqual({ a: 0.25 });
		await new Promise((done) => setTimeout(done, 350));
		expect(await judge.askYesNo({}, yesNo)).toEqual({ a: 0.25 });
	});
});
