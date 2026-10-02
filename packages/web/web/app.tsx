import { useEffect, useState } from "react";
import type { ConfigView, PaneName } from "../src/api-types.ts";
import { Failure, Loading } from "./components/states.tsx";
import { api, messageOf } from "./lib/api.ts";
import { ConfigContext } from "./lib/config.ts";
import { LiveContext, useLiveSource } from "./lib/live.ts";
import { hrefFor, useRoute } from "./lib/router.ts";
import { ConversationsPage } from "./pages/conversations.tsx";
import { NotesPage } from "./pages/notes.tsx";
import { OverviewPage } from "./pages/overview.tsx";
import { TranscriptPage } from "./pages/transcript.tsx";

const LABELS: Record<PaneName, string> = {
	overview: "Overview",
	conversations: "Conversations",
	notes: "Notes",
};

export function App() {
	const [config, setConfig] = useState<ConfigView>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		api
			.config()
			.then((loaded) => {
				setConfig(loaded);
				document.title = loaded.title;
			})
			.catch((failure) => setError(messageOf(failure)));
	}, []);
	if (!config)
		return (
			<div className="shell">
				{error ? <Failure message={error} /> : <Loading />}
			</div>
		);
	return (
		<ConfigContext.Provider value={config}>
			<Console config={config} />
		</ConfigContext.Provider>
	);
}

function Console({ config }: { config: ConfigView }) {
	const live = useLiveSource();
	const route = useRoute();
	const first = config.panes[0] ?? "conversations";
	const pane = config.panes.find((name) => name === route.pane) ?? first;
	return (
		<LiveContext.Provider value={live}>
			<div className="shell">
				<header className="bar">
					<div className="bar-start">
						<h1>{config.title}</h1>
						<nav aria-label="Panes">
							{config.panes.map((name) => (
								<a
									key={name}
									href={hrefFor(name)}
									aria-current={name === pane ? "page" : undefined}
								>
									{LABELS[name]}
								</a>
							))}
						</nav>
					</div>
					<span
						className={live.connected ? "live live-on" : "live"}
						title={live.connected ? "Receiving live updates" : "Reconnecting"}
					>
						{live.connected ? "Live" : "Reconnecting…"}
					</span>
				</header>
				<main>
					{pane === "overview" && <OverviewPage />}
					{pane === "conversations" &&
						(route.key ? (
							<TranscriptPage key={route.key} conversationKey={route.key} />
						) : (
							<ConversationsPage />
						))}
					{pane === "notes" && <NotesPage />}
				</main>
			</div>
		</LiveContext.Provider>
	);
}
