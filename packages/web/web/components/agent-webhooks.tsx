import { type SyntheticEvent, useId, useState } from "react";
import type { WebhookView } from "../../src/webhooks/types.ts";
import { messageOf } from "../lib/api.ts";
import { useConfig } from "../lib/config.ts";
import { when } from "../lib/format.ts";
import { translate as t } from "../lib/messages.ts";
import { toast } from "../lib/toast.ts";
import { useReloadable } from "../lib/use-reloadable.ts";
import { webhooksApi } from "../lib/webhooks-api.ts";
import { Confirm } from "./confirm.tsx";
import { SecretUrlDialog } from "./secret-url-dialog.tsx";
import { Select } from "./select.tsx";
import { Badge, Empty, Failure, Loading } from "./states.tsx";

function WebhookRow(props: { hook: WebhookView; onRevoke(): void }) {
	const { hook } = props;
	const { timeZone } = useConfig();
	return (
		<li className="grant">
			<div className="card-head">
				<strong>{hook.name}</strong>
				{hook.once ? <Badge>{t("One post")}</Badge> : null}
			</div>
			<p className="meta">
				{hook.createdBy === "owner"
					? t("Made by an owner")
					: t("Made by the knight")}
				{" · "}
				{t("Created {at}", { at: when(hook.created, timeZone) })}
				{" · "}
				{hook.lastUsed
					? t("Last used {at}", { at: when(hook.lastUsed, timeZone) })
					: t("Never used")}
				{" · "}
				{hook.expiresAt
					? t("Expires {at}", { at: when(hook.expiresAt, timeZone) })
					: t("Never expires")}
			</p>
			<div className="actions">
				<button type="button" className="danger" onClick={props.onRevoke}>
					{t("Revoke")}
				</button>
			</div>
		</li>
	);
}

/** The More tab's webhooks of a permanent knight: what posts into its room from outside, and how to make one. */
export function AgentWebhooks(props: { agent: string }) {
	const { agent } = props;
	const { data, error, reload } = useReloadable(() => webhooksApi.list(agent));
	const [name, setName] = useState("");
	const [expiry, setExpiry] = useState("");
	const [failure, setFailure] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [shown, setShown] = useState<{ name: string; url: string }>();
	const [revoking, setRevoking] = useState<WebhookView>();
	const nameId = useId();
	const expiryId = useId();
	const create = async (event: SyntheticEvent) => {
		event.preventDefault();
		setBusy(true);
		setFailure(undefined);
		try {
			const made = await webhooksApi.create(agent, {
				name: name.trim(),
				...(expiry ? { expiresInMinutes: Number(expiry) } : {}),
			});
			setShown({ name: made.webhook.name, url: made.url });
			setName("");
			reload();
		} catch (refused) {
			setFailure(messageOf(refused));
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="card stack" aria-labelledby={`${nameId}-title`}>
			<h3 id={`${nameId}-title`}>{t("Webhooks")}</h3>
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
			<form className="stack" onSubmit={create}>
				<label htmlFor={nameId}>
					{t("Webhook name")}
					<input
						id={nameId}
						value={name}
						maxLength={80}
						required
						autoComplete="off"
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				<label htmlFor={expiryId}>
					{t("Expires")}
					<Select
						id={expiryId}
						value={expiry}
						onChange={(event) => setExpiry(event.target.value)}
					>
						<option value="">{t("Never")}</option>
						<option value="60">{t("1 hour")}</option>
						<option value="1440">{t("1 day")}</option>
						<option value="10080">{t("7 days")}</option>
					</Select>
				</label>
				{failure ? <Failure message={failure} /> : null}
				<div className="actions">
					<button type="submit" disabled={busy || !name.trim()}>
						{t("Make a webhook")}
					</button>
				</div>
			</form>
			<SecretUrlDialog
				{...(shown
					? {
							shown: {
								title: t("Webhook URL of {name}", { name: shown.name }),
								note: t(
									"This URL is shown only this once, and anyone who has it can post into this room. Keep it in a secret store, such as a GitHub secret, never in a repository or a message.",
								),
								label: t("Webhook URL"),
								url: shown.url,
							},
						}
					: {})}
				onClose={() => setShown(undefined)}
			/>
			<Confirm
				open={revoking !== undefined}
				title={t("Revoke the webhook")}
				confirmLabel={t("Revoke")}
				tone="danger"
				onClose={() => setRevoking(undefined)}
				onConfirm={async () => {
					if (!revoking) return;
					await webhooksApi.revoke(agent, revoking.id);
					toast(t("Revoked."));
					reload();
				}}
			>
				<p>
					{t("Revoke {name}? Its URL stops working at once.", {
						name: revoking?.name ?? "",
					})}
				</p>
			</Confirm>
		</section>
	);
}
