import { useState } from "react";
import { installStyle } from "../lib/lazy-style.ts";
import { copyText } from "../lib/menu-items.ts";
import { closeSelectText, useSelectText } from "../lib/message-sheets.ts";
import { translate as t } from "../lib/messages.ts";
import { Sheet } from "./sheet.tsx";

// Only the text is selectable in the sheet, so a selection made with the platform's own long press
// and handles stays inside it; the sheet's title and buttons take none of it.
const SELECT_TEXT_CSS = `
.sheet:has(.select-text) {
	-webkit-user-select: none;
	user-select: none;
}

.select-text {
	flex: 1;
	margin: 0;
	padding: var(--space-3);
	overflow-wrap: anywhere;
	white-space: pre-wrap;
	border: 1px solid var(--border);
	border-radius: var(--radius-md);
	background: var(--surface-2);
	font: inherit;
	line-height: 1.6;
	-webkit-touch-callout: default;
	-webkit-user-select: text;
	user-select: text;
}

.select-text-actions {
	display: flex;
	justify-content: flex-end;
	gap: var(--space-2);
	margin-top: var(--space-3);
}
`;

/** A message's text alone in a sheet, as it was written, to select any part of and copy. */
export function SelectTextSheetHost() {
	const ask = useSelectText();
	const [shown, setShown] = useState(ask);
	if (ask && ask !== shown) setShown(ask);
	if (!shown) return null;
	installStyle("select-text", SELECT_TEXT_CSS);
	return (
		<Sheet
			open={ask !== undefined}
			title={t("Select text")}
			size="full"
			onClose={closeSelectText}
		>
			<p className="hint">{shown.author}</p>
			<pre className="select-text">{shown.text}</pre>
			<div className="select-text-actions">
				<button type="button" className="secondary" onClick={closeSelectText}>
					{t("Close")}
				</button>
				<button type="button" onClick={() => copyText(shown.text)}>
					{t("Copy all")}
				</button>
			</div>
		</Sheet>
	);
}
