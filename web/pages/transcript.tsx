import { useEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "../../src/api-types.ts";
import { Badge, Empty, Failure, Loading } from "../components/states.tsx";
import { api } from "../lib/api.ts";
import { useConfig } from "../lib/config.ts";
import { conversationTitle, when } from "../lib/format.ts";
import { hrefFor } from "../lib/router.ts";
import { useFetched } from "../lib/use-fetched.ts";

export function TranscriptPage({
	conversationKey,
}: {
	conversationKey: string;
}) {
	const [archive, setArchive] = useState<string>();
	const scrolled = useRef(false);
	const { data: view, error } = useFetched(
		() => api.transcript(conversationKey, archive),
		`${conversationKey}|${archive ?? ""}`,
	);

	// The first load of a conversation shows its end; later refreshes leave the reader where they are.
	useEffect(() => {
		if (view && !scrolled.current) {
			scrolled.current = true;
			window.scrollTo(0, document.body.scrollHeight);
		}
	}, [view]);

	const back = (
		<a className="back" href={hrefFor("conversations")}>
			← Conversations
		</a>
	);
	if (!view)
		return (
			<>
				{back}
				{error ? <Failure message={error} /> : <Loading />}
			</>
		);
	const { conversation } = view;
	const title =
		conversation.kind === "outside"
			? `Outside agent · ${conversation.id.slice(0, 8)}`
			: conversationTitle(conversation);
	return (
		<>
			{back}
			<section className="stack">
				<div className="card-head">
					<h2>{title}</h2>
					{conversation.busy > 0 ? <Badge tone="busy">running</Badge> : null}
				</div>
				{view.archives.length > 0 ? (
					<label className="inline">
						Showing{" "}
						<select
							value={archive ?? ""}
							onChange={(event) => {
								scrolled.current = false;
								setArchive(event.target.value || undefined);
							}}
						>
							<option value="">Current conversation</option>
							{view.archives.map((name) => (
								<option key={name} value={name}>
									Archived {name}
								</option>
							))}
						</select>
					</label>
				) : null}
				{error ? <Failure message={error} /> : null}
				{view.truncated ? (
					<p className="hint">
						This conversation is longer than the console reads; the oldest
						entries are not shown.
					</p>
				) : null}
				{view.entries.length === 0 ? <Empty>Nothing to show.</Empty> : null}
				<ol className="transcript">
					{view.entries.map((entry, index) => (
						// The entries have no ids; their order is the transcript.
						// biome-ignore lint/suspicious/noArrayIndexKey: see above
						<Entry key={index} entry={entry} />
					))}
				</ol>
			</section>
		</>
	);
}

function Entry({ entry }: { entry: TranscriptEntry }) {
	const { timeZone } = useConfig();
	const stamp = entry.at ? when(entry.at, timeZone) : "";
	if (entry.role === "tool")
		return (
			<li className="entry entry-tool">
				<details>
					<summary>
						{entry.failed ? "Tool failed" : "Tool result"}
						{entry.tool ? ` · ${entry.tool}` : ""}
					</summary>
					<pre>{entry.text || "(empty)"}</pre>
				</details>
			</li>
		);
	return (
		<li className={`entry entry-${entry.role}`}>
			<div className="entry-head">
				<span className="role">{LABELS[entry.role]}</span>
				<span className="meta">{stamp}</span>
			</div>
			{entry.text ? <p className="text">{entry.text}</p> : null}
			{entry.calls?.map((call, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: calls repeat names and keep their order
				<code key={index} className="call">
					{call.name} {call.preview}
				</code>
			))}
		</li>
	);
}

const LABELS: Record<TranscriptEntry["role"], string> = {
	user: "User",
	assistant: "Assistant",
	tool: "Tool",
	compaction: "Summary of earlier conversation",
};
