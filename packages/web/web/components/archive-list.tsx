import { useCallback, useEffect, useState } from "react";
import type { ArchivedEntry } from "../../src/api-types.ts";
import { messageOf } from "../lib/api.ts";
import { translate as t } from "../lib/messages.ts";
import { refreshRooms, teamApi } from "../lib/team-api.ts";
import { toast } from "../lib/toast.ts";
import { Confirm } from "./confirm.tsx";
import { Icon } from "./icons.tsx";
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

/**
 * The agents and groups that were archived, which stay here with their history until they are
 * restored or deleted for good. A delete asks first and names what it deletes.
 */
export function ArchiveList() {
	const [entries, setEntries] = useState<ArchivedEntry[]>();
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState<string>();
	const [deleting, setDeleting] = useState<ArchivedEntry>();

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
	return (
		<div className="stack">
			<p className="meta">
				{t(
					"Archived knights and groups no longer answer. Their history is kept until you delete them.",
				)}
			</p>
			{entries.length === 0 ? <Empty>{t("Nothing is archived.")}</Empty> : null}
			<ul className="menu">
				{groupedEntries(entries).map((entry) => (
					<li
						key={`${entry.kind}:${entry.name}`}
						className="menu-item"
						data-helper={entry.parent ?? undefined}
						style={entry.parent ? { paddingLeft: "var(--space-6)" } : undefined}
					>
						<span className="menu-icon">
							<Icon name={entry.kind === "agent" ? "profile" : "rooms"} />
						</span>
						<span className="menu-text">
							<strong>{entry.displayName}</strong>
							<span className="meta">
								{entry.parent
									? t("Temp knight of {name}", { name: entry.parent })
									: entry.kind === "agent"
										? t("Knight")
										: t("Group")}{" "}
								· {entry.name}
							</span>
						</span>
						<button
							type="button"
							className="secondary compact"
							disabled={busy === entry.name}
							onClick={() => restore(entry)}
						>
							{t("Restore")}
						</button>
						<button
							type="button"
							className="compact danger"
							disabled={busy === entry.name}
							onClick={() => setDeleting(entry)}
						>
							{t("Delete")}
						</button>
					</li>
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
