import type { Chip } from "../lib/chats-home.ts";
import { translate as t } from "../lib/messages.ts";

/**
 * The folders as chips above the list. A chip is 32px tall inside a 44px hit area, and a dot on a
 * folder's chip says one of its rooms has something unread.
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
				const lit =
					chip.kind !== "all" &&
					chip.rooms.some((key) => (props.unread[key] ?? 0) > 0);
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
						<span className="chip-face">
							{label}
							{lit ? (
								<i
									className="chip-dot"
									role="img"
									aria-label={t("Unread messages")}
								/>
							) : null}
						</span>
					</button>
				);
			})}
		</fieldset>
	);
}
