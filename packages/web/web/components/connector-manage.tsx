import { type SyntheticEvent, useState } from "react";
import type { ManagedConnectorView } from "../../src/api-types.ts";
import { messageOf } from "../lib/api.ts";
import { connectorsApi } from "../lib/connectors-api.ts";
import { translate as t } from "../lib/messages.ts";
import { toast } from "../lib/toast.ts";
import { useReloadable } from "../lib/use-reloadable.ts";
import { Confirm } from "./confirm.tsx";
import { Dialog } from "./dialog.tsx";
import { Badge, Empty, Failure, Loading } from "./states.tsx";

const EMPTY = { name: "", url: "", description: "", header: "", token: "" };

/** The add form. The token field is write-only: it is sent once and the form forgets it. */
function AddForm(props: { onDone(): void; onCancel(): void }) {
	const [fields, setFields] = useState(EMPTY);
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const set = (key: keyof typeof EMPTY) => (value: string) =>
		setFields((now) => ({ ...now, [key]: value }));
	const submit = async (event: SyntheticEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(undefined);
		try {
			const { connector, skipped } = await connectorsApi.add({
				name: fields.name,
				url: fields.url,
				description: fields.description,
				...(fields.header.trim() ? { header: fields.header } : {}),
				...(fields.token ? { token: fields.token } : {}),
			});
			setFields(EMPTY);
			toast(
				skipped.length
					? t(
							"Added {name}. Left out tools whose names are too long: {tools}",
							{ name: connector.name, tools: skipped.join(", ") },
						)
					: t("Added {name}.", { name: connector.name }),
			);
			props.onDone();
		} catch (failure) {
			setError(messageOf(failure));
		} finally {
			setBusy(false);
		}
	};
	return (
		<form className="stack" onSubmit={submit} autoComplete="off">
			<label>
				{t("Name")}
				<input
					value={fields.name}
					maxLength={12}
					placeholder="notion"
					required
					onChange={(e) => set("name")(e.target.value)}
				/>
				<span className="meta">
					{t(
						"Lowercase letters, digits and -, up to 12; it becomes the prefix of its tool names.",
					)}
				</span>
			</label>
			<label>
				{t("MCP URL")}
				<input
					type="url"
					value={fields.url}
					maxLength={500}
					placeholder="https://mcp.example.com/mcp"
					required
					onChange={(e) => set("url")(e.target.value)}
				/>
				<span className="meta">
					{t(
						"A Streamable HTTP endpoint; one ending in /sse uses SSE. A credential may be part of the URL.",
					)}
				</span>
			</label>
			<label>
				{t("Purpose")}
				<textarea
					value={fields.description}
					maxLength={1000}
					rows={3}
					required
					onChange={(e) => set("description")(e.target.value)}
				/>
				<span className="meta">
					{t("The knights decide from this text when to use the connector.")}
				</span>
			</label>
			<div className="form-row">
				<label>
					{t("Header name (optional)")}
					<input
						value={fields.header}
						maxLength={100}
						placeholder="X-API-Key"
						onChange={(e) => set("header")(e.target.value)}
					/>
					<span className="meta">
						{t("Leave empty to send Authorization: Bearer <token>.")}
					</span>
				</label>
				<label>
					{t("Token (optional)")}
					<input
						type="password"
						value={fields.token}
						maxLength={4000}
						autoComplete="new-password"
						onChange={(e) => set("token")(e.target.value)}
					/>
					<span className="meta">
						{t(
							"Stored encrypted by the gateway and never shown again; leave empty if the credential is in the URL.",
						)}
					</span>
				</label>
			</div>
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
					{t("Add connector")}
				</button>
			</div>
		</form>
	);
}

function PurposeForm(props: {
	connector: ManagedConnectorView;
	onDone(): void;
	onCancel(): void;
}) {
	const [text, setText] = useState(props.connector.description);
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const submit = async (event: SyntheticEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(undefined);
		try {
			await connectorsApi.describe(props.connector.name, text);
			toast(t("Purpose updated."));
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
				{t("Purpose")}
				<textarea
					value={text}
					maxLength={1000}
					rows={4}
					required
					onChange={(e) => setText(e.target.value)}
				/>
				<span className="meta">
					{t("From the next message on, the knights follow the new purpose.")}
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

/** The owner's connectors: list, add, change a purpose, remove. */
export function ConnectorManage() {
	const { data, error, reload } = useReloadable(() => connectorsApi.list());
	const [adding, setAdding] = useState(false);
	const [editing, setEditing] = useState<ManagedConnectorView>();
	const [removing, setRemoving] = useState<ManagedConnectorView>();
	return (
		<section className="stack" aria-labelledby="connectors-mine">
			<div className="card-head">
				<h3 id="connectors-mine">{t("MCP connectors")}</h3>
				<button type="button" onClick={() => setAdding(true)}>
					{t("Add connector")}
				</button>
			</div>
			{error ? <Failure message={error} /> : null}
			{!data && !error ? <Loading /> : null}
			{data?.length === 0 ? <Empty>{t("No connectors yet.")}</Empty> : null}
			{data?.map((c) => (
				<article key={c.name} className="card connector-card">
					<div className="card-head">
						<strong>{c.name}</strong>
						{c.tools === undefined ? (
							<Badge tone="warn">{t("Tools unreadable")}</Badge>
						) : (
							<Badge>{t("{count} tools", { count: c.tools })}</Badge>
						)}
					</div>
					<p className="meta connector-url">
						{c.displayUrl ?? t("(the URL cannot be parsed)")}
					</p>
					<p>{c.description}</p>
					<div className="actions">
						<button
							type="button"
							className="secondary"
							onClick={() => setEditing(c)}
						>
							{t("Edit purpose")}
						</button>
						<button
							type="button"
							className="danger"
							onClick={() => setRemoving(c)}
						>
							{t("Remove")}
						</button>
					</div>
				</article>
			))}
			<Dialog
				open={adding}
				title={t("Add an MCP connector")}
				onClose={() => setAdding(false)}
			>
				{adding ? (
					<AddForm
						onCancel={() => setAdding(false)}
						onDone={() => {
							setAdding(false);
							reload();
						}}
					/>
				) : null}
			</Dialog>
			<Dialog
				open={editing !== undefined}
				title={t("Edit purpose of {name}", { name: editing?.name ?? "" })}
				onClose={() => setEditing(undefined)}
			>
				{editing ? (
					<PurposeForm
						key={editing.name}
						connector={editing}
						onCancel={() => setEditing(undefined)}
						onDone={() => {
							setEditing(undefined);
							reload();
						}}
					/>
				) : null}
			</Dialog>
			<Confirm
				open={removing !== undefined}
				title={t("Remove connector")}
				confirmLabel={t("Remove")}
				tone="danger"
				onClose={() => setRemoving(undefined)}
				onConfirm={async () => {
					if (!removing) return;
					await connectorsApi.remove(removing.name);
					toast(t("Removed {name}.", { name: removing.name }));
					reload();
				}}
			>
				<p>
					{t(
						"Remove {name} and its token? From the next message on, the knights no longer use it.",
						{ name: removing?.name ?? "" },
					)}
				</p>
			</Confirm>
		</section>
	);
}
