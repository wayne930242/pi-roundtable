import { useState } from "react";
import type {
	AgentView,
	ConversationView,
	GroupView,
	PartyView,
} from "../../src/api-types.ts";
import { Cleanup } from "../components/cleanup.tsx";
import { Badge, Empty, Failure, Loading } from "../components/states.tsx";
import { api } from "../lib/api.ts";
import { useConfig } from "../lib/config.ts";
import {
	ago,
	channelTitle,
	discordUrl,
	kilo,
	size,
	when,
} from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { translate as t } from "../lib/messages.ts";
import { hrefFor } from "../lib/router.ts";
import { useFetched } from "../lib/use-fetched.ts";

export function OverviewPage() {
	const config = useConfig();
	const { now } = useLive();
	const [revision, setRevision] = useState(0);
	const refresh = () => setRevision((value) => value + 1);
	const { data: view, error } = useFetched(
		() => api.overview(),
		`overview:${revision}`,
	);
	if (!view) return error ? <Failure message={error} /> : <Loading />;
	return (
		<>
			{error ? <Failure message={error} /> : null}
			<section className="stack">
				<h2>{t("Agent server")}</h2>
				<p className="hint">
					{t(
						"Agent and group status; starting over archives the conversation and preserves memory.",
					)}
				</p>
				{view.agents.length + view.groups.length === 0 ? (
					<Empty>{t("No agents.")}</Empty>
				) : null}
				{view.agents.map((agent) => (
					<AgentRow
						key={agent.name}
						agent={agent}
						groups={view.groups}
						agents={view.agents}
						guildId={view.guildId}
						now={now}
						refresh={refresh}
					/>
				))}
				{view.groups.map((group) => (
					<article key={group.name} className="card">
						<div className="card-head">
							<a
								href={discordUrl(group.channelId, view.guildId)}
								target="_blank"
								rel="noreferrer"
							>
								{group.displayName}
							</a>
							<Badge>{t("Group")}</Badge>
							<Busy busy={group.busy} />
						</div>
						<p>
							{t("Members: {members} | Host: {host}", {
								members: group.members.join(", "),
								host: group.host,
							})}
						</p>
						<p className="hint">
							{t("Last active")} {ago(group.lastActive, now, config.timeZone)}
						</p>
						<Cleanup
							channel={`discord:${group.channelId}`}
							title={group.displayName}
							busy={group.busy > 0}
							refresh={refresh}
						/>
					</article>
				))}
			</section>
			<section className="stack">
				<h2>{t("My workspaces")}</h2>
				<p className="hint">
					{t(
						"Direct messages and channels where you mention the assistant. Start over archives; delete removes every archive permanently.",
					)}
				</p>
				{view.workspaces?.length ? (
					view.workspaces.map((c) => (
						<StoredRow
							key={c.key}
							conversation={c}
							schedules={c.schedules}
							now={now}
							refresh={refresh}
						/>
					))
				) : (
					<Empty>{t("No workspaces.")}</Empty>
				)}
			</section>
			<section className="stack">
				<h2>{t("Outside-agent conversations")}</h2>
				<p className="hint">
					{t(
						"Conversations opened through remote MCP; after deletion the session ID cannot be resumed.",
					)}
				</p>
				{view.outside?.length ? (
					view.outside.map((c) => (
						<StoredRow
							key={c.key}
							conversation={c}
							now={now}
							refresh={refresh}
						/>
					))
				) : (
					<Empty>{t("No outside-agent conversations.")}</Empty>
				)}
			</section>
			<section className="stack">
				<h2>{t("Party channels")}</h2>
				<p className="hint">
					{t(
						"Starting over stops the container and archives role conversations; each speaker's memory is preserved.",
					)}
				</p>
				{view.party?.length ? (
					view.party.map((party) => (
						<PartyRow
							key={party.key}
							party={party}
							now={now}
							refresh={refresh}
						/>
					))
				) : (
					<Empty>{t("No party channels.")}</Empty>
				)}
			</section>
		</>
	);
}

function Busy({ busy }: { busy: number }) {
	return (
		<Badge tone={busy ? "busy" : "plain"}>
			{busy === 0
				? t("idle")
				: busy === 1
					? t("Working")
					: t("Working, {count} waiting", { count: busy - 1 })}
		</Badge>
	);
}

function AgentRow(props: {
	agent: AgentView;
	groups: GroupView[];
	agents: AgentView[];
	guildId: string;
	now: number;
	refresh(): void;
}) {
	const { agent } = props;
	const { timeZone, panes } = useConfig();
	const group = props.groups.find((g) => g.channelId === agent.workingIn);
	const other = props.agents.find((a) => a.channelId === agent.workingIn);
	const where = !agent.workingIn
		? undefined
		: agent.workingIn === agent.channelId
			? t("Working in own channel")
			: group
				? t("Working in group {name}", { name: group.displayName })
				: other
					? t("Replying in {name}'s channel", { name: other.displayName })
					: t("Replying in another channel");
	return (
		<article className="card">
			<div className="card-head">
				<strong>
					{agent.channelId ? (
						<a
							href={discordUrl(agent.channelId, props.guildId)}
							target="_blank"
							rel="noreferrer"
						>
							{agent.displayName}
						</a>
					) : (
						agent.displayName
					)}
				</strong>
				<Badge>agent</Badge>
				{agent.workingIn ? (
					<Busy busy={1 + agent.waiting} />
				) : agent.waiting > 0 ? (
					<Badge tone="busy">
						{t("{count} waiting", { count: agent.waiting })}
					</Badge>
				) : (
					<Badge>{t("idle")}</Badge>
				)}
			</div>
			{where ? <p>{where}</p> : null}
			<dl className="facts">
				<div>
					<dt>{t("Model")}</dt>
					<dd>
						{agent.model} · thinking {agent.thinking}
					</dd>
				</div>
				<div>
					<dt>{t("Context")}</dt>
					<dd>
						{agent.context
							? agent.context.tokens === null
								? t("Just compacted (limit {limit})", {
										limit: kilo(agent.context.contextWindow),
									})
								: `${kilo(agent.context.tokens)} / ${kilo(agent.context.contextWindow)} (${Math.round((agent.context.tokens / agent.context.contextWindow) * 100)}%)`
							: "—"}
					</dd>
				</div>
				<div>
					<dt>{t("Schedules")}</dt>
					<dd>{agent.schedules}</dd>
				</div>
				<div>
					<dt>{t("Last active")}</dt>
					<dd>{ago(agent.lastActive, props.now, timeZone)}</dd>
				</div>
			</dl>
			{agent.channelId ? (
				<>
					<Cleanup
						channel={`discord:${agent.channelId}`}
						title={agent.displayName}
						busy={!!agent.workingIn || agent.waiting > 0}
						refresh={props.refresh}
					/>
					{panes.includes("conversations") ? (
						<a href={hrefFor("conversations", `discord:${agent.channelId}`)}>
							{t("transcript")}
						</a>
					) : null}
				</>
			) : null}
		</article>
	);
}

function StoredRow({
	conversation: c,
	schedules,
	now,
	refresh,
}: {
	conversation: ConversationView;
	schedules?: number;
	now: number;
	refresh(): void;
}) {
	const { timeZone, panes } = useConfig();
	const { title, detail } =
		c.kind === "outside"
			? { title: c.firstMessage || t("(No messages)"), detail: c.id }
			: channelTitle(c.channel, c.id);
	return (
		<article className="card">
			<div className="card-head">
				<strong>
					{c.channel && c.channel.kind !== "gone" ? (
						<a
							href={discordUrl(
								c.id,
								c.channel.kind === "guild" ? c.channel.guildId : undefined,
							)}
							target="_blank"
							rel="noreferrer"
						>
							{title}
						</a>
					) : (
						title
					)}
				</strong>
				<Busy busy={c.busy} />
			</div>
			{detail ? <p className="hint">{detail}</p> : null}
			<p>
				{c.liveBytes > 0
					? t("Conversation {size} · Archives {count}", {
							size: size(c.liveBytes),
							count: c.archives,
						})
					: t("No live conversation · Archives {count}", { count: c.archives })}
			</p>
			{c.startedAt ? (
				<p>
					{t("Started")} {when(c.startedAt, timeZone)}
				</p>
			) : null}
			<p className="hint">
				{schedules !== undefined ? `${t("Schedules")} ${schedules} · ` : ""}
				{t("Last active")} {ago(c.lastActive, now, timeZone)}
			</p>
			<Cleanup
				channel={c.key}
				title={title}
				busy={c.busy > 0}
				deletable
				refresh={refresh}
			/>
			{panes.includes("conversations") ? (
				<a href={hrefFor("conversations", c.key)}>{t("transcript")}</a>
			) : null}
		</article>
	);
}

function PartyRow({
	party: p,
	now,
	refresh,
}: {
	party: PartyView;
	now: number;
	refresh(): void;
}) {
	const { timeZone } = useConfig();
	const { title, detail } = channelTitle(p.channel, p.channelId);
	const labels = {
		running: "Container running",
		stopped: "Container stopped",
		missing: "No container yet",
		unknown: "Container status unknown",
	};
	return (
		<article className="card">
			<div className="card-head">
				<strong>
					{p.channel.kind !== "gone" ? (
						<a
							href={discordUrl(
								p.channelId,
								p.channel.kind === "guild" ? p.channel.guildId : undefined,
							)}
							target="_blank"
							rel="noreferrer"
						>
							{title}
						</a>
					) : (
						title
					)}
				</strong>
				<Badge>{p.profile}</Badge>
				<Badge>{t(labels[p.container])}</Badge>
				<Busy busy={p.busy} />
			</div>
			{detail ? <p className="hint">{detail}</p> : null}
			<p>
				{t("Enabled by {name} at {time}", {
					name: p.enabledBy,
					time: when(p.enabledAt, timeZone),
				})}
			</p>
			<p className="hint">
				{t("Last active")} {ago(p.lastActive, now, timeZone)}
			</p>
			<Cleanup
				channel={p.key}
				title={title}
				busy={p.busy > 0}
				refresh={refresh}
			/>
		</article>
	);
}
