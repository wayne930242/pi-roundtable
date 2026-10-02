import type { AgentView, GroupView } from "../../src/api-types.ts";
import { Badge, Empty, Failure, Loading } from "../components/states.tsx";
import { api } from "../lib/api.ts";
import { useConfig } from "../lib/config.ts";
import { ago, discordUrl, kilo } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { hrefFor } from "../lib/router.ts";
import { useFetched } from "../lib/use-fetched.ts";

export function OverviewPage() {
	const { timeZone, panes } = useConfig();
	const transcripts = panes.includes("conversations");
	const { now } = useLive();
	const { data: view, error } = useFetched(() => api.overview(), "overview");

	if (!view) return error ? <Failure message={error} /> : <Loading />;
	return (
		<>
			{error ? <Failure message={error} /> : null}
			<section className="stack">
				<h2>Agents</h2>
				{view.agents.length === 0 ? <Empty>No agents.</Empty> : null}
				{view.agents.map((agent) => (
					<AgentRow
						key={agent.name}
						agent={agent}
						guildId={view.guildId}
						transcripts={transcripts}
						now={now}
						timeZone={timeZone}
					/>
				))}
			</section>
			<section className="stack">
				<h2>Groups</h2>
				{view.groups.length === 0 ? <Empty>No groups.</Empty> : null}
				{view.groups.map((group) => (
					<GroupRow
						key={group.name}
						group={group}
						guildId={view.guildId}
						now={now}
						timeZone={timeZone}
					/>
				))}
			</section>
		</>
	);
}

function Where({
	channelId,
	guildId,
	label,
	transcriptKey,
}: {
	channelId: string | undefined;
	guildId: string;
	label: string;
	/** The conversation to link, when the console serves transcripts and the row has one. */
	transcriptKey?: string;
}) {
	if (!channelId) return <>{label}</>;
	return (
		<>
			<a href={discordUrl(channelId, guildId)} target="_blank" rel="noreferrer">
				{label}
			</a>
			{transcriptKey ? (
				<>
					{" "}
					· <a href={hrefFor("conversations", transcriptKey)}>transcript</a>
				</>
			) : null}
		</>
	);
}

function AgentRow(props: {
	agent: AgentView;
	guildId: string;
	transcripts: boolean;
	now: number;
	timeZone: string;
}) {
	const { agent } = props;
	return (
		<article className="card">
			<div className="card-head">
				<strong>
					<Where
						channelId={agent.channelId}
						guildId={props.guildId}
						label={agent.displayName}
						{...(props.transcripts && agent.channelId
							? { transcriptKey: `discord:${agent.channelId}` }
							: {})}
					/>
				</strong>
				{agent.workingIn ? (
					<Badge tone="busy">working in {agent.workingIn}</Badge>
				) : agent.waiting > 0 ? (
					<Badge tone="warn">{agent.waiting} waiting</Badge>
				) : (
					<Badge>idle</Badge>
				)}
			</div>
			<dl className="facts">
				<div>
					<dt>Model</dt>
					<dd>
						{agent.model} · {agent.thinking}
					</dd>
				</div>
				<div>
					<dt>Context</dt>
					<dd>
						{agent.context
							? `${agent.context.tokens === null ? "?" : kilo(agent.context.tokens)} / ${kilo(agent.context.contextWindow)}`
							: "—"}
					</dd>
				</div>
				<div>
					<dt>Schedules</dt>
					<dd>{agent.schedules}</dd>
				</div>
				<div>
					<dt>Last active</dt>
					<dd>{ago(agent.lastActive, props.now, props.timeZone)}</dd>
				</div>
			</dl>
		</article>
	);
}

function GroupRow(props: {
	group: GroupView;
	guildId: string;
	now: number;
	timeZone: string;
}) {
	const { group } = props;
	return (
		<article className="card">
			<div className="card-head">
				<strong>
					<Where
						channelId={group.channelId}
						guildId={props.guildId}
						label={group.displayName}
					/>
				</strong>
				{group.busy > 0 ? (
					<Badge tone="busy">{group.busy} running or waiting</Badge>
				) : (
					<Badge>idle</Badge>
				)}
			</div>
			<dl className="facts">
				<div>
					<dt>Members</dt>
					<dd>{group.members.join(", ") || "—"}</dd>
				</div>
				<div>
					<dt>Host</dt>
					<dd>{group.host}</dd>
				</div>
				<div>
					<dt>Last active</dt>
					<dd>{ago(group.lastActive, props.now, props.timeZone)}</dd>
				</div>
			</dl>
		</article>
	);
}
