import type { AgentView, GroupView, PartyView } from "../../src/api-types.ts";
import { useConfig } from "../lib/config.ts";
import { ago, channelTitle, discordUrl, kilo, when } from "../lib/format.ts";
import { translate as t, wording } from "../lib/messages.ts";
import { hrefFor } from "../lib/router.ts";
import { Cleanup } from "./cleanup.tsx";
import { Badge } from "./states.tsx";

export function Busy({ busy }: { busy: number }) {
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

/** A group's card. A group of a team without Discord has no channel, so it links none and offers no cleanup. */
export function GroupCard(props: {
	group: GroupView;
	guildId: string;
	now: number;
	timeZone: string;
	refresh(): void;
}) {
	const { group, now, timeZone } = props;
	return (
		<article className="card">
			<div className="card-head">
				{group.channelId ? (
					<a
						href={discordUrl(group.channelId, props.guildId)}
						target="_blank"
						rel="noreferrer"
					>
						{group.displayName}
					</a>
				) : (
					<strong>{group.displayName}</strong>
				)}
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
				{t("Last active")} {ago(group.lastActive, now, timeZone)}
			</p>
			{group.room || group.channelId ? (
				<Cleanup
					channel={group.room ?? `discord:${group.channelId}`}
					title={group.displayName}
					busy={group.busy > 0}
					refresh={props.refresh}
				/>
			) : null}
		</article>
	);
}

export function AgentRow(props: {
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
			{agent.room || agent.channelId ? (
				<Cleanup
					channel={agent.room ?? `discord:${agent.channelId}`}
					title={agent.displayName}
					busy={!!agent.workingIn || agent.waiting > 0}
					refresh={props.refresh}
				/>
			) : null}
			{agent.channelId && panes.includes("conversations") ? (
				<a href={hrefFor("conversations", `discord:${agent.channelId}`)}>
					{t("transcript")}
				</a>
			) : null}
		</article>
	);
}

export function PartyRow({
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
		running: wording("Container running"),
		stopped: wording("Container stopped"),
		missing: wording("No container yet"),
		unknown: wording("Container status unknown"),
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
