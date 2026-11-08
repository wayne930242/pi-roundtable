import { useState } from "react";
import type { WebhookOverviewView } from "../../src/webhooks/types.ts";
import { PageCharacter } from "../components/character.tsx";
import { Dialog } from "../components/dialog.tsx";
import { Icon } from "../components/icons.tsx";
import { PickKnight } from "../components/preset-parts.tsx";
import { SearchField } from "../components/search-field.tsx";
import { Empty, Failure, Loading } from "../components/states.tsx";
import {
	RevokeWebhook,
	WebhookForm,
	WebhookRow,
	WebhookUrlDialog,
} from "../components/webhook-parts.tsx";
import { openAgentSheet } from "../lib/agent-sheet.ts";
import { useCharacters } from "../lib/characters.ts";
import { installStyle } from "../lib/lazy-style.ts";
import { translate as t } from "../lib/messages.ts";
import { useFetched } from "../lib/use-fetched.ts";
import { webhooksApi } from "../lib/webhooks-api.ts";

/** The search field shows once the list is longer than this. */
const SEARCH_AFTER = 5;

const WEBHOOKS_CSS = `
.webhook-owner {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	padding: 0;
	border: 0;
	background: none;
	color: inherit;
	font: inherit;
	cursor: pointer;
	text-align: start;
}
.webhook-owner:hover:not(:disabled) {
	background: none;
	text-decoration: underline;
	text-decoration-color: var(--muted);
	text-underline-offset: 0.2em;
}
`;

/**
 * Every knight's incoming webhooks, grouped by the knight they post into. A row and the form are
 * the same as the knight's own sheet shows; the knight's name opens that sheet on its More tab.
 */
export default function WebhooksPage() {
	installStyle("webhooks-page", WEBHOOKS_CSS);
	const [version, setVersion] = useState(0);
	const [query, setQuery] = useState("");
	const [choosing, setChoosing] = useState(false);
	const [making, setMaking] = useState<string>();
	const [shown, setShown] = useState<{ name: string; url: string }>();
	const [revoking, setRevoking] = useState<WebhookOverviewView>();
	const characters = useCharacters();
	const { data, error } = useFetched(
		() => webhooksApi.all(),
		`webhooks:${version}`,
	);
	const reload = () => setVersion((n) => n + 1);
	const words = query.trim().toLowerCase();
	const hooks = data ?? [];
	const shownHooks = hooks.filter(
		(hook) =>
			!words ||
			[hook.name, hook.agentDisplayName, hook.agent].some((text) =>
				text.toLowerCase().includes(words),
			),
	);
	const groups = [...new Set(shownHooks.map((hook) => hook.agent))];
	return (
		<section className="page stack" data-webhooks-page="">
			<div className="card-head">
				<h2>{t("Webhooks")}</h2>
				<button
					type="button"
					className="secondary"
					onClick={() => setChoosing(true)}
				>
					<Icon name="plus" size={16} />
					{t("New webhook")}
				</button>
			</div>
			{error ? <Failure message={error} /> : null}
			{!data && !error ? <Loading /> : null}
			{data?.length === 0 ? (
				<Empty>
					{t(
						"No webhooks yet. A webhook is a URL another service, such as CI, posts to, and what it posts shows in a knight's room.",
					)}
				</Empty>
			) : null}
			{hooks.length > SEARCH_AFTER ? (
				<SearchField
					label={t("Search {name}", { name: t("Webhooks") })}
					value={query}
					onChange={setQuery}
				/>
			) : null}
			{groups.map((agent) => {
				const own = shownHooks.filter((hook) => hook.agent === agent);
				const displayName = own[0]?.agentDisplayName ?? agent;
				return (
					<article key={agent} className="card stack" data-owner={agent}>
						<button
							type="button"
							className="webhook-owner"
							onClick={() => openAgentSheet(agent, { tab: "more" })}
						>
							<PageCharacter
								spec={characters[agent]}
								name={agent}
								size={32}
								live={false}
							/>
							<strong>{displayName}</strong>
						</button>
						<ul className="grants">
							{own.map((hook) => (
								<WebhookRow
									key={hook.id}
									hook={hook}
									onRevoke={() => setRevoking(hook)}
								/>
							))}
						</ul>
					</article>
				);
			})}
			<PickKnight
				open={choosing}
				title={t("Which knight it belongs to")}
				confirmLabel={t("Continue")}
				onClose={() => setChoosing(false)}
				onPick={async (agent) => setMaking(agent)}
			/>
			<Dialog
				open={making !== undefined}
				title={t("New webhook")}
				onClose={() => setMaking(undefined)}
			>
				{making ? (
					<WebhookForm
						key={making}
						agent={making}
						onMade={(made) => {
							setMaking(undefined);
							setShown({ name: made.webhook.name, url: made.url });
							reload();
						}}
					/>
				) : null}
			</Dialog>
			<WebhookUrlDialog shown={shown} onClose={() => setShown(undefined)} />
			<RevokeWebhook
				agent={revoking?.agent ?? ""}
				hook={revoking}
				onClose={() => setRevoking(undefined)}
				onRevoked={reload}
			/>
		</section>
	);
}
