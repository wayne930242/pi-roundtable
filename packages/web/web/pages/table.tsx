import { useState } from "react";
import { RoundTable } from "../components/round-table.tsx";
import { translate as t } from "../lib/messages.ts";
import type { TableHandle } from "../table/entry.ts";

/** Every agent of the room list at the round table, each in the state its room is in; a seat opens its room. */
export function TablePage() {
	const [table, setTable] = useState<TableHandle>();
	return (
		<div className="table-page">
			<header className="page-head">
				<h1>{t("Round table")}</h1>
				{table?.kind === "webgl" ? (
					<button
						type="button"
						className="secondary"
						onClick={() => table.resetCamera()}
					>
						{t("Reset view")}
					</button>
				) : null}
			</header>
			<div className="table-frame">
				<RoundTable onHandle={setTable} />
			</div>
		</div>
	);
}
