import { useEffect, useMemo, useRef, useState } from "react";
import { useSelector } from "../lib/app-store.ts";
import { fuzzyScore } from "../lib/fuzzy.ts";
import { composingKey } from "../lib/ime.ts";
import { translate as t } from "../lib/messages.ts";
import { hrefFor, navigate } from "../lib/router.ts";
import { Avatar } from "./avatar.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { Sheet } from "./sheet.tsx";

interface Target {
	id: string;
	label: string;
	hint: string;
	avatar?: { name: string; src: string | undefined };
	icon?: IconName;
	go(): void;
}

/** The room switcher: type a few letters of a room or page, arrows to choose, Enter to go. */
export function Palette(props: {
	open: boolean;
	onClose(): void;
	pages: { pane: string; label: string; icon: IconName }[];
}) {
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const input = useRef<HTMLInputElement>(null);
	const rooms = useSelector((state) =>
		state.order.flatMap((key) => {
			const view = state.rooms[key]?.view;
			return view
				? [
						{
							key,
							name: view.displayName,
							avatar: view.avatar,
							kind: view.kind,
						},
					]
				: [];
		}),
	);
	const list = useMemo(() => {
		const targets: Target[] = [
			...rooms.map((room) => ({
				id: room.key,
				label: room.name,
				hint:
					room.kind === "agent"
						? t("Agent")
						: room.kind === "group"
							? t("Group")
							: t("Thread"),
				avatar: { name: room.name, src: room.avatar },
				go: () => navigate("room", room.key),
			})),
			...props.pages.map((page) => ({
				id: page.pane,
				label: page.label,
				hint: t("Page"),
				icon: page.icon,
				go: () => navigate(page.pane),
			})),
		];
		return targets
			.flatMap((target) => {
				const score = fuzzyScore(query, target.label);
				return score === undefined ? [] : [{ target, score }];
			})
			.sort((a, b) => b.score - a.score)
			.map((entry) => entry.target)
			.slice(0, 12);
	}, [rooms, props.pages, query]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at the top
	useEffect(() => setActive(0), [query]);
	useEffect(() => {
		if (props.open) {
			setQuery("");
			requestAnimationFrame(() => input.current?.focus());
		}
	}, [props.open]);

	const choose = (target: Target | undefined) => {
		if (!target) return;
		props.onClose();
		target.go();
	};

	return (
		<Sheet
			open={props.open}
			title={t("Find a room")}
			onClose={props.onClose}
			variant="palette"
		>
			<div className="palette-box">
				<div className="palette-input">
					<Icon name="search" size={18} />
					<input
						ref={input}
						value={query}
						placeholder={t("Find a room or page")}
						aria-label={t("Find a room or page")}
						role="combobox"
						aria-expanded="true"
						aria-controls="palette-list"
						aria-activedescendant={
							list[active] ? `palette-${active}` : undefined
						}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							// Keys that belong to an input method's candidate list are not the palette's.
							if (composingKey(event.nativeEvent)) return;
							if (event.key === "ArrowDown") {
								event.preventDefault();
								setActive((value) => Math.min(list.length - 1, value + 1));
							} else if (event.key === "ArrowUp") {
								event.preventDefault();
								setActive((value) => Math.max(0, value - 1));
							} else if (event.key === "Enter") {
								event.preventDefault();
								choose(list[active]);
							}
						}}
					/>
					<kbd>Esc</kbd>
				</div>
				<ul className="palette-list">
					{list.length === 0 ? (
						<li className="palette-empty">{t("Nothing matches.")}</li>
					) : null}
					{list.map((target, index) => (
						<li key={target.id} data-active={index === active || undefined}>
							<a
								href={
									target.avatar
										? hrefFor("room", target.id)
										: hrefFor(target.id)
								}
								onClick={(event) => {
									event.preventDefault();
									choose(target);
								}}
								onMouseMove={() => setActive(index)}
								aria-current={index === active ? "true" : undefined}
							>
								{target.avatar ? (
									<Avatar
										name={target.avatar.name}
										src={target.avatar.src}
										size={28}
									/>
								) : (
									<span className="palette-icon">
										<Icon name={target.icon ?? "list"} size={16} />
									</span>
								)}
								<span className="palette-label">{target.label}</span>
								<span className="meta">{target.hint}</span>
							</a>
						</li>
					))}
				</ul>
			</div>
		</Sheet>
	);
}
