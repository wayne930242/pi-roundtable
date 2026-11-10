import { useCallback, useEffect, useState } from "react";
import type { ArchivedEntry } from "../../src/api-types.ts";
import { type MenuItem, openMenu } from "../lib/action-menu.ts";
import { messageOf } from "../lib/api.ts";
import { useCharacters } from "../lib/characters.ts";
import { useConfig } from "../lib/config.ts";
import { entryId } from "../lib/hidden-batch.ts";
import { useLive } from "../lib/live.ts";
import { type PressRequest, useLongPress } from "../lib/long-press.ts";
import { translate as t } from "../lib/messages.ts";
import { lastActive } from "../lib/selection.ts";
import { refreshRooms, teamApi } from "../lib/team-api.ts";
import { toast } from "../lib/toast.ts";
import { CharacterStack, PageCharacter } from "./character.tsx";
import { Confirm } from "./confirm.tsx";
import { Icon } from "./icons.tsx";
import { SelectBox } from "./select-bar.tsx";
import { Empty, Failure, Loading } from "./states.tsx";

/** The entries with each temp knight right after its knight, whether or not that knight is archived too; the rest keep their order. */
export function groupedEntries(
	entries: readonly ArchivedEntry[],
): ArchivedEntry[] {
	const helpers = entries.filter((entry) => entry.parent !== undefined);
	const ordinary = entries.filter((entry) => entry.parent === undefined);
	const named = new Set(ordinary.map((entry) => entry.name));
	return [
		...ordinary.flatMap((entry) => [
			entry,
			...helpers.filter((one) => one.parent === entry.name),
		]),
		...helpers.filter((one) => !named.has(one.parent ?? "")),
	];
}

/** The archive as read from the server, and the way to read it again. */
export interface ArchiveSource {
	entries: ArchivedEntry[] | undefined;
	error: string | undefined;
	load(): Promise<void>;
}

export function useArchive(): ArchiveSource {
	const [entries, setEntries] = useState<ArchivedEntry[]>();
	const [error, setError] = useState<string>();
	const load = useCallback(async () => {
		try {
			setEntries((await teamApi.archive()).entries);
			setError(undefined);
		} catch (failure) {
			setError(messageOf(failure));
		}
	}, []);
	useEffect(() => {
		load();
	}, [load]);
	return { entries, error, load };
}

/** How a page that is selecting draws the archive: which rows are chosen and how a row is chosen. */
export interface ArchiveSelect {
	chosen: ReadonlySet<string>;
	toggle(entry: ArchivedEntry): void;
	/** A hold (or right click) on a row: selection starts with it. */
	hold(entry: ArchivedEntry): void;
	selecting: boolean;
}

/** An entry's picture: a knight's own character, or a group's members side by side. */
function Picture(props: { entry: ArchivedEntry }) {
	const characters = useCharacters();
	const { entry } = props;
	return entry.kind === "group" ? (
		<CharacterStack
			size={36}
			members={(entry.members ?? []).map((name) => ({
				name,
				spec: characters[name],
			}))}
		/>
	) : (
		<PageCharacter
			spec={entry.character}
			name={entry.name}
			size={44}
			live={false}
		/>
	);
}

function Facts(props: { entry: ArchivedEntry; now: number; timeZone: string }) {
	const { entry } = props;
	return (
		<span className="menu-text">
			<strong>{entry.displayName}</strong>
			<span className="meta">
				{entry.parent
					? t("Temp knight of {name}", { name: entry.parent })
					: entry.kind === "agent"
						? t("Knight")
						: t("Group")}{" "}
				· {lastActive(entry.lastActive, props.now, props.timeZone)}
			</span>
		</span>
	);
}

/** One archived row: Restore and Delete while browsing, a checkbox while selecting. */
function ArchiveRow(props: {
	entry: ArchivedEntry;
	busy: boolean;
	inMenu: boolean;
	select: ArchiveSelect | undefined;
	chosen: boolean;
	/** The knight of this temp knight is chosen, which takes the temp knight along. */
	withParent: boolean;
	now: number;
	timeZone: string;
	onRestore(entry: ArchivedEntry): void;
	onDelete(entry: ArchivedEntry): void;
}) {
	const { entry, select } = props;
	const press = useLongPress((request: PressRequest) => {
		if (request.via === "hold") select?.hold(entry);
	});
	const helper = entry.parent !== undefined;
	if (select?.selecting)
		return (
			<li
				className="menu-item"
				data-helper={entry.parent ?? undefined}
				data-chosen={props.chosen || props.withParent ? "" : undefined}
			>
				<label
					className="select-row"
					data-chosen={props.chosen || props.withParent ? "" : undefined}
					data-in-group={helper ? "" : undefined}
				>
					<SelectBox
						label={entry.displayName}
						checked={props.chosen || props.withParent}
						mixed={props.withParent && !props.chosen}
						disabled={props.withParent}
						onChange={() => select.toggle(entry)}
					/>
					<Picture entry={entry} />
					<Facts entry={entry} now={props.now} timeZone={props.timeZone} />
				</label>
			</li>
		);
	return (
		<li
			className="menu-item"
			data-helper={entry.parent ?? undefined}
			style={helper ? { paddingLeft: "var(--space-6)" } : undefined}
			{...(select ? press : {})}
		>
			<Picture entry={entry} />
			<Facts entry={entry} now={props.now} timeZone={props.timeZone} />
			<button
				type="button"
				className="secondary compact"
				disabled={props.busy}
				onClick={() => props.onRestore(entry)}
			>
				{t("Restore")}
			</button>
			{props.inMenu ? (
				<button
					type="button"
					className="icon-button row-more"
					aria-haspopup="menu"
					aria-label={t("More")}
					disabled={props.busy}
					onClick={(event) => {
						const box = event.currentTarget.getBoundingClientRect();
						const items: MenuItem[] = [
							{
								id: "delete",
								label: t("Delete"),
								icon: "trash",
								tone: "danger",
								run: () => props.onDelete(entry),
							},
						];
						openMenu({
							title: entry.displayName,
							items,
							at: { x: box.left, y: box.bottom },
							via: "key",
							source: event.currentTarget,
						});
					}}
				>
					<Icon name="more" size={18} />
				</button>
			) : (
				<button
					type="button"
					className="compact danger"
					disabled={props.busy}
					onClick={() => props.onDelete(entry)}
				>
					{t("Delete")}
				</button>
			)}
		</li>
	);
}

/**
 * The agents and groups that were archived, which stay here with their history until they are
 * restored or deleted for good. A delete asks first and names what it deletes.
 */
export function ArchiveList(props: { deleteIn?: "button" | "menu" } = {}) {
	return <ArchiveListOf source={useArchive()} {...props} />;
}

/**
 * The same list over an archive its page already read, showing only `shown` (the rows an age filter
 * lets through); a page that is selecting hands over how rows are chosen.
 */
export function ArchiveListOf(props: {
	source: ArchiveSource;
	deleteIn?: "button" | "menu";
	shown?: readonly ArchivedEntry[];
	select?: ArchiveSelect;
}) {
	const { entries, error, load } = props.source;
	const { timeZone } = useConfig();
	const { now } = useLive();
	const [busy, setBusy] = useState<string>();
	const [deleting, setDeleting] = useState<ArchivedEntry>();

	const restore = async (entry: ArchivedEntry) => {
		setBusy(entry.name);
		try {
			if (entry.kind === "agent") await teamApi.restoreAgent(entry.name);
			else await teamApi.restoreGroup(entry.name);
			await refreshRooms();
			toast(t("Restored {name}.", { name: entry.displayName }));
			await load();
		} catch (failure) {
			toast(messageOf(failure), "danger");
		} finally {
			setBusy(undefined);
		}
	};

	if (error && !entries) return <Failure message={error} />;
	if (!entries) return <Loading />;
	const { select } = props;
	const rows = props.shown ?? entries;
	return (
		<div className="stack">
			<p className="meta">
				{t(
					"Archived knights and groups no longer answer. Their history is kept until you delete them.",
				)}
			</p>
			{entries.length === 0 ? <Empty>{t("Nothing is archived.")}</Empty> : null}
			<ul className="menu">
				{groupedEntries(rows).map((entry) => (
					<ArchiveRow
						key={entryId(entry)}
						entry={entry}
						busy={busy === entry.name}
						inMenu={props.deleteIn === "menu"}
						select={select}
						chosen={select?.chosen.has(entryId(entry)) ?? false}
						withParent={
							entry.parent !== undefined &&
							select?.chosen.has(`agent:${entry.parent}`) === true
						}
						now={now}
						timeZone={timeZone}
						onRestore={restore}
						onDelete={setDeleting}
					/>
				))}
			</ul>
			<Confirm
				open={deleting !== undefined}
				title={t("Delete {name}?", { name: deleting?.displayName ?? "" })}
				confirmLabel={t("Delete")}
				tone="danger"
				onClose={() => setDeleting(undefined)}
				onConfirm={async () => {
					if (!deleting) return;
					if (deleting.kind === "agent")
						await teamApi.deleteAgent(deleting.name);
					else await teamApi.deleteGroup(deleting.name);
					await refreshRooms();
					toast(t("Deleted {name}.", { name: deleting.displayName }));
					await load();
				}}
			>
				<p>
					{t(
						"{name} and its messages in this app are deleted for good, and the name can be used again. This cannot be undone.",
						{ name: deleting?.displayName ?? "" },
					)}
				</p>
			</Confirm>
		</div>
	);
}
