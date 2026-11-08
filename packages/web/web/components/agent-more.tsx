import type { AgentProfileView } from "../../src/api-types.ts";
import { closeAgentSheet } from "../lib/agent-sheet.ts";
import { translate as t } from "../lib/messages.ts";
import { askRoomConfirm } from "../lib/room-confirm.ts";
import { AgentWebhooks } from "./agent-webhooks.tsx";

/** The sheet's More tab: the prompt's history, a permanent knight's webhooks, and archiving the knight (not the coordinator). */
export function AgentMore(props: {
	profile: AgentProfileView;
	coordinator: boolean;
	onHistory(): void;
}) {
	const { profile } = props;
	return (
		<>
			<ul className="menu">
				<li>
					<button type="button" className="menu-item" onClick={props.onHistory}>
						<span className="menu-text">
							<strong>{t("History of the prompt")}</strong>
						</span>
					</button>
				</li>
			</ul>
			{profile.helper ? null : <AgentWebhooks agent={profile.name} />}
			{props.coordinator ? null : (
				<section className="card stack">
					<h3>{t("Archive")}</h3>
					<p className="meta">
						{t(
							"An archived knight stops answering and its schedules are cancelled. Its history is kept, and you can restore it from Archived.",
						)}
					</p>
					<div className="actions">
						<button
							type="button"
							className="danger"
							onClick={() => {
								closeAgentSheet();
								askRoomConfirm({
									kind: "archive",
									room: profile.room,
									name: profile.displayName,
								});
							}}
						>
							{t("Archive {name}", { name: profile.displayName })}
						</button>
					</div>
				</section>
			)}
		</>
	);
}
