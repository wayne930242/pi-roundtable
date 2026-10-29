import { useEffect, useState } from "react";
import type { FormInput, HostActionView } from "../../src/api-types.ts";
import type {
	HostActionResult,
	PageSectionView,
} from "../../src/host/views.ts";
import { HostActions, type RunAction } from "../components/host-actions.tsx";
import { HostCard } from "../components/host-card.tsx";
import { HostForm } from "../components/host-form.tsx";
import { HostMarkdown } from "../components/host-markdown.tsx";
import { Empty, Failure, Loading } from "../components/states.tsx";
import { ApiFailure, messageOf } from "../lib/api.ts";
import { hostApi, openTarget, refusalText } from "../lib/host-api.ts";
import { useHost } from "../lib/host-state.ts";
import { installHostStyle } from "../lib/host-style.ts";
import { translate as t } from "../lib/messages.ts";
import type { PageRouteProps } from "../lib/page-routes.ts";
import { toast } from "../lib/toast.ts";
import { currentQuery } from "../lib/where.ts";

installHostStyle();

/** The address's query as the page's input, kept in step with the address. */
function useQuery(): string {
	const [query, setQuery] = useState(() => currentQuery().toString());
	useEffect(() => {
		const read = () => setQuery(currentQuery().toString());
		window.addEventListener("popstate", read);
		window.addEventListener("hashchange", read);
		return () => {
			window.removeEventListener("popstate", read);
			window.removeEventListener("hashchange", read);
		};
	}, []);
	return query;
}

/** A refusal or success of a page action, told to the person; the refusal comes back for a form to show. */
function told(
	result: HostActionResult,
): { error: string; field?: string } | undefined {
	if (!result.ok)
		return {
			error: refusalText(result.error),
			...(result.field ? { field: result.field } : {}),
		};
	if (result.notice) toast(result.notice);
	if (result.open) openTarget(result.open);
	return undefined;
}

function Section(props: {
	section: PageSectionView;
	run: RunAction;
	submit(
		action: string,
		input: FormInput,
	): Promise<{ error: string; field?: string } | undefined>;
}) {
	const { section } = props;
	switch (section.kind) {
		case "markdown":
			return <HostMarkdown source={section.text} />;
		case "card":
			return <HostCard card={section.card} run={props.run} />;
		case "form":
			return (
				<section className="stack">
					<h2 className="section-title">{section.form.title}</h2>
					<HostForm
						spec={section.form}
						onSubmit={(input) => props.submit(section.action, input)}
					/>
				</section>
			);
		case "list":
			return (
				<section className="stack">
					{section.title ? (
						<h2 className="section-title">{section.title}</h2>
					) : null}
					{section.rows.length === 0 ? (
						<Empty>{t("Nothing here.")}</Empty>
					) : null}
					<ul className="host-list">
						{keyed(section.rows).map(([key, row]) => (
							<li key={key}>
								{row.attention ? (
									<span
										className="attention-dot"
										role="img"
										aria-label={t("Needs attention")}
									/>
								) : null}
								<div className="host-list-main">
									{row.open ? (
										<a
											href={row.open}
											{...(row.open.startsWith("/")
												? {}
												: { target: "_blank", rel: "noreferrer noopener" })}
										>
											{row.title}
										</a>
									) : (
										<strong>{row.title}</strong>
									)}
									{row.subtitle ? <span>{row.subtitle}</span> : null}
								</div>
								{row.actions?.length ? (
									<HostActions actions={row.actions} run={props.run} />
								) : null}
							</li>
						))}
					</ul>
				</section>
			);
	}
}

/**
 * A page the host adds (route `p/<id>`): a title and sections of Markdown, lists, forms and cards.
 * The host says who sees it and what each button does; the page fetches again when it says it changed.
 */
export function HostPage({ routeKey }: PageRouteProps) {
	const id = routeKey ?? "";
	const query = useQuery();
	const changed = useHost((state) => state.pages[id] ?? 0);
	const [reload, setReload] = useState(0);
	const [state, setState] = useState<{
		page?: import("../../src/host/views.ts").HostPageView;
		error?: string;
		gone?: boolean;
	}>({});
	// biome-ignore lint/correctness/useExhaustiveDependencies: the page, its query and the change counters say when to fetch
	useEffect(() => {
		let current = true;
		hostApi.page(id, Object.fromEntries(new URLSearchParams(query))).then(
			(page) => current && setState({ page }),
			(failure) => {
				if (!current) return;
				const gone = failure instanceof ApiFailure && failure.status === 404;
				setState((was) => ({
					...(gone || !was.page ? {} : { page: was.page }),
					error: messageOf(failure),
					gone,
				}));
			},
		);
		return () => {
			current = false;
		};
	}, [id, query, changed, reload]);

	const act = async (action: string, input: FormInput) => {
		const result = await hostApi.pageAct(id, { action, input });
		const failed = told(result);
		if (!failed) setReload((count) => count + 1);
		return failed;
	};
	const run: RunAction = async (action: HostActionView, input) => {
		const result = await hostApi.pageAct(id, { action: action.id, input });
		if (result.ok) setReload((count) => count + 1);
		return result;
	};

	if (state.gone)
		return (
			<div className="page">
				<Empty>{t("This page is not available.")}</Empty>
			</div>
		);
	if (!state.page)
		return (
			<div className="page">
				{state.error ? <Failure message={state.error} /> : <Loading />}
			</div>
		);
	return (
		<div className="page">
			<header className="page-head">
				<h1>{state.page.title}</h1>
			</header>
			{state.error ? <Failure message={state.error} /> : null}
			{state.page.sections.map((section, index) => (
				<Section
					// biome-ignore lint/suspicious/noArrayIndexKey: sections have no id; the page replaces them all together
					key={index}
					section={section}
					run={run}
					submit={act}
				/>
			))}
		</div>
	);
}

/** Rows paired with a key: the title, and for a title that repeats, how many times it has come before. */
function keyed<T extends { title: string }>(rows: readonly T[]): [string, T][] {
	const seen = new Map<string, number>();
	return rows.map((row) => {
		const before = seen.get(row.title) ?? 0;
		seen.set(row.title, before + 1);
		return [`${row.title}:${before}`, row];
	});
}
