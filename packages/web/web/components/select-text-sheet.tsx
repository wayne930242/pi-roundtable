import { useState } from "react";
import { installStyle } from "../lib/lazy-style.ts";
import { copyText } from "../lib/menu-items.ts";
import { closeSelectText, useSelectText } from "../lib/message-sheets.ts";
import { translate as t } from "../lib/messages.ts";
import { BareTextArea } from "./bare-fields.tsx";
import { Sheet } from "./sheet.tsx";

// The text is a read-only field, which keeps its own selection: scrolling it, or the page changing
// behind the sheet, does not clear what the platform's long press and handles picked. The sheet's
// title and buttons take none of it.
const SELECT_TEXT_CSS = `
.sheet:has(.select-text) {
	-webkit-user-select: none;
	user-select: none;
}

.select-text {
	flex: 1;
	box-sizing: border-box;
	width: 100%;
	min-height: 12rem;
	margin: 0;
	padding: var(--space-3);
	resize: none;
	overflow-wrap: anywhere;
	white-space: pre-wrap;
	border: 1px solid var(--border);
	border-radius: var(--radius-md);
	background: var(--surface-2);
	color: inherit;
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
			<BareTextArea
				className="select-text"
				readOnly
				value={shown.text}
				aria-label={shown.author}
			/>
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
