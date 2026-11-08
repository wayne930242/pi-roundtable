import { useId, useState } from "react";
import type { WebhookView } from "../../src/webhooks/types.ts";
import { translate as t } from "../lib/messages.ts";
import { useReloadable } from "../lib/use-reloadable.ts";
import { webhooksApi } from "../lib/webhooks-api.ts";
import { Empty, Failure, Loading } from "./states.tsx";
import {
	RevokeWebhook,
	WebhookForm,
	WebhookRow,
	WebhookUrlDialog,
} from "./webhook-parts.tsx";

/** The More tab's webhooks of a permanent knight: what posts into its room from outside, and how to make one. */
export function AgentWebhooks(props: { agent: string }) {
	const { agent } = props;
	const { data, error, reload } = useReloadable(() => webhooksApi.list(agent));
	const [shown, setShown] = useState<{ name: string; url: string }>();
	const [revoking, setRevoking] = useState<WebhookView>();
	const titleId = useId();
	return (
		<section className="card stack" aria-labelledby={titleId}>
			<h3 id={titleId}>{t("Webhooks")}</h3>
			<p className="meta">
				{t(
					"A JSON POST to a webhook's URL shows in this room and starts a report turn, as a Discord webhook does. What it posts is untrusted input.",
				)}
			</p>
			{error ? <Failure message={error} /> : null}
			{data === undefined && !error ? <Loading /> : null}
			{data?.length === 0 ? <Empty>{t("No webhooks yet.")}</Empty> : null}
			{data?.length ? (
				<ul className="grants">
					{data.map((hook) => (
						<WebhookRow
							key={hook.id}
							hook={hook}
							onRevoke={() => setRevoking(hook)}
						/>
					))}
				</ul>
			) : null}
			<WebhookForm
				agent={agent}
				onMade={(made) => {
					setShown({ name: made.webhook.name, url: made.url });
					reload();
				}}
			/>
			<WebhookUrlDialog shown={shown} onClose={() => setShown(undefined)} />
			<RevokeWebhook
				agent={agent}
				hook={revoking}
				onClose={() => setRevoking(undefined)}
				onRevoked={reload}
			/>
		</section>
	);
}
