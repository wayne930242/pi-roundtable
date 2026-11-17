import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { SQL } from "bun";
import type { InboundMessage, Logger } from "pi-roundtable";
import { describeDb, testDatabaseUrl } from "pi-roundtable/testing";
import type { NewRoomMessage } from "../app/room-log.ts";
import type { ManageContext } from "../connector-manage-api.ts";
import type { ConnectorManagement } from "../features.ts";
import { ConsoleHttpError } from "../http.ts";
import { ConnectorAddRequests, scrubbed } from "./requests.ts";
import { ConnectorAddRequestStore } from "./store.ts";

const TOKEN = "tok-3c9e1f7a42";
const URL_WITH_TOKEN = `https://notes.example/mcp/${TOKEN}`;
const HEADER_TOKEN = "hdr-secret-77aa";

test("a reason keeps no URL beyond its host, and no secret", () => {
	expect(
		scrubbed(`Cannot parse ${URL_WITH_TOKEN} (sent ${HEADER_TOKEN})`, [
			HEADER_TOKEN,
		]),
	).toBe("Cannot parse https://notes.example/… (sent …)");
});

// Runs against a real PostgreSQL, only when ROUNDTABLE_TEST_DATABASE_URL is set.
describeDb("connector add requests", () => {
	let sql: SQL;
	let logged: unknown[];
	let shown: NewRoomMessage[];
	let delivered: InboundMessage[];
	let added: Parameters<ConnectorManagement["add"]>[0][];
	let refuse: string | undefined;

	beforeAll(async () => {
		sql = new SQL(testDatabaseUrl);
		await ConnectorAddRequestStore.migration.up(sql);
	});
	afterAll(() => sql.close());
	beforeEach(async () => {
		await sql`DELETE FROM web_connector_add_requests`;
		logged = [];
		shown = [];
		delivered = [];
		added = [];
		refuse = undefined;
	});

	const logger = new Proxy(
		{},
		{
			get:
				() =>
				(...args: unknown[]) =>
					logged.push(args),
		},
	) as Logger;

	const manage: ConnectorManagement = {
		list: () => [],
		add: async (input) => {
			added.push(input);
			if (refuse) throw Object.assign(new Error(refuse), { refusal: true });
			return {
				connector: {
					name: input.name,
					url: input.url,
					description: input.description,
					server: { tools: ["a", "b", "c"] },
				},
				skipped: [],
			};
		},
		describe: async () => undefined,
		remove: async () => {},
	};

	const surface = {
		publish: async (row: NewRoomMessage) => {
			shown.push(row);
			return { id: shown.length } as never;
		},
		deliver: (message: InboundMessage) => {
			delivered.push(message);
		},
	};

	const requests = (options: { now?: () => number; manage?: boolean } = {}) =>
		new ConnectorAddRequests({
			store: new ConnectorAddRequestStore(sql),
			manage: options.manage === false ? undefined : manage,
			surface: () => surface,
			surfaceName: "app",
			link: (id) => `https://web.example/app/#/connectors?add=${id}`,
			...(options.now ? { now: options.now } : {}),
			logger,
		});

	const context = (body: unknown = {}): ManageContext => ({
		logger,
		actor: { principalId: "p1", speakerId: "oidc:x" },
		body: async () => body,
		changed: () => {},
	});

	const ask = {
		name: "notes",
		description: "The owner's notes",
		conversation: "app:agent:arthur",
		requestedBy: "p1",
	};

	const idOf = (link: string) => link.slice(link.indexOf("add=") + 4);

	async function status(call: Promise<Response>): Promise<[number, string]> {
		try {
			const response = await call;
			return [response.status, ""];
		} catch (error) {
			if (!(error instanceof ConsoleHttpError)) throw error;
			return [error.status, error.message];
		}
	}

	/** Everything the add showed or logged, which must hold no URL beyond its host and no token. */
	const everything = () =>
		JSON.stringify([shown, delivered, logged, added.length]);

	test("is made only for an app conversation on a console that manages connectors", async () => {
		expect(
			await requests().create({ ...ask, conversation: "discord:1" }),
		).toBeUndefined();
		expect(await requests({ manage: false }).create(ask)).toBeUndefined();
		const made = await requests().create(ask);
		expect(made?.link).toStartWith("https://web.example/app/#/connectors?add=");
	});

	test("keeps name, purpose and conversation, and has no place for a URL", async () => {
		await requests().create(ask);
		const columns: { column_name: string }[] = await sql`
			SELECT column_name FROM information_schema.columns
			WHERE table_name = 'web_connector_add_requests'`;
		expect(columns.some((c) => /url|token|header/.test(c.column_name))).toBe(
			false,
		);
	});

	test("fills the form, adds the connector, and follows up with the name, host and tool count only", async () => {
		const service = requests();
		const id = idOf((await service.create(ask))?.link ?? "");
		const view = await (await service.route("GET", id, context())).json();
		expect(view).toMatchObject({
			id,
			name: "notes",
			description: ask.description,
		});
		const response = await service.route(
			"POST",
			id,
			context({ url: URL_WITH_TOKEN, token: HEADER_TOKEN }),
		);
		expect(response.status).toBe(201);
		const answer = JSON.stringify(await response.json());
		expect(answer).not.toContain(TOKEN);
		expect(answer).not.toContain(HEADER_TOKEN);
		expect(added).toEqual([
			{
				name: "notes",
				url: URL_WITH_TOKEN,
				description: ask.description,
				token: HEADER_TOKEN,
			},
		]);
		expect(shown).toHaveLength(1);
		expect(shown[0]?.room).toBe("app:agent:arthur");
		expect(shown[0]?.text).toContain(
			"added connector notes (https://notes.example/…)",
		);
		expect(shown[0]?.text).toContain("3 tools are available");
		expect(delivered[0]).toMatchObject({
			channel: "app:agent:arthur",
			integration: { own: false },
		});
		expect(everything()).not.toContain(TOKEN);
		expect(everything()).not.toContain(HEADER_TOKEN);
	});

	test("a used, an expired and an unknown request get the same 404", async () => {
		const service = requests();
		const id = idOf((await service.create(ask))?.link ?? "");
		await service.route("POST", id, context({ url: URL_WITH_TOKEN }));
		const reused = await status(
			service.route("POST", id, context({ url: URL_WITH_TOKEN })),
		);
		const old = requests({ now: () => Date.now() - 2 * 3_600_000 });
		const expiredId = idOf((await old.create(ask))?.link ?? "");
		const expired = await status(
			service.route("POST", expiredId, context({ url: URL_WITH_TOKEN })),
		);
		const expiredView = await status(
			service.route("GET", expiredId, context()),
		);
		const unknown = await status(
			service.route("POST", "nope", context({ url: URL_WITH_TOKEN })),
		);
		expect(reused).toEqual([404, "There is no such add request."]);
		expect(expired).toEqual(reused);
		expect(expiredView).toEqual(reused);
		expect(unknown).toEqual(reused);
		expect(added).toHaveLength(1);
	});

	test("a failed add uses the request up and follows up with the reason, the URL cut to its host", async () => {
		const service = requests();
		const id = idOf((await service.create(ask))?.link ?? "");
		refuse = `Cannot parse the upstream URL: ${URL_WITH_TOKEN}`;
		const [code] = await status(
			service.route("POST", id, context({ url: URL_WITH_TOKEN })),
		);
		expect(code).toBe(400);
		expect(shown[0]?.text).toContain(
			"failed: Cannot parse the upstream URL: https://notes.example/…",
		);
		expect(everything()).not.toContain(TOKEN);
		const [again] = await status(
			service.route("POST", id, context({ url: URL_WITH_TOKEN })),
		);
		expect(again).toBe(404);
	});

	test("a body without a URL is refused before the request is used", async () => {
		const service = requests();
		const id = idOf((await service.create(ask))?.link ?? "");
		expect((await status(service.route("POST", id, context({}))))[0]).toBe(400);
		expect((await service.route("GET", id, context())).status).toBe(200);
	});
});
