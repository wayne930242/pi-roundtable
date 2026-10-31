import { type SyntheticEvent, useEffect, useState } from "react";
import type {
	McpChannelView,
	McpGrantsView,
	McpGrantView,
} from "../../src/api-types.ts";
import { messageOf } from "../lib/api.ts";
import { useConfig } from "../lib/config.ts";
import { connectorsApi } from "../lib/connectors-api.ts";
import { when } from "../lib/format.ts";
import { translate as t } from "../lib/messages.ts";
import { toast } from "../lib/toast.ts";
import { useReloadable } from "../lib/use-reloadable.ts";
import { Confirm } from "./confirm.tsx";
import { Dialog } from "./dialog.tsx";
import { Select } from "./select.tsx";
import { Badge, Empty, Failure, Loading } from "./states.tsx";

type Operations = McpGrantsView["operations"];
type Target = { bundle: string; grant: McpGrantView };
/** A new bundle is picked by this value, which no bundle name can be: names are trimmed. */
const NEW_BUNDLE = " new";

const labelsOf = (ids: readonly string[], operations: Operations) =>
	ids.map((id) => operations.find((o) => o.id === id)?.label ?? id).join(", ");

/** A bundle URL, shown this once with a copy button. */
function UrlDialog(props: {
	shown?: { bundle: string; url: string };
	onClose(): void;
}) {
	return (
		<Dialog
			open={props.shown !== undefined}
			title={t("MCP URL of {bundle}", { bundle: props.shown?.bundle ?? "" })}
			onClose={props.onClose}
		>
			<div className="stack">
				<p>
					{t(
						"This URL is the access credential and is shown only this once. Add a remote MCP server in the AI client and paste it; no separate token is needed.",
					)}
				</p>
				<input
					readOnly
					aria-label={t("MCP URL")}
					className="mcp-url"
					value={props.shown?.url ?? ""}
					onFocus={(e) => e.target.select()}
				/>
				<div className="actions">
					<button
						type="button"
						className="secondary"
						onClick={() => {
							void navigator.clipboard
								?.writeText(props.shown?.url ?? "")
								.then(() => toast(t("Copied")));
						}}
					>
						{t("Copy")}
					</button>
					<button type="button" onClick={props.onClose}>
						{t("Done")}
					</button>
				</div>
			</div>
		</Dialog>
	);
}

function OperationChoice(props: {
	operations: Operations;
	chosen: string[];
	onChange(next: string[]): void;
}) {
	return (
		<fieldset className="field">
			<legend>{t("Allowed operations")}</legend>
			<ul className="menu">
				{props.operations.map((op) => {
					const on = props.chosen.includes(op.id);
					return (
						<li key={op.id}>
							<label className="menu-item menu-toggle">
								<input
									type="checkbox"
									checked={on}
									onChange={() =>
										props.onChange(
											on
												? props.chosen.filter((id) => id !== op.id)
												: [...props.chosen, op.id],
										)
									}
								/>
								<span className="menu-text">
									<strong>{op.label}</strong>
								</span>
							</label>
						</li>
					);
				})}
			</ul>
		</fieldset>
	);
}

function AuthorizeForm(props: {
	view: McpGrantsView;
	onDone(url?: { bundle: string; url: string }): void;
	onCancel(): void;
}) {
	const { view } = props;
	const [channels, setChannels] = useState<McpChannelView[]>();
	const [bundle, setBundle] = useState(view.bundles[0]?.name ?? NEW_BUNDLE);
	const [newName, setNewName] = useState("");
	const [channelId, setChannelId] = useState("");
	const [operations, setOperations] = useState<string[]>([]);
	const [displayName, setDisplayName] = useState("");
	const [description, setDescription] = useState("");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		connectorsApi.channels().then(
			(list) => {
				setChannels(list);
				setChannelId((now) => now || list[0]?.id || "");
			},
			(failure) => setError(messageOf(failure)),
		);
	}, []);
	const submit = async (event: SyntheticEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(undefined);
		try {
			const done = await connectorsApi.authorize({
				bundle: bundle === NEW_BUNDLE ? newName : bundle,
				channelId,
				operations,
				...(displayName.trim() ? { displayName } : {}),
				...(description.trim() ? { description } : {}),
			});
			toast(t("Authorized the channel in {bundle}.", { bundle: done.bundle }));
			props.onDone(
				done.url ? { bundle: done.bundle, url: done.url } : undefined,
			);
		} catch (failure) {
			setError(messageOf(failure));
		} finally {
			setBusy(false);
		}
	};
	return (
		<form className="stack" onSubmit={submit}>
			<label htmlFor="mcp-bundle">
				{t("Bundle")}
				<Select
					id="mcp-bundle"
					value={bundle}
					onChange={(e) => setBundle(e.target.value)}
				>
					{view.bundles.map((b) => (
						<option key={b.name} value={b.name}>
							{b.name}
						</option>
					))}
					<option value={NEW_BUNDLE}>{t("New bundle…")}</option>
				</Select>
			</label>
			{bundle === NEW_BUNDLE ? (
				<label>
					{t("New bundle name")}
					<input
						value={newName}
						maxLength={80}
						required
						onChange={(e) => setNewName(e.target.value)}
					/>
					<span className="meta">
						{t("Channels in one bundle share one MCP URL.")}
					</span>
				</label>
			) : null}
			<label htmlFor="mcp-channel">
				{t("Channel")}
				{channels === undefined && !error ? (
					<Loading />
				) : (
					<Select
						id="mcp-channel"
						value={channelId}
						required
						onChange={(e) => setChannelId(e.target.value)}
					>
						{(channels ?? []).map((c) => (
							<option key={c.id} value={c.id}>
								{`${c.guild} › #${c.name}`}
							</option>
						))}
					</Select>
				)}
			</label>
			<OperationChoice
				operations={view.operations}
				chosen={operations}
				onChange={setOperations}
			/>
			<label>
				{t("Name outside AI clients see (optional)")}
				<input
					value={displayName}
					maxLength={100}
					onChange={(e) => setDisplayName(e.target.value)}
				/>
			</label>
			<label>
				{t("Purpose (optional)")}
				<textarea
					value={description}
					maxLength={1000}
					rows={2}
					onChange={(e) => setDescription(e.target.value)}
				/>
			</label>
			{error ? <Failure message={error} /> : null}
			<div className="actions">
				<button
					type="button"
					className="secondary"
					disabled={busy}
					onClick={props.onCancel}
				>
					{t("Cancel")}
				</button>
				<button
					type="submit"
					disabled={busy || !channelId || operations.length === 0}
				>
					{t("Authorize")}
				</button>
			</div>
		</form>
	);
}

function DescribeForm(props: {
	target: Target;
	onDone(): void;
	onCancel(): void;
}) {
	const { bundle, grant } = props.target;
	const [displayName, setDisplayName] = useState(grant.displayName);
	const [description, setDescription] = useState(grant.description);
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const submit = async (event: SyntheticEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(undefined);
		try {
			await connectorsApi.describeGrant(bundle, grant.channelId, {
				displayName,
				description,
			});
			toast(t("Updated what outside AI clients see."));
			props.onDone();
		} catch (failure) {
			setError(messageOf(failure));
		} finally {
			setBusy(false);
		}
	};
	return (
		<form className="stack" onSubmit={submit}>
			<label>
				{t("Name outside AI clients see")}
				<input
					value={displayName}
					maxLength={100}
					required
					onChange={(e) => setDisplayName(e.target.value)}
				/>
			</label>
			<label>
				{t("Purpose")}
				<textarea
					value={description}
					maxLength={1000}
					rows={3}
					onChange={(e) => setDescription(e.target.value)}
				/>
				<span className="meta">
					{t("The channel's name and topic on Discord stay as they are.")}
				</span>
			</label>
			{error ? <Failure message={error} /> : null}
			<div className="actions">
				<button
					type="button"
					className="secondary"
					disabled={busy}
					onClick={props.onCancel}
				>
					{t("Cancel")}
				</button>
				<button type="submit" disabled={busy}>
					{t("Save")}
				</button>
			</div>
		</form>
	);
}

function GrantRow(props: {
	bundle: string;
	grant: McpGrantView;
	operations: Operations;
	onDescribe(): void;
	onRevoke(): void;
}) {
	const { grant } = props;
	const { timeZone } = useConfig();
	return (
		<li className="grant">
			<div className="card-head">
				<strong>{grant.displayName}</strong>
				{grant.visible ? null : (
					<Badge tone="warn">{t("Not visible now")}</Badge>
				)}
			</div>
			<p className="meta">{`${grant.guildName} › #${grant.channelName}`}</p>
			<p>{grant.description || t("No purpose set.")}</p>
			<p className="meta">
				{t("Allowed: {operations}", {
					operations: labelsOf(grant.operations, props.operations),
				})}
			</p>
			{grant.audit.length ? (
				<details>
					<summary>{t("Recent activity")}</summary>
					<ul className="audit">
						{grant.audit.map((a) => (
							<li key={`${a.at}-${a.tool}`}>
								<time dateTime={a.at}>{when(a.at, timeZone)}</time>{" "}
								<code>{a.tool}</code> {a.status}
							</li>
						))}
					</ul>
				</details>
			) : null}
			<div className="actions">
				<button type="button" className="secondary" onClick={props.onDescribe}>
					{t("Rename / purpose")}
				</button>
				<button type="button" className="danger" onClick={props.onRevoke}>
					{t("Revoke")}
				</button>
			</div>
		</li>
	);
}

/** Which channels outside AI clients may use through each bundle's MCP URL, managed as `/<root> mcp` does. */
export function McpGrants() {
	const { data, error, reload } = useReloadable(() => connectorsApi.grants());
	const [authorizing, setAuthorizing] = useState(false);
	const [describing, setDescribing] = useState<Target>();
	const [revoking, setRevoking] = useState<Target>();
	const [rotating, setRotating] = useState<string>();
	const [shownUrl, setShownUrl] = useState<{ bundle: string; url: string }>();
	return (
		<section className="stack" aria-labelledby="mcp-grants">
			<div className="card-head">
				<div>
					<h3 id="mcp-grants">{t("MCP authorizations")}</h3>
					<p className="hint">
						{t(
							"Which channels outside AI clients may use through each bundle's MCP URL, and with which operations.",
						)}
					</p>
				</div>
				<button
					type="button"
					disabled={!data}
					onClick={() => setAuthorizing(true)}
				>
					{t("Authorize a channel")}
				</button>
			</div>
			{error ? <Failure message={error} /> : null}
			{!data && !error ? <Loading /> : null}
			{data?.bundles.length === 0 ? (
				<Empty>{t("There are no authorizations yet.")}</Empty>
			) : null}
			{data?.bundles.map((b) => (
				<article key={b.name} className="card bundle-card">
					<div className="card-head">
						<strong>{b.name}</strong>
						<button
							type="button"
							className="secondary"
							onClick={() => setRotating(b.name)}
						>
							{t("New URL")}
						</button>
					</div>
					{b.grants.length === 0 ? <Empty>{t("No channels")}</Empty> : null}
					<ul className="grants">
						{b.grants.map((g) => (
							<GrantRow
								key={g.channelId}
								bundle={b.name}
								grant={g}
								operations={data.operations}
								onDescribe={() => setDescribing({ bundle: b.name, grant: g })}
								onRevoke={() => setRevoking({ bundle: b.name, grant: g })}
							/>
						))}
					</ul>
				</article>
			))}
			<Dialog
				open={authorizing}
				title={t("Authorize a channel")}
				onClose={() => setAuthorizing(false)}
			>
				{authorizing && data ? (
					<AuthorizeForm
						view={data}
						onCancel={() => setAuthorizing(false)}
						onDone={(url) => {
							setAuthorizing(false);
							if (url) setShownUrl(url);
							reload();
						}}
					/>
				) : null}
			</Dialog>
			<Dialog
				open={describing !== undefined}
				title={t("What outside AI clients see")}
				onClose={() => setDescribing(undefined)}
			>
				{describing ? (
					<DescribeForm
						key={`${describing.bundle}/${describing.grant.channelId}`}
						target={describing}
						onCancel={() => setDescribing(undefined)}
						onDone={() => {
							setDescribing(undefined);
							reload();
						}}
					/>
				) : null}
			</Dialog>
			<Confirm
				open={revoking !== undefined}
				title={t("Revoke the channel")}
				confirmLabel={t("Revoke")}
				tone="danger"
				onClose={() => setRevoking(undefined)}
				onConfirm={async () => {
					if (!revoking) return;
					await connectorsApi.revoke(revoking.bundle, revoking.grant.channelId);
					toast(t("Revoked."));
					reload();
				}}
			>
				<p>
					{t(
						"Remove {channel} from bundle {bundle}? Its other channels and its URL keep working; operations already sent are not undone.",
						{
							channel: revoking?.grant.displayName ?? "",
							bundle: revoking?.bundle ?? "",
						},
					)}
				</p>
			</Confirm>
			<Confirm
				open={rotating !== undefined}
				title={t("Replace the MCP URL")}
				confirmLabel={t("Replace URL")}
				tone="danger"
				onClose={() => setRotating(undefined)}
				onConfirm={async () => {
					if (!rotating) return;
					const { bundle, url } = await connectorsApi.rotate(rotating);
					if (url) setShownUrl({ bundle, url });
					reload();
				}}
			>
				<p>
					{t(
						"Replace the URL of bundle {bundle}? The old URL stops working at once; every channel setting stays.",
						{ bundle: rotating ?? "" },
					)}
				</p>
			</Confirm>
			<UrlDialog
				{...(shownUrl ? { shown: shownUrl } : {})}
				onClose={() => setShownUrl(undefined)}
			/>
		</section>
	);
}
