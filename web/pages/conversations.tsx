import type {
	ConversationKind,
	ConversationView,
} from "../../src/api-types.ts";
import { Badge, Empty, Failure, Loading } from "../components/states.tsx";
import { api } from "../lib/api.ts";
import { useConfig } from "../lib/config.ts";
import { ago, channelTitle, size, when } from "../lib/format.ts";
import { useLive } from "../lib/live.ts";
import { hrefFor } from "../lib/router.ts";
import { useFetched } from "../lib/use-fetched.ts";

const SECTIONS: { kind: ConversationKind; title: string; note: string }[] = [
	{
		kind: "owner",
		title: "Owner channels",
		note: "Direct messages and channels where the owner talks to the assistant.",
	},
	{
		kind: "agent",
		title: "Agent channels",
		note: "The agent server's one-to-one channels.",
	},
	{
		kind: "group",
		title: "Group channels",
		note: "The agent server's group channels.",
	},
	{
		kind: "outside",
		title: "Outside agents",
		note: "Conversations an agent outside Discord holds over MCP.",
	},
];

export function ConversationsPage() {
	const { timeZone } = useConfig();
	const { now } = useLive();
	const { data, error } = useFetched(
		() => api.conversations(),
		"conversations",
	);
	const items = data?.conversations;

	if (!items) return error ? <Failure message={error} /> : <Loading />;
	return (
		<>
			{error ? <Failure message={error} /> : null}
			{SECTIONS.map((section) => {
				const rows = items.filter((item) => item.kind === section.kind);
				return (
					<section key={section.kind} className="stack">
						<h2>{section.title}</h2>
						<p className="hint">{section.note}</p>
						{rows.length === 0 ? <Empty>None stored.</Empty> : null}
						{rows.map((item) => (
							<Row key={item.key} item={item} now={now} timeZone={timeZone} />
						))}
					</section>
				);
			})}
		</>
	);
}

function Row(props: { item: ConversationView; now: number; timeZone: string }) {
	const { item } = props;
	const named = channelTitle(item.channel, item.id);
	const title =
		item.kind === "outside"
			? item.firstMessage || `Session ${item.id.slice(0, 8)}`
			: named.title;
	return (
		<a className="card card-link" href={hrefFor("conversations", item.key)}>
			<div className="card-head">
				<strong>{title}</strong>
				{item.busy > 0 ? <Badge tone="busy">running</Badge> : null}
				{item.liveBytes === 0 ? <Badge>archived only</Badge> : null}
			</div>
			<p className="meta">
				{item.kind === "outside" && item.startedAt
					? `Started ${when(item.startedAt, props.timeZone)} · `
					: named.detail
						? `${named.detail} · `
						: ""}
				Last active {ago(item.lastActive, props.now, props.timeZone)} ·{" "}
				{size(item.liveBytes)} · {item.archives} archived
			</p>
		</a>
	);
}
