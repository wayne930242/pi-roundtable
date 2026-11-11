// The parts the knight sheet's Webhooks section and the Webhooks page share: a webhook's row, the
// form that makes one, the dialog that shows its URL once, and the confirm that revokes it.

import { type SyntheticEvent, useId, useState } from "react";
import type {
	CreatedWebhookView,
	WebhookView,
} from "../../src/webhooks/types.ts";
import { messageOf } from "../lib/api.ts";
import { useConfig } from "../lib/config.ts";
import { when } from "../lib/format.ts";
import { translate as t } from "../lib/messages.ts";
import { toast } from "../lib/toast.ts";
import { webhooksApi } from "../lib/webhooks-api.ts";
import { Confirm } from "./confirm.tsx";
import { Select, TextField } from "./fields.tsx";
import { SecretUrlDialog } from "./secret-url-dialog.tsx";
import { Badge, Failure } from "./states.tsx";

/** One webhook: who made it, its use and its expiry, never its URL. */
export function WebhookRow(props: { hook: WebhookView; onRevoke(): void }) {
	const { hook } = props;
	const { timeZone } = useConfig();
	return (
		<li className="grant" data-webhook={hook.id}>
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

/** Makes a webhook of the knight's room: a name and an optional expiry. */
export function WebhookForm(props: {
	agent: string;
	onMade(made: CreatedWebhookView): void;
}) {
	const [name, setName] = useState("");
	const [expiry, setExpiry] = useState("");
	const [failure, setFailure] = useState<string>();
	const [busy, setBusy] = useState(false);
	const nameId = useId();
	const expiryId = useId();
	const create = async (event: SyntheticEvent) => {
		event.preventDefault();
		setBusy(true);
		setFailure(undefined);
		try {
			const made = await webhooksApi.create(props.agent, {
				name: name.trim(),
				...(expiry ? { expiresInMinutes: Number(expiry) } : {}),
			});
			setName("");
			props.onMade(made);
		} catch (refused) {
			setFailure(messageOf(refused));
		} finally {
			setBusy(false);
		}
	};
	return (
		<form className="stack" onSubmit={create}>
			<label htmlFor={nameId}>
				{t("Webhook name")}
				<TextField
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
	);
}

/** A new webhook's URL, shown this once. */
export function WebhookUrlDialog(props: {
	shown: { name: string; url: string } | undefined;
	onClose(): void;
}) {
	const { shown } = props;
	return (
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
			onClose={props.onClose}
		/>
	);
}

/** Asks before revoking a knight's webhook; `hook` open asks. */
export function RevokeWebhook(props: {
	agent: string;
	hook: WebhookView | undefined;
	onClose(): void;
	onRevoked(): void;
}) {
	const { hook } = props;
	return (
		<Confirm
			open={hook !== undefined}
			title={t("Revoke the webhook")}
			confirmLabel={t("Revoke")}
			tone="danger"
			onClose={props.onClose}
			onConfirm={async () => {
				if (!hook) return;
				await webhooksApi.revoke(props.agent, hook.id);
				toast(t("Revoked."));
				props.onRevoked();
			}}
		>
			<p>
				{t("Revoke {name}? Its URL stops working at once.", {
					name: hook?.name ?? "",
				})}
			</p>
		</Confirm>
	);
}
