import { useEffect, useState } from "react";
import type {
	AgentView,
	GroupView,
	OverviewView,
} from "../../src/api-types.ts";
import { Badge, Empty, Failure, Loading } from "../components/states.tsx";
import { api, messageOf } from "../lib/api.ts";
import { useConfig } from "../lib/config.ts";
import { ago, discordUrl, kilo } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { hrefFor } from "../lib/router.ts";

export function OverviewPage() {
	const { timeZone } = useConfig();
	const { version, now } = useLive();
	const [view, setView] = useState<OverviewView>();
	const [error, setError] = useState<string>();

	// biome-ignore lint/correctness/useExhaustiveDependencies: the version moves whenever the server reports a change
	useEffect(() => {
		api
			.overview()
			.then((loaded) => {
				setView(loaded);
				setError(undefined);
			})
			.catch((failure) => setError(messageOf(failure)));
	}, [version]);

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
}: {
	channelId: string | undefined;
	guildId: string;
	label: string;
}) {
	if (!channelId) return <>{label}</>;
	return (
		<>
			<a href={discordUrl(channelId, guildId)} target="_blank" rel="noreferrer">
				{label}
			</a>{" "}
			·{" "}
			<a href={hrefFor("conversations", `discord:${channelId}`)}>transcript</a>
		</>
	);
}

function AgentRow(props: {
	agent: AgentView;
	guildId: string;
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
