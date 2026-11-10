import { useState } from "react";
import type { ConversationView } from "../../src/api-types.ts";
import { openMenu } from "../lib/action-menu.ts";
import { useConfig } from "../lib/config.ts";
import { channelTitle, discordUrl, size } from "../lib/format.ts";
import { type PressRequest, useLongPress } from "../lib/long-press.ts";
import { plural, translate as t } from "../lib/messages.ts";
import { navigate } from "../lib/router.ts";
import { lastActive } from "../lib/selection.ts";
import { type CleanupAction, CleanupDialog } from "./cleanup.tsx";
import { Icon } from "./icons.tsx";
import { SelectBox } from "./select-bar.tsx";
import { Badge } from "./states.tsx";

/** What a stored conversation is called in a list, and the line under it. */
export function storedTitle(c: ConversationView): {
	title: string;
	detail: string | undefined;
} {
	const { title, detail } =
		c.kind === "outside"
			? { title: c.firstMessage || t("(No messages)"), detail: c.id }
			: channelTitle(c.channel, c.id);
	return { title, detail };
}

/** How a row is chosen while the page is selecting. */
export interface StoredPick {
	selecting: boolean;
	chosen: boolean;
	toggle(): void;
	hold(): void;
}

/**
 * A stored conversation as one short row: its name, then when it was last active, how big it is and how many
 * archives it has, and a badge while a turn runs. Start over, Delete and the transcript are in the row's menu;
 * while the page is selecting the row is a checkbox instead.
 */
export function StoredRow(props: {
	conversation: ConversationView;
	schedules?: number;
	now: number;
	pick: StoredPick;
	refresh(): void;
}) {
	const c = props.conversation;
	const { pick } = props;
	const { timeZone, panes, cleanup } = useConfig();
	const [action, setAction] = useState<CleanupAction>();
	const { title, detail } = storedTitle(c);
	const press = useLongPress((request: PressRequest) => {
		if (request.via === "hold") pick.hold();
	});
	const facts = [
		lastActive(c.lastActive, props.now, timeZone),
		c.liveBytes > 0 ? size(c.liveBytes) : t("No live conversation"),
		plural(c.archives, "{count} archive", "{count} archives"),
		...(props.schedules ? [`${t("Schedules")} ${props.schedules}`] : []),
	].join(" · ");
	const main = (
		<span className="stored-main">
			<strong className="stored-title" title={detail}>
				{c.channel && c.channel.kind !== "gone" && !pick.selecting ? (
					<a
						href={discordUrl(
							c.id,
							c.channel.kind === "guild" ? c.channel.guildId : undefined,
						)}
						target="_blank"
						rel="noreferrer"
					>
						{title}
					</a>
				) : (
					title
				)}
			</strong>
			<span className="meta">{facts}</span>
		</span>
	);
	if (pick.selecting)
		return (
			<li className="stored-row" data-chosen={pick.chosen ? "" : undefined}>
				<label className="select-row">
					<SelectBox
						label={title}
						checked={pick.chosen}
						onChange={pick.toggle}
					/>
					{main}
					{c.busy > 0 ? <Badge tone="busy">{t("Working")}</Badge> : null}
				</label>
			</li>
		);
	return (
		<li className="stored-row" {...press}>
			{main}
			{c.busy > 0 ? <Badge tone="busy">{t("Working")}</Badge> : null}
			<button
				type="button"
				className="icon-button row-more"
				aria-haspopup="menu"
				aria-label={t("More")}
				onClick={(event) => {
					const box = event.currentTarget.getBoundingClientRect();
					openMenu({
						title,
						items: [
							...(cleanup
								? [
										{
											id: "start-over",
											label: t("Start over"),
											icon: "refresh" as const,
											run: () => setAction("start-over"),
										},
										{
											id: "delete",
											label: t("Delete"),
											icon: "trash" as const,
											tone: "danger" as const,
											run: () => setAction("delete"),
										},
									]
								: []),
							...(panes.includes("conversations")
								? [
										{
											id: "transcript",
											label: t("Transcript"),
											icon: "notes" as const,
											run: () => navigate("conversations", c.key),
										},
									]
								: []),
						],
						at: { x: box.left, y: box.bottom },
						via: "key",
						source: event.currentTarget,
					});
				}}
			>
				<Icon name="more" size={18} />
			</button>
			<CleanupDialog
				channel={c.key}
				title={title}
				busy={c.busy > 0}
				action={action}
				onClose={() => setAction(undefined)}
				refresh={props.refresh}
			/>
		</li>
	);
}
