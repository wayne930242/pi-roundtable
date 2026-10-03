import { Badge, Empty, Failure, Loading } from "../components/states.tsx";
import { api } from "../lib/api.ts";
import { useConfig } from "../lib/config.ts";
import { translate as t } from "../lib/messages.ts";
import { useFetched } from "../lib/use-fetched.ts";

export function ConnectorsPage() {
	const { connectorAdminUrl } = useConfig();
	const { data: view, error } = useFetched(
		() => api.connectors(),
		"connectors",
	);
	return (
		<section className="stack">
			<div className="card-head">
				<div>
					<h2>{t("Connectors")}</h2>
					<p className="hint">
						{t(
							"Upstream MCP gateways and virtual servers used by the assistant.",
						)}
					</p>
				</div>
				{connectorAdminUrl ? (
					<a href={connectorAdminUrl} target="_blank" rel="noreferrer">
						{t("Open connector admin")}
					</a>
				) : null}
			</div>
			{error ? <Failure message={error} /> : null}
			{!view && !error ? <Loading /> : null}
			{view ? (
				<>
					<h3>{t("Upstream gateways")}</h3>
					{view.gateways.length === 0 ? (
						<Empty>{t("No gateways.")}</Empty>
					) : null}
					{view.gateways.map((g) => (
						<article key={g.name} className="card">
							<div className="card-head">
								<strong>{g.name}</strong>
								<Badge>{g.enabled ? t("Enabled") : t("Disabled")}</Badge>
								<Badge tone={g.reachable ? "plain" : "warn"}>
									{g.reachable ? t("Reachable") : t("Unreachable")}
								</Badge>
								<Badge>{t("{count} tools", { count: g.tools })}</Badge>
							</div>
						</article>
					))}
					<h3>{t("Virtual servers")}</h3>
					{view.servers.length === 0 ? (
						<Empty>{t("No virtual servers.")}</Empty>
					) : null}
					{view.servers.map((s) => (
						<article key={s.name} className="card">
							<div className="card-head">
								<strong>{s.name}</strong>
								<Badge>{t("{count} tools", { count: s.tools.length })}</Badge>
							</div>
							<p>
								{t("Used by")}: {s.usedBy.join(", ") || t("None")}
							</p>
							<details>
								<summary>{t("Tool list")}</summary>
								<ul>
									{s.tools.map((tool) => (
										<li key={tool}>{tool}</li>
									))}
								</ul>
							</details>
						</article>
					))}
				</>
			) : null}
		</section>
	);
}
