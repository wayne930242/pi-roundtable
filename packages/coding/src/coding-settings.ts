import type { SQL } from "bun";
import {
	type Locale,
	type Logger,
	type Migration,
	type PluginContext,
	type ServiceKey,
	serviceKey,
	type Tier,
} from "pi-roundtable";
import type { CodingDesk } from "./coding-desk.ts";
import { ZH_TW } from "./i18n/zh-tw.ts";
import { checkMaxWorkers, MAX_WORKERS_LIMIT } from "./limits.ts";

/** The owner's coding settings, one row per key; this migration is never edited once released. */
export const CODING_SETTINGS_MIGRATION: Migration = {
	name: "settings",
	up: async (sql) => {
		await sql`CREATE TABLE IF NOT EXISTS coding_settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`;
	},
};

/** Where the owner's worker limit is kept: the host database, or memory for one run. */
export interface CodingSettingsStore {
	maxWorkers(): Promise<number | undefined>;
	setMaxWorkers(max: number): Promise<void>;
}
export function databaseSettings(sql: SQL): CodingSettingsStore {
	return {
		async maxWorkers() {
			const rows: { value: string }[] =
				await sql`SELECT value FROM coding_settings WHERE key = 'max_workers'`;
			return rows[0] ? Number(rows[0].value) : undefined;
		},
		async setMaxWorkers(max) {
			await sql`INSERT INTO coding_settings (key, value) VALUES ('max_workers', ${String(max)})
				ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
		},
	};
}
export function memorySettings(): CodingSettingsStore {
	let stored: number | undefined;
	return {
		maxWorkers: async () => stored,
		setMaxWorkers: async (max) => {
			stored = max;
		},
	};
}

/** Applies a stored limit to the desk; one out of range is logged and the option's stays. */
export async function applyStoredLimit(
	store: CodingSettingsStore,
	desk: CodingDesk,
	logger: Logger,
): Promise<void> {
	const stored = await store.maxWorkers();
	if (stored === undefined) return;
	try {
		desk.setMaxWorkers(stored);
	} catch (error) {
		logger.warn(
			{ err: error },
			"the stored coding worker limit is not 1 to 64; the configured one applies",
		);
	}
}

/** The part of the web app's `WEB_APP` service the settings page uses, matched by the service's id. */
export interface SettingsWebApp {
	registerPage(page: SettingsPage): void;
	readonly pages: { changed(id?: string): void };
}
interface SettingsViewer {
	tier: Tier;
}
type SettingsResult =
	| { ok: true; notice?: string }
	| { ok: false; error: string; field?: string };
export interface SettingsPage {
	id: string;
	label: string;
	place: "settings";
	visible(viewer: SettingsViewer): boolean;
	view(viewer: SettingsViewer): Promise<{
		title: string;
		sections: readonly (
			| { kind: "markdown"; text: string }
			| {
					kind: "form";
					action: string;
					form: {
						title: string;
						submit: string;
						fields: {
							name: string;
							label: string;
							type: "text";
							required: boolean;
							max: number;
							initial: string;
							hint: string;
						}[];
					};
			  }
		)[];
	}>;
	act(
		viewer: SettingsViewer,
		action: string,
		input: Readonly<Record<string, string | readonly string[]>>,
	): Promise<SettingsResult>;
}
export const WEB_APP: ServiceKey<SettingsWebApp> =
	serviceKey<SettingsWebApp>("roundtable.web.app");
export const SETTINGS_PAGE_ID = "coding-workers";

/** The wording of a locale: zh-TW's catalog, then the host's own entries, both keyed by the English text. */
export function settingsWording(
	locale: Locale,
	messages: Readonly<Record<string, string>> = {},
): (text: string, values?: Record<string, number>) => string {
	const catalog = { ...(locale === "zh-TW" ? ZH_TW : {}), ...messages };
	return (text, values = {}) =>
		(catalog[text] ?? text).replace(/\{(\w+)\}/g, (whole, name: string) =>
			name in values ? String(values[name]) : whole,
		);
}

/** The owner's settings page: how many coding workers run at once, applied and stored on save. */
export function settingsPage(
	desk: CodingDesk,
	store: CodingSettingsStore,
	t: ReturnType<typeof settingsWording>,
	changed: () => void,
): SettingsPage {
	const owner = (viewer: SettingsViewer) => viewer.tier === "owner";
	return {
		id: SETTINGS_PAGE_ID,
		label: t("Coding workers"),
		place: "settings",
		visible: owner,
		view: async () => {
			const { max, running, queued } = desk.workers();
			return {
				title: t("Coding workers"),
				sections: [
					{
						kind: "markdown",
						text: t(
							"At most {max} at once. Running now: {running}. Waiting in the queue: {queued}.",
							{ max, running, queued },
						),
					},
					{
						kind: "form",
						action: "save",
						form: {
							title: t("Worker limit"),
							submit: t("Save"),
							fields: [
								{
									name: "maxWorkers",
									label: t("Coding workers at once"),
									type: "text",
									required: true,
									max: 2,
									initial: String(max),
									hint: t(
										"Shared by every agent and repository, 1 to {most}. Extra tasks wait in a queue. Lowering it lets running workers finish.",
										{ most: MAX_WORKERS_LIMIT },
									),
								},
							],
						},
					},
				],
			};
		},
		act: async (viewer, action, input) => {
			if (!owner(viewer))
				return { ok: false, error: t("Only an owner changes this.") };
			if (action !== "save")
				return { ok: false, error: t("This page has no such action.") };
			const text = input.maxWorkers;
			const max =
				typeof text === "string" && /^\d{1,2}$/.test(text.trim())
					? Number(text.trim())
					: Number.NaN;
			try {
				checkMaxWorkers(max);
			} catch {
				return {
					ok: false,
					field: "maxWorkers",
					error: t("Give a whole number from 1 to {most}.", {
						most: MAX_WORKERS_LIMIT,
					}),
				};
			}
			await store.setMaxWorkers(max);
			desk.setMaxWorkers(max);
			changed();
			return {
				ok: true,
				notice: t("Up to {max} coding workers now run at once.", { max }),
			};
		},
	};
}

/** Registers the settings page when the web app is there; the web app must be registered first. */
export function registerSettingsPage(
	context: Pick<PluginContext, "services" | "logger" | "env">,
	desk: CodingDesk,
	store: CodingSettingsStore,
	messages?: Readonly<Record<string, string>>,
): void {
	let web: SettingsWebApp | undefined;
	try {
		web = context.services.find(WEB_APP);
	} catch (error) {
		context.logger.warn(
			{ err: error },
			"register the coding plugin after web-console to get its Settings page",
		);
	}
	if (!web) return;
	const app = web;
	app.registerPage(
		settingsPage(
			desk,
			store,
			settingsWording(context.env.locale, messages),
			() => app.pages.changed(SETTINGS_PAGE_ID),
		),
	);
}
