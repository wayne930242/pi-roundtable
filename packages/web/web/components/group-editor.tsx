import { useEffect, useId, useState } from "react";
import type { GroupProfileView } from "../../src/api-types.ts";
import { messageOf } from "../lib/api.ts";
import { translate as t } from "../lib/messages.ts";
import { askRoomConfirm } from "../lib/room-confirm.ts";
import { navigate } from "../lib/router.ts";
import { refreshRooms, teamApi } from "../lib/team-api.ts";
import { toast } from "../lib/toast.ts";
import { Chips } from "./chips.tsx";
import { TextField } from "./fields.tsx";
import { KnightPicker, useKnights } from "./knight-picker.tsx";
import { Failure, Loading } from "./states.tsx";

const NAME = /^[a-z0-9-]{1,32}$/;
const MIN_MEMBERS = 2;
const MAX_MEMBERS = 8;

/**
 * Makes a group, or edits one: its name, which agents are in it and which of them is the host, who
 * answers when nobody else fits. Members keep the order they were picked in, which is their
 * speaking-tie order.
 */
export function GroupEditor(props: { name?: string; onDone(): void }) {
	const agents = useKnights();
	const [loaded, setLoaded] = useState<GroupProfileView>();
	const [error, setError] = useState<string>();
	const [displayName, setDisplayName] = useState("");
	const [name, setName] = useState("");
	const [named, setNamed] = useState(false);
	const [members, setMembers] = useState<string[]>([]);
	const [host, setHost] = useState("");
	const [saving, setSaving] = useState(false);
	const [ready, setReady] = useState(props.name === undefined);
	const nameId = useId();
	const idId = useId();

	useEffect(() => {
		const editing = props.name;
		if (editing === undefined) return;
		let current = true;
		teamApi.group(editing).then(
			(group) => {
				if (!current) return;
				setLoaded(group);
				setDisplayName(group.displayName);
				setMembers(group.members);
				setHost(group.host);
				setReady(true);
			},
			(failure) => current && setError(messageOf(failure)),
		);
		return () => {
			current = false;
		};
	}, [props.name]);

	const labelOf = (agent: string) =>
		agents.find((one) => one.name === agent)?.displayName ?? agent;
	// The host is one of the members; when the one chosen leaves, the first member takes over.
	const hostNow = members.includes(host) ? host : (members[0] ?? "");

	const changed =
		loaded === undefined
			? true
			: displayName.trim() !== loaded.displayName ||
				members.join(",") !== loaded.members.join(",") ||
				hostNow !== loaded.host;
	const valid =
		displayName.trim() !== "" &&
		members.length >= MIN_MEMBERS &&
		members.length <= MAX_MEMBERS &&
		(loaded !== undefined || NAME.test(name));

	if (error && !ready) return <Failure message={error} />;
	if (!ready) return <Loading />;

	const save = async () => {
		setSaving(true);
		setError(undefined);
		try {
			if (loaded) {
				await teamApi.updateGroup(loaded.name, {
					...(displayName.trim() !== loaded.displayName
						? { displayName: displayName.trim() }
						: {}),
					...(members.join(",") !== loaded.members.join(",")
						? { members }
						: {}),
					...(hostNow !== loaded.host ? { host: hostNow } : {}),
				});
				await refreshRooms();
				toast(t("Saved."));
				props.onDone();
				return;
			}
			const made = await teamApi.createGroup({
				name,
				displayName: displayName.trim(),
				members,
				host: hostNow,
			});
			await refreshRooms();
			toast(t("Made {name}.", { name: made.displayName }));
			props.onDone();
			navigate("room", made.room);
		} catch (failure) {
			setError(messageOf(failure));
		} finally {
			setSaving(false);
		}
	};

	return (
		<form
			className="stack form"
			onSubmit={(event) => {
				event.preventDefault();
				if (valid && changed && !saving) save();
			}}
		>
			<label htmlFor={nameId}>
				{t("Name")}
				<TextField
					id={nameId}
					value={displayName}
					autoComplete="off"
					onChange={(event) => {
						setDisplayName(event.target.value);
						if (!loaded && !named)
							setName(
								event.target.value
									.toLowerCase()
									.replace(/[^a-z0-9]+/g, "-")
									.replace(/^-+|-+$/g, "")
									.slice(0, 32),
							);
					}}
				/>
			</label>
			{loaded ? null : (
				<label htmlFor={idId}>
					{t("Permanent name")}
					<TextField
						id={idId}
						value={name}
						autoComplete="off"
						autoCapitalize="none"
						spellCheck={false}
						aria-invalid={name !== "" && !NAME.test(name)}
						onChange={(event) => {
							setNamed(true);
							setName(event.target.value);
						}}
					/>
					<span className="meta">
						{t(
							"Lowercase letters, digits and dashes, up to 32. It names the room and cannot be changed.",
						)}
					</span>
				</label>
			)}
			<KnightPicker
				label={t("Members")}
				hint={t("Pick 2 to 8 knights. They take turns in the order picked.")}
				chosen={members}
				onChange={setMembers}
				max={MAX_MEMBERS}
			/>
			{members.length >= MIN_MEMBERS ? (
				<Chips
					label={t("Host")}
					value={hostNow}
					onChange={setHost}
					options={members.map((member) => ({
						value: member,
						label: labelOf(member),
					}))}
				/>
			) : null}
			{error ? <Failure message={error} /> : null}
			<div className="actions">
				{loaded ? (
					<button
						type="button"
						className="danger"
						onClick={() => {
							props.onDone();
							askRoomConfirm({
								kind: "archive",
								room: loaded.room,
								name: loaded.displayName,
							});
						}}
					>
						{t("Archive group")}
					</button>
				) : null}
				<button type="submit" disabled={!valid || !changed || saving}>
					{saving ? t("Saving…") : loaded ? t("Save") : t("Make group")}
				</button>
			</div>
		</form>
	);
}
