import { ConnectorManage } from "../components/connector-manage.tsx";
import { McpGrants } from "../components/mcp-grants.tsx";
import { Badge, Empty, Failure, Loading } from "../components/states.tsx";
import { api } from "../lib/api.ts";
import { useConfig } from "../lib/config.ts";
import { installConnectorsStyle } from "../lib/connectors-style.ts";
import { translate as t } from "../lib/messages.ts";
import { useFetched } from "../lib/use-fetched.ts";

export function ConnectorsPage() {
	installConnectorsStyle();
	const { connectorAdminUrl, connectorParts } = useConfig();
	// A host from before the parts were named serves the gateways whenever it serves the page.
	const parts = connectorParts ?? { gateways: true };
	return (
		<section className="stack connectors-page">
			<header className="page-head">
				<h1>{t("Connectors")}</h1>
				{connectorAdminUrl ? (
					<a href={connectorAdminUrl} target="_blank" rel="noreferrer">
						{t("Open connector admin")}
					</a>
				) : null}
			</header>
			<p className="hint">
				{t("Upstream MCP gateways and virtual servers used by the knights.")}
			</p>
			{parts.manage ? <ConnectorManage /> : null}
			{parts.grants ? <McpGrants /> : null}
			{parts.gateways ? <Gateways /> : null}
		</section>
	);
}

/** What the MCP gateway holds: upstream gateways and virtual servers, read only. */
function Gateways() {
	const { data: view, error } = useFetched(
		() => api.connectors(),
		"connectors",
	);
	return (
		<section className="stack">
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
