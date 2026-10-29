import type { GateStepView } from "../../src/api-types.ts";
import { Icon } from "../components/icons.tsx";
import { translate as t } from "../lib/messages.ts";
import { hrefFor } from "../lib/router.ts";

/**
 * What a person sees while a required step stands undone: the steps, each with the page that
 * finishes it. Their profile and settings stay reachable from the shell around it.
 */
export function GatePage({ steps }: { steps: readonly GateStepView[] }) {
	return (
		<div className="page">
			<header className="page-head">
				<h1>{t("Finish setting up")}</h1>
			</header>
			<p className="meta">
				{t(
					"These steps come first. The rest of the app opens when they are done.",
				)}
			</p>
			<ul className="menu">
				{steps.map((step) => (
					<li key={step.id}>
						<a className="menu-item menu-link" href={hrefFor(step.open.page)}>
							<span className="menu-text">
								<strong>{step.label}</strong>
								{step.help ? <span className="meta">{step.help}</span> : null}
							</span>
							<Icon name="chevron" size={16} />
						</a>
					</li>
				))}
			</ul>
		</div>
	);
}
