import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import type { WorkspaceEntry, WorkspaceRootView } from "../../src/api-types.ts";
import { Confirm } from "../components/confirm.tsx";
import { Select } from "../components/fields.tsx";
import { Icon } from "../components/icons.tsx";
import { Sheet } from "../components/sheet.tsx";
import { Empty, Failure, Loading } from "../components/states.tsx";
import { messageOf } from "../lib/api.ts";
import { installStyle } from "../lib/lazy-style.ts";
import { useMedia } from "../lib/media.ts";
import { translate as t } from "../lib/messages.ts";
import { hrefFor, navigate, useRoute } from "../lib/router.ts";
import { toast } from "../lib/toast.ts";
import { rawHref, workspaceApi } from "../lib/workspace-api.ts";
import {
	join,
	type Place,
	parentOf,
	placeKey,
	placeOf,
	segmentsOf,
} from "../lib/workspace-place.ts";
// The files' styles load with this page, not with every visit: the page was already a lazy chunk.
import filesCss from "../styles/workspace.css" with { type: "text" };
import { DirView } from "../workspace/dir-view.tsx";
import { FileView } from "../workspace/file-view.tsx";
import { Glyph } from "../workspace/icons.tsx";
import { type NameAsk, NameDialog } from "../workspace/name-dialog.tsx";
import {
	entryTarget,
	forgetListings,
	hrefOf,
	keep,
	OPEN_KEY,
	rootLabel,
	SharedContext,
	stored,
	TREE_KEY,
} from "../workspace/shared.ts";
import { TrashDialog } from "../workspace/trash-dialog.tsx";
import { Breadcrumbs, TreeDir } from "../workspace/tree.tsx";

// The files pane: the roots the owner may see, a tree and breadcrumbs to move through them, a
// file shown with highlighting, and for a file that can be changed an editor with Save. The editor
// is a chunk of its own that loads when the first file opens.

installStyle("workspace", filesCss);

export { forgetListings };

export function WorkspacePage() {
	const route = useRoute();
	const phone = !useMedia("(min-width: 720px)");
	const [rev, setRev] = useState(0);
	const bump = useCallback(() => setRev((value) => value + 1), []);
	const shared = useMemo(() => ({ rev, bump }), [rev, bump]);
	const [roots, setRoots] = useState<WorkspaceRootView[]>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		workspaceApi.roots().then(
			(view) => setRoots(view.roots),
			(failure) => setError(messageOf(failure)),
		);
	}, []);
	const [treeWidth, setTreeWidth] = useState(() =>
		stored<number>(TREE_KEY, 280),
	);
	const [menuFor, setMenuFor] = useState<WorkspaceEntry>();
	const [ask, setAsk] = useState<NameAsk>();
	const [trash, setTrash] = useState(false);
	const [deleting, setDeleting] = useState<{ path: string; name: string }>();

	const requested = placeOf(route.key);
	const root =
		roots?.find((one) => one.id === requested?.root) ??
		(phone ? undefined : roots?.[0]);
	const place: Place | undefined = root
		? requested && requested.root === root.id
			? requested
			: { root: root.id, path: "", dir: true }
		: undefined;

	const rootId = root?.id;
	const placePath = place?.path;
	const placeIsDir = place?.dir;
	const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
	useEffect(() => {
		if (!rootId) return;
		setOpen(new Set(stored<string[]>(OPEN_KEY(rootId), [])));
	}, [rootId]);
	const toggle = useCallback(
		(path: string) => {
			if (!rootId) return;
			setOpen((current) => {
				const next = new Set(current);
				if (next.has(path)) next.delete(path);
				else next.add(path);
				keep(OPEN_KEY(rootId), [...next]);
				return next;
			});
		},
		[rootId],
	);
	// The folders on the way to the open place are open in the tree.
	useEffect(() => {
		if (!rootId || placePath === undefined || phone) return;
		const ways = segmentsOf(placeIsDir ? placePath : parentOf(placePath));
		const parents = ways.map((_, index) => ways.slice(0, index + 1).join("/"));
		setOpen((current) => {
			if (parents.every((one) => current.has(one))) return current;
			const next = new Set([...current, ...parents]);
			keep(OPEN_KEY(rootId), [...next]);
			return next;
		});
	}, [rootId, placePath, placeIsDir, phone]);

	if (error) return <Failure message={error} />;
	if (!roots) return <Loading />;
	if (roots.length === 0) return <Empty>{t("No files yet")}</Empty>;

	// A phone with no place chosen lists the roots.
	if (!root || !place)
		return (
			<SharedContext.Provider value={shared}>
				<div className="page ws-page">
					<header className="page-head">
						<h1>{t("Files")}</h1>
					</header>
					<ul className="more-list">
						{roots.map((one) => (
							<li key={one.id}>
								<a
									className="menu-item menu-link"
									href={hrefOf({ root: one.id, path: "", dir: true })}
								>
									<span className="menu-icon">
										<Glyph name="folder" />
									</span>
									<span className="menu-text">
										<strong>{rootLabel(one)}</strong>
										{one.writable ? null : (
											<span className="meta">{t("Read only")}</span>
										)}
									</span>
									<Icon name="chevron" size={16} />
								</a>
							</li>
						))}
					</ul>
				</div>
			</SharedContext.Provider>
		);

	const here = place.dir ? place.path : parentOf(place.path);
	const upPlace: Place =
		place.path === ""
			? { root: root.id, path: "", dir: true }
			: { root: root.id, path: parentOf(place.path), dir: true };

	const head = (
		<header className="ws-head">
			{phone ? (
				<a
					className="icon-button"
					aria-label={t("Back")}
					href={place.path === "" ? hrefFor("workspace") : hrefOf(upPlace)}
				>
					<Icon name="back" />
				</a>
			) : (
				<Select
					chip
					className="ws-root-picker"
					aria-label={t("Place")}
					value={root.id}
					onChange={(event) =>
						navigate(
							"workspace",
							placeKey({ root: event.target.value, path: "", dir: true }),
						)
					}
				>
					{roots.map((one) => (
						<option key={one.id} value={one.id}>
							{rootLabel(one)}
						</option>
					))}
				</Select>
			)}
			<Breadcrumbs root={root} path={place.path} />
			{root.writable ? (
				<div className="ws-head-actions">
					<button
						type="button"
						className="icon-button"
						aria-label={t("New file")}
						title={t("New file")}
						onClick={() => setAsk({ kind: "file", dir: here })}
					>
						<Glyph name="file-plus" />
					</button>
					<button
						type="button"
						className="icon-button"
						aria-label={t("New folder")}
						title={t("New folder")}
						onClick={() => setAsk({ kind: "dir", dir: here })}
					>
						<Glyph name="folder-plus" />
					</button>
					<button
						type="button"
						className="icon-button"
						aria-label={t("Trash")}
						title={t("Trash")}
						onClick={() => setTrash(true)}
					>
						<Icon name="trash" />
					</button>
				</div>
			) : null}
		</header>
	);

	const main = place.dir ? (
		<div className="ws-dir">
			<DirView
				root={root}
				path={place.path}
				onMenu={(entry) => setMenuFor(entry)}
			/>
		</div>
	) : (
		<FileView
			key={`${root.id}:${place.path}`}
			root={root}
			path={place.path}
			phone={phone}
		/>
	);

	const menuTarget = menuFor ? entryTarget(root.id, here, menuFor) : undefined;
	const menuPath = menuFor ? join(here, menuFor.name) : "";

	return (
		<SharedContext.Provider value={shared}>
			<div
				className="ws-page ws"
				data-wide={!phone || undefined}
				style={{ "--ws-tree": `${treeWidth}px` } as React.CSSProperties}
			>
				{head}
				<div className="ws-body">
					{!phone ? (
						<>
							<aside className="ws-tree" aria-label={t("Folders")}>
								<TreeDir
									root={root.id}
									path=""
									depth={0}
									open={open}
									toggle={toggle}
									current={place}
								/>
							</aside>
							<Resizer
								width={treeWidth}
								onChange={(width) => {
									setTreeWidth(width);
									keep(TREE_KEY, width);
								}}
							/>
						</>
					) : null}
					<section className="ws-main">{main}</section>
				</div>
			</div>

			<Sheet
				open={menuFor !== undefined}
				title={menuFor?.name ?? ""}
				onClose={() => setMenuFor(undefined)}
			>
				<ul className="more-list">
					{menuTarget && !menuTarget.dir ? (
						<li>
							<a
								className="menu-item menu-link"
								href={rawHref(root.id, menuPath, true)}
								download={menuFor?.name}
								onClick={() => setMenuFor(undefined)}
							>
								<span className="menu-icon">
									<Icon name="download" />
								</span>
								<span className="menu-text">
									<strong>{t("Download")}</strong>
								</span>
							</a>
						</li>
					) : null}
					{root.writable && menuFor ? (
						<>
							<li>
								<button
									type="button"
									className="menu-item"
									onClick={() => {
										setAsk({
											kind: "rename",
											path: menuPath,
											name: menuFor.name,
										});
										setMenuFor(undefined);
									}}
								>
									<span className="menu-icon">
										<Icon name="notes" />
									</span>
									<span className="menu-text">
										<strong>{t("Rename")}</strong>
									</span>
								</button>
							</li>
							<li>
								<button
									type="button"
									className="menu-item"
									onClick={() => {
										setDeleting({ path: menuPath, name: menuFor.name });
										setMenuFor(undefined);
									}}
								>
									<span className="menu-icon">
										<Icon name="trash" />
									</span>
									<span className="menu-text">
										<strong>{t("Delete")}</strong>
									</span>
								</button>
							</li>
						</>
					) : null}
				</ul>
			</Sheet>

			<NameDialog
				root={root}
				ask={ask}
				onClose={() => setAsk(undefined)}
				onDone={(made) => {
					setAsk(undefined);
					bump();
					if (made) navigate("workspace", placeKey(made));
				}}
			/>
			<TrashDialog root={root} open={trash} onClose={() => setTrash(false)} />
			<Confirm
				open={deleting !== undefined}
				title={t("Move to the trash?")}
				confirmLabel={t("Delete")}
				tone="danger"
				onClose={() => setDeleting(undefined)}
				onConfirm={async () => {
					if (!deleting) return;
					await workspaceApi.remove(root.id, deleting.path);
					toast(t("Moved to the trash"));
					bump();
					// A file that is open and was deleted gives way to its folder.
					if (
						!place.dir &&
						(place.path === deleting.path ||
							place.path.startsWith(`${deleting.path}/`))
					)
						navigate(
							"workspace",
							placeKey({
								root: root.id,
								path: parentOf(place.path),
								dir: true,
							}),
						);
				}}
			>
				<p>
					{t("“{name}” goes to the trash, where you can bring it back.", {
						name: deleting?.name ?? "",
					})}
				</p>
			</Confirm>
		</SharedContext.Provider>
	);
}

/** The drag handle between the tree and the file; arrow keys move it too. */
function Resizer(props: { width: number; onChange(width: number): void }) {
	const MIN = 180;
	const MAX = 560;
	const clamp = (value: number) => Math.min(MAX, Math.max(MIN, value));
	return (
		// biome-ignore lint/a11y/useSemanticElements: a splitter has no native element
		<div
			className="ws-resizer"
			role="separator"
			aria-orientation="vertical"
			aria-valuenow={props.width}
			aria-valuemin={MIN}
			aria-valuemax={MAX}
			aria-label={t("Resize the folder list")}
			tabIndex={0}
			onKeyDown={(event) => {
				if (event.key === "ArrowLeft") props.onChange(clamp(props.width - 16));
				if (event.key === "ArrowRight") props.onChange(clamp(props.width + 16));
			}}
			onPointerDown={(event) => {
				const startX = event.clientX;
				const start = props.width;
				const target = event.currentTarget;
				target.setPointerCapture(event.pointerId);
				const move = (move: PointerEvent) =>
					props.onChange(clamp(start + move.clientX - startX));
				const up = () => {
					target.removeEventListener("pointermove", move);
					target.removeEventListener("pointerup", up);
				};
				target.addEventListener("pointermove", move);
				target.addEventListener("pointerup", up);
			}}
		/>
	);
}

export type { ReactNode };
