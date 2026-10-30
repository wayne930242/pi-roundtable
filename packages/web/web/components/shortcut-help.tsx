import { installStyle } from "../lib/lazy-style.ts";
import { translate as t } from "../lib/messages.ts";
import { appleKeys, closeShortcutHelp } from "../lib/shortcut-help.ts";
import { Sheet } from "./sheet.tsx";

const SHORTCUT_CSS = `
.shortcut-list {
	display: grid;
	grid-template-columns: max-content minmax(0, 1fr);
	align-items: center;
	gap: var(--space-3) var(--space-4);
	margin: 0;
}

.shortcut-list dt {
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-1);
}

.shortcut-list dd {
	margin: 0;
}

.shortcut-list kbd {
	display: inline-block;
	min-width: 1.6rem;
	text-align: center;
	font-size: var(--text-sm);
}
`;

/** The keys of one shortcut, and what it does. */
function rows(): { keys: string[]; label: string }[] {
	const apple = appleKeys();
	const alt = apple ? "⌥" : "Alt";
	const mod = apple ? "⌘" : "Ctrl";
	return [
		{ keys: [alt, "↑"], label: t("Previous room") },
		{ keys: [alt, "↓"], label: t("Next room") },
		{
			keys: [alt, "Shift", "↑"],
			label: t("Previous room with unread messages"),
		},
		{ keys: [alt, "Shift", "↓"], label: t("Next room with unread messages") },
		{ keys: [mod, "K"], label: t("Find a room") },
		{
			keys: ["Esc"],
			label: t("Close the open menu or sheet, or leave the message box"),
		},
		{ keys: ["?"], label: t("Show these shortcuts") },
	];
}

/** The sheet that lists the keyboard shortcuts; it loads when `?` first asks for it. */
export default function ShortcutHelp({ open }: { open: boolean }) {
	installStyle("shortcut-help", SHORTCUT_CSS);
	return (
		<Sheet
			open={open}
			title={t("Keyboard shortcuts")}
			onClose={closeShortcutHelp}
		>
			<div className="stack">
				<dl className="shortcut-list">
					{rows().map((row) => (
						<div key={row.label} style={{ display: "contents" }}>
							<dt>
								{row.keys.map((key) => (
									<kbd key={key}>{key}</kbd>
								))}
							</dt>
							<dd>{row.label}</dd>
						</div>
					))}
				</dl>
				<p className="meta">
					{t(
						"In a message box the arrow shortcuts switch rooms only when it is empty or the caret is at its very start (up) or very end (down).",
					)}
				</p>
			</div>
		</Sheet>
	);
}
