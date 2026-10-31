import { useEffect, useId, useMemo, useState } from "react";
import type { GroupProfileView, RoomView } from "../../src/api-types.ts";
import { messageOf } from "../lib/api.ts";
import {
	COUNCIL_MAX,
	COUNCIL_MIN,
	chooseCouncil,
	hostOf,
	membersOf,
	slugFor,
	startingTicks,
	toggled,
	useCouncils,
} from "../lib/council.ts";
import { translate as t } from "../lib/messages.ts";
import { navigate } from "../lib/router.ts";
import { refreshRooms, teamApi } from "../lib/team-api.ts";
import { toast } from "../lib/toast.ts";
import { Chips } from "./chips.tsx";
import { RoomPicture } from "./room-picture.tsx";
import { useAgents } from "./round-table.tsx";
import { Sheet } from "./sheet.tsx";
import { Failure } from "./states.tsx";

/** Shows a council picked or made in the sheet: its group room's key and its name. */
export type CouncilGo = (council: { key: string; name: string }) => void;

const toTable: CouncilGo = (council) =>
	navigate("table", council.name, { replace: true });

/** One saved council: its members' faces and its name; pressing it puts it on the table. */
function CouncilRow(props: {
	view: RoomView;
	current: boolean;
	onPick(): void;
}) {
	const { view } = props;
	return (
		<li>
			<button
				type="button"
				className="menu-item council-row"
				aria-current={props.current || undefined}
				onClick={props.onPick}
			>
				<RoomPicture view={view} size={40} />
				<span className="menu-text">
					<strong>{view.displayName}</strong>
					<span className="meta">
						{t("{count} knights", { count: view.members?.length ?? 0 })}
					</span>
				</span>
			</button>
		</li>
	);
}

/**
 * The body of the council sheet: the saved councils, and the tick list that edits the one on the
 * table in place (Done) or saves what is ticked as a new one. It starts over each time the sheet
 * opens, from the council's members, or, when there is no council yet, from the agents that were
 * not muted.
 */
function CouncilBody(props: {
	open: boolean;
	council: RoomView | undefined;
	onClose(): void;
	go: CouncilGo;
}) {
	const { council } = props;
	const councils = useCouncils();
	const agents = useAgents();
	const [ticked, setTicked] = useState<string[]>([]);
	const [profile, setProfile] = useState<GroupProfileView>();
	const [host, setHost] = useState("");
	const [naming, setNaming] = useState(false);
	const [displayName, setDisplayName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const nameId = useId();
	const councilName = council?.name;
	const councilMembers = council?.members?.join("\n");

	// biome-ignore lint/correctness/useExhaustiveDependencies: the sheet starts over when it opens, from what the council is then
	useEffect(() => {
		if (!props.open) return;
		setError(undefined);
		setNaming(council === undefined);
		setDisplayName("");
		setBusy(false);
		setProfile(undefined);
		setHost("");
		setTicked(council ? [...(council.members ?? [])] : startingTicks(agents));
		if (!councilName) return;
		let current = true;
		teamApi.group(councilName).then(
			(group) => {
				if (!current) return;
				setProfile(group);
				setHost(group.host);
			},
			() => undefined,
		);
		return () => {
			current = false;
		};
	}, [props.open, councilName, councilMembers]);

	const known = useMemo(
		() => new Set(agents.map((view) => view.name)),
		[agents],
	);
	const coordinator = agents.find((view) => view.home)?.name;
	const members = membersOf(ticked, (name) => known.has(name));
	const hostNow = hostOf(members, host || undefined, coordinator);
	const labelOf = (name: string) =>
		agents.find((view) => view.name === name)?.displayName ?? name;
	const full = members.length >= COUNCIL_MAX;
	const enough = members.length >= COUNCIL_MIN;
	const changed =
		council === undefined ||
		members.join(",") !== (council.members ?? []).join(",") ||
		(profile !== undefined && hostNow !== profile.host);

	const finish = async (work: () => Promise<void>) => {
		setBusy(true);
		setError(undefined);
		try {
			await work();
			await refreshRooms();
		} catch (failure) {
			setError(messageOf(failure));
			setBusy(false);
			return false;
		}
		setBusy(false);
		return true;
	};

	const update = async () => {
		if (!council) return;
		const done = await finish(async () => {
			await teamApi.updateGroup(council.name, {
				...(members.join(",") !== (council.members ?? []).join(",")
					? { members }
					: {}),
				...(profile && hostNow !== profile.host ? { host: hostNow } : {}),
			});
		});
		if (!done) return;
		toast(t("Saved."));
		props.onClose();
	};

	const saveAs = async () => {
		const label = displayName.trim();
		if (label === "") return;
		const taken = new Set([
			...agents.map((view) => view.name),
			...councils.map((view) => view.name),
		]);
		let made: GroupProfileView | undefined;
		const done = await finish(async () => {
			made = await teamApi.createGroup({
				name: slugFor(label, taken),
				displayName: label,
				members,
				host: hostNow,
			});
		});
		if (!done || !made) return;
		chooseCouncil(made.room);
		props.go({ key: made.room, name: made.name });
		toast(t("Made {name}.", { name: made.displayName }));
		props.onClose();
	};

	return (
		<div className="stack council-sheet">
			{councils.length > 0 ? (
				<section className="stack" aria-label={t("Councils")}>
					<h3>{t("Councils")}</h3>
					<ul className="menu">
						{councils.map((view) => (
							<CouncilRow
								key={view.key}
								view={view}
								current={view.key === council?.key}
								onPick={() => {
									chooseCouncil(view.key);
									props.go(view);
									props.onClose();
								}}
							/>
						))}
					</ul>
				</section>
			) : null}
			<fieldset className="field council-pick">
				<legend>{council ? t("Edit this council") : t("Pick who sits")}</legend>
				<span className="meta council-count" aria-live="polite">
					{t("{count} of {max} picked", {
						count: members.length,
						max: COUNCIL_MAX,
					})}
					{full ? ` · ${t("At most {max} knights", { max: COUNCIL_MAX })}` : ""}
				</span>
				<ul className="menu">
					{agents.map((agent) => {
						const on = ticked.includes(agent.name);
						return (
							<li key={agent.key}>
								<label className="menu-item menu-toggle seat-row">
									<input
										type="checkbox"
										checked={on}
										disabled={!on && full}
										onChange={() =>
											setTicked(toggled(ticked, agent.name, COUNCIL_MAX))
										}
									/>
									<RoomPicture view={agent} size={32} />
									<span className="menu-text">
										<strong>{agent.displayName}</strong>
									</span>
								</label>
							</li>
						);
					})}
				</ul>
			</fieldset>
			{enough ? (
				<Chips
					label={t("Host")}
					value={hostNow}
					onChange={setHost}
					options={members.map((name) => ({
						value: name,
						label: labelOf(name),
					}))}
				/>
			) : (
				<span className="meta">
					{t("A council needs at least {min} knights.", { min: COUNCIL_MIN })}
				</span>
			)}
			{naming ? (
				<label htmlFor={nameId}>
					{t("Council name")}
					<input
						id={nameId}
						value={displayName}
						autoComplete="off"
						onChange={(event) => setDisplayName(event.target.value)}
					/>
				</label>
			) : null}
			{error ? <Failure message={error} /> : null}
			<div className="actions">
				{council && !naming ? (
					<>
						<button
							type="button"
							className="secondary"
							disabled={!enough || busy}
							onClick={() => setNaming(true)}
						>
							{t("Save as a new council")}
						</button>
						<button
							type="button"
							disabled={!enough || !changed || busy}
							onClick={update}
						>
							{busy ? t("Saving…") : t("Done")}
						</button>
					</>
				) : (
					<button
						type="button"
						disabled={!enough || displayName.trim() === "" || busy}
						onClick={saveAs}
					>
						{busy
							? t("Saving…")
							: council
								? t("Save as a new council")
								: t("Make council")}
					</button>
				)}
			</div>
		</div>
	);
}

/**
 * The round table's council sheet: the saved councils (groups), and the tick list. Ticking edits
 * the council on the table; Done saves it in place, Save as a new council makes another group, which
 * also opens its Discord channel as any group does. Mute is not here: it stays in the knight's sheet
 * and the room menu, and no longer decides who sits.
 */
export function CouncilSheet(props: {
	open: boolean;
	onClose(): void;
	council: RoomView | undefined;
	/** Where a council picked or made goes; the round table with it, unless the caller says otherwise. */
	go?: CouncilGo;
}) {
	return (
		<Sheet
			open={props.open}
			title={t("Council")}
			onClose={props.onClose}
			size="default"
		>
			<CouncilBody
				open={props.open}
				council={props.council}
				onClose={props.onClose}
				go={props.go ?? toTable}
			/>
		</Sheet>
	);
}
