import { useLayoutEffect, useRef } from "react";
import type { WorkspaceEntry, WorkspaceRootView } from "../../src/api-types.ts";
import { Icon } from "../components/icons.tsx";
import { Empty, Failure, Loading } from "../components/states.tsx";
import { useConfig } from "../lib/config.ts";
import { size, when } from "../lib/format.ts";
import { translate as t } from "../lib/messages.ts";
import { Glyph } from "./icons.tsx";
import { entryTarget, hrefOf, QUIET, useListing } from "./shared.ts";

export function DirView(props: {
	root: WorkspaceRootView;
	path: string;
	onMenu(entry: WorkspaceEntry): void;
}) {
	const { data, error, at, pending } = useListing(props.root.id, props.path);
	const { timeZone } = useConfig();
	const top = useRef<HTMLDivElement>(null);
	const shownRoot = at?.root ?? props.root.id;
	const shownPath = at?.path ?? props.path;
	// A folder opens at its top, and the one it replaces is gone only once the new one is there.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a different folder on show is the trigger
	useLayoutEffect(() => {
		top.current?.closest(".ws-main")?.scrollTo?.(0, 0);
	}, [shownRoot, shownPath]);
	if (error) return <Failure message={error} />;
	if (!data) return <Loading />;
	if (data.missing) return <Empty>{t("No files yet")}</Empty>;
	if (data.entries.length === 0)
		return <Empty>{t("This folder is empty")}</Empty>;
	return (
		<div
			ref={top}
			className="ws-listing"
			data-pending={pending || undefined}
			aria-busy={pending || undefined}
			inert={pending || undefined}
		>
			<ul className="ws-rows">
				{data.entries.map((entry) => {
					const target = entryTarget(shownRoot, shownPath, entry);
					const body = (
						<>
							<Glyph
								name={target?.dir ? "folder" : "file"}
								size={20}
								className="ws-row-icon"
							/>
							<span className="ws-row-main">
								<strong>{entry.name}</strong>
								<span className="meta">
									{entry.kind === "symlink" && entry.inside === false
										? t("Outside the workspace")
										: entry.kind === "other"
											? t("Not a regular file")
											: [
													target?.dir ? undefined : size(entry.size),
													when(new Date(entry.mtimeMs).toISOString(), timeZone),
												]
													.filter(Boolean)
													.join(" · ")}
								</span>
							</span>
						</>
					);
					return (
						<li
							key={entry.name}
							className="ws-row"
							data-quiet={QUIET.has(entry.name) || undefined}
						>
							{target ? (
								<a className="ws-row-link" href={hrefOf(target)}>
									{body}
								</a>
							) : (
								<span className="ws-row-link" data-off>
									{body}
								</span>
							)}
							{props.root.writable || target ? (
								<button
									type="button"
									className="icon-button"
									aria-label={t("Actions for {name}", { name: entry.name })}
									onClick={() => props.onMenu(entry)}
								>
									<Icon name="menu" />
								</button>
							) : null}
						</li>
					);
				})}
			</ul>
			{data.truncated ? (
				<p className="meta">{t("Only the first 2,000 items are listed")}</p>
			) : null}
		</div>
	);
}
