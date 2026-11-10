import { type ReactNode, useId, useState } from "react";
import type { ConversationView } from "../../src/api-types.ts";
import { DeleteForGood } from "../components/delete-confirm.tsx";
import {
	AgentRow,
	GroupCard,
	PartyRow,
} from "../components/overview-cards.tsx";
import { FoldToggle } from "../components/section-fold.tsx";
import {
	type BarAction,
	IdleChips,
	SelectAll,
	SelectBar,
} from "../components/select-bar.tsx";
import { Empty, Failure, Loading } from "../components/states.tsx";
import { StoredRow, storedTitle } from "../components/stored-row.tsx";
import { api } from "../lib/api.ts";
import { useBatch } from "../lib/batch.ts";
import { useConfig } from "../lib/config.ts";
import { useCollapsed } from "../lib/folds.ts";
import { size } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { plural, translate as t } from "../lib/messages.ts";
import {
	deleteConversationsBatch,
	startOverBatch,
} from "../lib/overview-batch.ts";
import {
	type Idle,
	idleCounts,
	idleRows,
	useSelecting,
} from "../lib/selection.ts";
import { useFetched } from "../lib/use-fetched.ts";

// Kept as `section:` folds, which a pruning of the room list's folders leaves alone. The workspaces start
// open and the id says when they are folded; the others start folded, so their id says when they are open.
const BOT = "section:overview-bot-open";
const WORK = "section:overview-workspaces";
const OUTSIDE = "section:overview-outside-open";
const PARTY = "section:overview-party-open";

export { GroupCard };

/** A section of the overview whose heading folds it; the fold is kept on this device. */
function Fold(props: {
	id: string;
	/** The section starts folded, and its id is in the device's folds while it is open. */
	startFolded?: boolean;
	title: string;
	/** What the section holds, said beside the heading whether it is open or folded. */
	summary: string;
	/** Beside the summary: "Select all in section" while the page is selecting. */
	action?: ReactNode;
	children: ReactNode;
}) {
	const kept = useCollapsed().has(props.id);
	const folded = props.startFolded ? !kept : kept;
	const bodyId = useId();
	return (
		<section className="stack">
			<div className="fold-head">
				<h2>
					<FoldToggle
						id={props.id}
						name={props.title}
						open={!folded}
						controls={bodyId}
					/>
				</h2>
				<span className="meta">{props.summary}</span>
				{props.action}
			</div>
			<div id={bodyId} className="stack fold-body" hidden={folded}>
				{props.children}
			</div>
		</section>
	);
}

/** The list of one kind of stored conversation, with its age filter and the way to choose rows while the page selects. */
function Stored(props: {
	section: string;
	rows: readonly (ConversationView & { schedules?: number })[];
	idle: Idle;
	onIdle(idle: Idle): void;
	empty: string;
	pick: ReturnType<typeof useSelecting>;
	now: number;
	refresh(): void;
}) {
	const { pick, section } = props;
	if (props.rows.length === 0) return <Empty>{props.empty}</Empty>;
	const shown = pick.on
		? idleRows(props.rows, (one) => one.lastActive, props.now, props.idle)
		: props.rows;
	return (
		<>
			{pick.on ? (
				<IdleChips
					counts={idleCounts(props.rows, (one) => one.lastActive, props.now)}
					value={props.idle}
					onChange={props.onIdle}
				/>
			) : null}
			<ul className="stored-list">
				{shown.map((c) => (
					<StoredRow
						key={c.key}
						conversation={c}
						{...(c.schedules === undefined ? {} : { schedules: c.schedules })}
						now={props.now}
						refresh={props.refresh}
						pick={{
							selecting: pick.on,
							chosen: pick.has(section, c.key),
							toggle: () => pick.toggle(section, c.key),
							hold: () => pick.enter({ section, key: c.key }),
						}}
					/>
				))}
			</ul>
		</>
	);
}

export function OverviewPage() {
	const config = useConfig();
	const { now } = useLive();
	const [revision, setRevision] = useState(0);
	const refresh = () => setRevision((value) => value + 1);
	const { data: view, error } = useFetched(
		() => api.overview(),
		`overview:${revision}`,
	);
	const pick = useSelecting();
	const batch = useBatch(pick.clear);
	const [idles, setIdles] = useState<Record<string, Idle>>({});
	const [asking, setAsking] = useState(false);
	if (!view) return error ? <Failure message={error} /> : <Loading />;

	const workspaces = view.workspaces ?? [];
	const outside = view.outside ?? [];
	const party = view.party ?? [];
	const stored = [
		{ section: "workspaces", rows: workspaces },
		{ section: "outside", rows: outside },
	];
	const idleOf = (section: string): Idle => idles[section] ?? 0;
	const shownIn = (section: string, rows: readonly ConversationView[]) =>
		pick.on
			? idleRows(rows, (one) => one.lastActive, now, idleOf(section))
			: rows;
	const chosen = stored
		.filter((one) => one.section === pick.section)
		.flatMap((one) => one.rows.filter((row) => pick.keys.has(row.key)));
	const nameOf = (c: ConversationView) => storedTitle(c).title;
	const allIn = (section: string, rows: readonly ConversationView[]) => {
		const keys = shownIn(section, rows).map((one) => one.key);
		return {
			selecting: pick.on,
			empty: keys.length === 0,
			allChosen:
				pick.section === section &&
				keys.length > 0 &&
				keys.every((key) => pick.keys.has(key)),
			onAll: () => pick.all(section, keys),
		};
	};
	const leave = () => {
		pick.leave();
		setIdles({});
	};
	const section = (id: string, rows: readonly ConversationView[]) => ({
		section: id,
		rows,
		idle: idleOf(id),
		onIdle: (next: Idle) => {
			setIdles((now) => ({ ...now, [id]: next }));
			if (pick.section === id) pick.clear();
		},
		pick,
		now,
		refresh,
	});
	const actions: BarAction[] = pick.section
		? [
				{
					id: "start-over",
					label: t("Start over"),
					onPress: () =>
						void batch.start(startOverBatch(chosen, nameOf, refresh)),
				},
				{
					id: "delete",
					label: t("Delete for good"),
					tone: "danger",
					onPress: () => setAsking(true),
				},
			]
		: [];
	const busyBots =
		view.agents.filter((a) => a.workingIn || a.waiting > 0).length +
		view.groups.filter((g) => g.busy > 0).length;
	return (
		<>
			{error ? <Failure message={error} /> : null}
			{config.cleanup && workspaces.length + outside.length > 0 ? (
				<div className="actions">
					<button
						type="button"
						className="secondary compact"
						aria-pressed={pick.on}
						onClick={pick.on ? leave : () => pick.enter()}
					>
						{pick.on ? t("Done") : t("Select")}
					</button>
				</div>
			) : null}
			<Fold
				id={BOT}
				startFolded
				title={t("Bot server")}
				summary={[
					plural(view.agents.length, "{count} knight", "{count} knights"),
					plural(view.groups.length, "{count} group", "{count} groups"),
					busyBots > 0 ? t("{count} busy", { count: busyBots }) : t("all idle"),
				].join(" · ")}
			>
				<p className="hint">
					{t(
						"Knight and group status; starting over archives the conversation and preserves memory.",
					)}
				</p>
				{view.agents.length + view.groups.length === 0 ? (
					<Empty>{t("No knights.")}</Empty>
				) : null}
				{view.agents.map((agent) => (
					<AgentRow
						key={agent.name}
						agent={agent}
						groups={view.groups}
						agents={view.agents}
						guildId={view.guildId}
						now={now}
						refresh={refresh}
					/>
				))}
				{view.groups.map((group) => (
					<GroupCard
						key={group.name}
						group={group}
						guildId={view.guildId}
						now={now}
						timeZone={config.timeZone}
						refresh={refresh}
					/>
				))}
			</Fold>
			<Fold
				id={WORK}
				title={t("My workspaces")}
				summary={String(workspaces.length)}
				action={<SelectAll {...allIn("workspaces", workspaces)} />}
			>
				<p className="hint">
					{t(
						"Direct messages and channels where you mention a knight. Start over archives; delete removes every archive permanently.",
					)}
				</p>
				<Stored
					{...section("workspaces", workspaces)}
					empty={t("No workspaces.")}
				/>
			</Fold>
			<Fold
				id={OUTSIDE}
				startFolded
				title={t("Outside AI client conversations")}
				summary={String(outside.length)}
				action={<SelectAll {...allIn("outside", outside)} />}
			>
				<p className="hint">
					{t(
						"Conversations opened through remote MCP; after deletion the session ID cannot be resumed.",
					)}
				</p>
				<Stored
					{...section("outside", outside)}
					empty={t("No outside AI client conversations.")}
				/>
			</Fold>
			<Fold
				id={PARTY}
				startFolded
				title={t("Party channels")}
				summary={String(party.length)}
			>
				<p className="hint">
					{t(
						"Starting over stops the container and archives role conversations; each speaker's memory is preserved.",
					)}
				</p>
				{party.length ? (
					party.map((p) => (
						<PartyRow key={p.key} party={p} now={now} refresh={refresh} />
					))
				) : (
					<Empty>{t("No party channels.")}</Empty>
				)}
			</Fold>
			{pick.on ? (
				<SelectBar
					count={pick.keys.size}
					actions={actions}
					running={batch.running}
					outcome={batch.outcome}
					onDismiss={batch.dismiss}
				/>
			) : null}
			<DeleteForGood
				open={asking}
				names={chosen.map(nameOf)}
				notes={[
					t(
						"The live conversation and all archives will be permanently deleted. Memory and schedules are preserved.",
					),
					t("Live conversations hold {size} in all.", {
						size: size(chosen.reduce((sum, one) => sum + one.liveBytes, 0)),
					}),
				]}
				onClose={() => setAsking(false)}
				onConfirm={async () => {
					void batch.start(deleteConversationsBatch(chosen, nameOf, refresh));
				}}
			/>
		</>
	);
}
