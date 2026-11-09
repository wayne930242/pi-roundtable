import { useEffect, useRef } from "react";
import type { WorkspaceRootView } from "../../src/api-types.ts";
import { Icon } from "../components/icons.tsx";
import { translate as t } from "../lib/messages.ts";
import { join, type Place, segmentsOf } from "../lib/workspace-place.ts";
import { Glyph } from "./icons.tsx";
import { entryTarget, hrefOf, QUIET, rootLabel, useListing } from "./shared.ts";

export function Breadcrumbs(props: { root: WorkspaceRootView; path: string }) {
	const parts = segmentsOf(props.path);
	const last = useRef<HTMLAnchorElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new place scrolls its last chip into view
	useEffect(() => {
		last.current?.scrollIntoView?.({ inline: "end", block: "nearest" });
	}, [props.path]);
	return (
		<nav className="ws-crumbs" aria-label={t("Path")}>
			<a
				ref={parts.length === 0 ? last : undefined}
				href={hrefOf({ root: props.root.id, path: "", dir: true })}
				aria-current={parts.length === 0 ? "page" : undefined}
			>
				{rootLabel(props.root)}
			</a>
			{parts.map((part, index) => {
				const path = parts.slice(0, index + 1).join("/");
				const leaf = index === parts.length - 1;
				return (
					<a
						key={path}
						ref={leaf ? last : undefined}
						href={hrefOf({ root: props.root.id, path, dir: true })}
						aria-current={leaf ? "page" : undefined}
					>
						{part}
					</a>
				);
			})}
		</nav>
	);
}

// ── The tree ───────────────────────────────────────────────────────────────────────────────────

export function TreeDir(props: {
	root: string;
	path: string;
	depth: number;
	open: ReadonlySet<string>;
	toggle(path: string): void;
	current: Place | undefined;
}) {
	const { data, error, pending } = useListing(props.root, props.path);
	if (error) return <p className="ws-tree-note">{error}</p>;
	// Another root's folders are not shown in this one's place while it loads.
	if (!data || pending) return <p className="ws-tree-note">…</p>;
	if (data.entries.length === 0)
		return <p className="ws-tree-note">{t("This folder is empty")}</p>;
	return (
		<ul className="ws-tree-list" data-depth={props.depth}>
			{data.entries.map((entry) => {
				const target = entryTarget(props.root, props.path, entry);
				const path = join(props.path, entry.name);
				const isDir = target?.dir === true;
				const expanded = isDir && props.open.has(path);
				const selected =
					props.current?.root === props.root &&
					props.current.path === path &&
					props.current.dir === isDir;
				return (
					<li key={entry.name}>
						<div
							className="ws-tree-row"
							data-selected={selected || undefined}
							data-quiet={QUIET.has(entry.name) || undefined}
							style={{ paddingLeft: `${0.25 + props.depth * 0.875}rem` }}
						>
							{isDir ? (
								<button
									type="button"
									className="ws-twist"
									aria-expanded={expanded}
									aria-label={t("Show or hide {name}", { name: entry.name })}
									onClick={() => props.toggle(path)}
								>
									<Icon name="chevron" size={14} />
								</button>
							) : (
								<span className="ws-twist" />
							)}
							{target ? (
								<a href={hrefOf(target)} title={entry.name}>
									<Glyph name={isDir ? "folder" : "file"} size={15} />
									<span className="ws-tree-label">{entry.name}</span>
								</a>
							) : (
								<span
									className="ws-tree-off"
									title={
										entry.inside === false ? t("Outside the workspace") : ""
									}
								>
									<Icon name="file" size={15} />
									<span className="ws-tree-label">{entry.name}</span>
								</span>
							)}
						</div>
						{expanded ? (
							<TreeDir
								root={props.root}
								path={path}
								depth={props.depth + 1}
								open={props.open}
								toggle={props.toggle}
								current={props.current}
							/>
						) : null}
					</li>
				);
			})}
			{data.truncated ? (
				<li className="ws-tree-note">
					{t("Only the first 2,000 items are listed")}
				</li>
			) : null}
		</ul>
	);
}
