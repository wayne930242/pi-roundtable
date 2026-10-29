import type { EventSink, Logger } from "pi-roundtable";
import { PluginError } from "pi-roundtable";
import type { FileDir } from "../app/files.ts";
import { viewerOfSocket } from "../app/socket.ts";
import type { AppSocket, Sockets } from "../app/sockets.ts";
import type {
	ActionResult,
	FormValues,
	HostPage,
	HostPages,
	PageSection,
	Viewer,
	WebAppRegistry,
} from "../web-app.ts";
import { checkActions, checkCard, safeLink } from "./forms.ts";
import { markdownImageType } from "./rooms-service.ts";
import type { HostPageView, PageSectionView } from "./views.ts";

/** The most sections a page has, rows a list has, and characters a text section has. */
const MAX_SECTIONS = 50;
const MAX_ROWS = 500;
const MAX_TEXT = 100_000;
const COALESCE_MS = 100;

export interface HostPagesOptions {
	registry: Pick<WebAppRegistry, "page" | "hostPages">;
	sockets: Pick<Sockets, "each" | "deliver">;
	files: FileDir;
	maxFileBytes: number;
	events: Pick<EventSink, "action"> | undefined;
	now(): number;
	logger: Logger;
}

/** The file binding of an image a page keeps: the page's id after this prefix. */
export const PAGE_BINDING = "page:";

/** What a press on a page reached. */
export type PageOutcome =
	| { result: ActionResult }
	| { refused: "unknown" | "forbidden" };

/**
 * The host's pages (`WebApp.pages`): each viewed, acted on and refreshed only for those the page's
 * own `visible` says it is for, asked again on every call. What a page returns is checked and
 * cut to size here, because it comes from a plugin.
 */
export class HostPagesService implements HostPages {
	readonly #options: HostPagesOptions;
	readonly #pending = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(options: HostPagesOptions) {
		this.#options = options;
	}

	/** The page when the viewer may see it now; a page that cannot say is not visible. */
	async visible(viewer: Viewer, id: string): Promise<HostPage | undefined> {
		const page = this.#options.registry.page(id);
		if (!page) return undefined;
		try {
			return (await page.visible(viewer)) ? page : undefined;
		} catch (error) {
			this.#options.logger.warn(
				{ page: id, err: error },
				"a page's visibility was not read",
			);
			return undefined;
		}
	}

	async view(
		viewer: Viewer,
		id: string,
		query: Readonly<Record<string, string>>,
	): Promise<HostPageView | undefined> {
		const page = await this.visible(viewer, id);
		if (!page) return undefined;
		const view = await page.view(viewer, query);
		if (view.sections.length > MAX_SECTIONS)
			throw new PluginError(
				`web app: a page has at most ${MAX_SECTIONS} sections`,
			);
		return {
			id,
			title: String(view.title).slice(0, 200),
			sections: view.sections.map((section) => sectionView(section, id)),
		};
	}

	async act(
		viewer: Viewer,
		id: string,
		press: { action: string; input?: FormValues },
	): Promise<PageOutcome> {
		const page = await this.visible(viewer, id);
		if (!page?.act) return { refused: "unknown" };
		let result: ActionResult;
		try {
			result = await page.act(viewer, press.action, press.input ?? {});
		} catch (error) {
			this.#options.logger.warn(
				{ page: id, err: error },
				"a page action failed",
			);
			result = { ok: false, error: "The action could not be done." };
		}
		this.#options.events?.action?.({
			kind: "act",
			actor: viewer.speakerId,
			principalId: viewer.principalId,
			channel: `page:${id}`,
			ok: result.ok,
			at: new Date(this.#options.now()),
		});
		return { result };
	}

	changed(id?: string): void {
		const ids =
			id === undefined
				? this.#options.registry.hostPages().map((page) => page.id)
				: [id];
		for (const page of ids) {
			if (this.#pending.has(page)) continue;
			// Calls that come together tell the viewers once.
			this.#pending.set(
				page,
				setTimeout(() => {
					this.#pending.delete(page);
					this.#tell(page);
				}, COALESCE_MS),
			);
		}
	}

	#tell(id: string): void {
		const { sockets } = this.#options;
		sockets.each(
			(connection) => connection.started === true,
			(connection: AppSocket) => {
				const viewer = viewerOfSocket(connection);
				this.visible(viewer, id).then(
					(page) => {
						if (page)
							sockets.deliver(
								{ type: "page_changed", page: id },
								{ connection },
							);
					},
					() => undefined,
				);
			},
		);
	}

	async saveAsset(
		page: string,
		file: { name: string; type: string; bytes: Uint8Array | ReadableStream },
	): Promise<string> {
		if (!this.#options.registry.page(page))
			throw new PluginError(`web app: there is no page ${page}`);
		const chunks: Uint8Array[] = [];
		if (file.bytes instanceof Uint8Array) chunks.push(file.bytes);
		else {
			const reader = file.bytes.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value as Uint8Array);
			}
		}
		const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
		if (size === 0 || size > this.#options.maxFileBytes)
			throw new PluginError(
				`web app: a page image is 1 to ${this.#options.maxFileBytes} bytes`,
			);
		const bytes = new Uint8Array(size);
		let at = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, at);
			at += chunk.byteLength;
		}
		const type = markdownImageType(bytes);
		if (!type)
			throw new PluginError("web app: a page image is a PNG, JPEG or WebP");
		return this.#options.files.put(file.name, type, bytes, undefined, {
			room: `${PAGE_BINDING}${page}`,
		}).id;
	}

	stop(): void {
		for (const timer of this.#pending.values()) clearTimeout(timer);
		this.#pending.clear();
	}
}

function cut(text: string): string {
	return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

function sectionView(section: PageSection, page: string): PageSectionView {
	switch (section.kind) {
		case "markdown":
			return { kind: "markdown", text: cut(String(section.text)) };
		case "list": {
			if (section.rows.length > MAX_ROWS)
				throw new PluginError(`web app: a list has at most ${MAX_ROWS} rows`);
			return {
				kind: "list",
				...(section.title === undefined
					? {}
					: { title: String(section.title).slice(0, 200) }),
				rows: section.rows.map((row) => {
					if (row.open !== undefined && !safeLink(row.open))
						throw new PluginError(
							`web app: a row's open ${JSON.stringify(row.open)} must be https or a path of this origin`,
						);
					return {
						title: String(row.title).slice(0, 300),
						...(row.subtitle === undefined
							? {}
							: { subtitle: String(row.subtitle).slice(0, 500) }),
						...(row.open === undefined ? {} : { open: row.open }),
						...(row.attention ? { attention: true } : {}),
						...(row.actions?.length
							? {
									actions: structuredClone([
										...checkActions(row.actions, `page ${page}`),
									]),
								}
							: {}),
					};
				}),
			};
		}
		case "form":
			checkActions(
				[{ id: "form", label: "form", form: section.form }],
				`page ${page}`,
			);
			return {
				kind: "form",
				form: structuredClone(section.form),
				action: String(section.action),
			};
		case "card": {
			checkCard(section.card);
			const { title, body, tone, state, links, buttons } = section.card;
			return {
				kind: "card",
				card: {
					title,
					body,
					...(tone ? { tone } : {}),
					...(state ? { state } : {}),
					...(links?.length
						? { links: links.map((link) => ({ ...link })) }
						: {}),
					...(buttons?.length && (state === undefined || state === "open")
						? { buttons: structuredClone([...buttons]) }
						: {}),
				},
			};
		}
	}
}
