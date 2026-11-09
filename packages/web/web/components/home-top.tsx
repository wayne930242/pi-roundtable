import { Suspense } from "react";
import { NoticeBell } from "../app-pages.ts";
import { useSelector } from "../lib/app-store.ts";
import { useConfig } from "../lib/config.ts";
import { plural, translate as t } from "../lib/messages.ts";
import { hrefFor } from "../lib/router.ts";
import { openCards } from "../lib/tab-count.ts";
import { Icon } from "./icons.tsx";

/** The letters a person's picture carries: the first of up to two words of their name. */
export function initialsOf(name: string | undefined): string {
	const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
	return words
		.slice(0, 2)
		.map((word) => Array.from(word)[0] ?? "")
		.join("")
		.toUpperCase();
}

/**
 * The chat home's top row: the person's own picture (their profile), the cards waiting on them, the
 * notice bell where the app admits more than its owners, and the "+" of the add menu.
 */
export function HomeTop(props: { onAdd(button: HTMLElement): void }) {
	const config = useConfig();
	const name = useSelector((state) => state.principal?.name);
	const waiting = useSelector(openCards);
	const label = waiting
		? plural(waiting, "{count} card waiting", "{count} cards waiting")
		: "";
	return (
		<header className="chats-top">
			<a
				className="chats-me"
				href={hrefFor("profile")}
				aria-label={t("Profile")}
				title={name}
			>
				{initialsOf(name) || <Icon name="profile" size={18} />}
			</a>
			{waiting ? (
				<button
					type="button"
					className="chats-waiting"
					aria-label={label}
					onClick={() =>
						import("../lib/waiting.ts").then((m) => m.openWaiting())
					}
				>
					<Icon name="hourglass" size={16} />
					<span>{label}</span>
				</button>
			) : null}
			<span className="chats-top-end">
				{config.tier !== undefined ? (
					<Suspense fallback={null}>
						<NoticeBell />
					</Suspense>
				) : null}
				<button
					type="button"
					className="icon-button chats-add"
					aria-label={t("Add")}
					aria-haspopup="menu"
					onClick={(event) => props.onAdd(event.currentTarget)}
				>
					<Icon name="plus" />
				</button>
			</span>
		</header>
	);
}
