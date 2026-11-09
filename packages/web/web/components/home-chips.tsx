import { type Chip, chipUnread } from "../lib/chats-home.ts";
import { plural, translate as t } from "../lib/messages.ts";

/**
 * The folders as tabs above the list: a real button 48px tall with its name and, when a room of it
 * has something unread, the count of those messages. Every tab has the one look: the surface with a
 * one-pixel border, and the theme's accent when chosen.
 */
export function HomeChips(props: {
	chips: readonly Chip[];
	chosen: string;
	unread: Readonly<Record<string, number>>;
	onChoose(id: string): void;
}) {
	return (
		<fieldset className="chips">
			<legend className="visually-hidden">{t("Folders")}</legend>
			{props.chips.map((chip) => {
				const count = chip.kind === "all" ? 0 : chipUnread(chip, props.unread);
				const label =
					chip.kind === "all"
						? t("All")
						: chip.kind === "other"
							? t("Other")
							: (chip.name ?? "");
				return (
					<button
						key={chip.id}
						type="button"
						className="chip"
						aria-pressed={chip.id === props.chosen}
						onClick={() => props.onChoose(chip.id)}
					>
						<span className="chip-label">{label}</span>
						{count > 0 ? (
							<span
								className="chip-count"
								role="img"
								aria-label={plural(
									count,
									"{count} unread message",
									"{count} unread messages",
								)}
							>
								{count > 99 ? "99+" : count}
							</span>
						) : null}
					</button>
				);
			})}
		</fieldset>
	);
}
