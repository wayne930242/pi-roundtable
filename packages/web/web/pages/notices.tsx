import { useEffect, useState } from "react";
import type { NoticeView } from "../../src/api-types.ts";
import { Icon } from "../components/icons.tsx";
import { Badge, Empty, Failure } from "../components/states.tsx";
import "../lib/account-styles.ts";
import { messageOf } from "../lib/api.ts";
import { translate as t } from "../lib/messages.ts";
import { ackNotice, hrefOfNotice, useNotices } from "../lib/notices.ts";

/** How long ago, in the words a list of notices uses. */
function ago(iso: string, now: number): string {
	const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
	if (minutes < 1) return t("just now");
	if (minutes < 60) return t("{count} min ago", { count: minutes });
	const hours = Math.round(minutes / 60);
	if (hours < 24) return t("{count} h ago", { count: hours });
	return t("{count} d ago", { count: Math.round(hours / 24) });
}

function NoticeRow({ notice }: { notice: NoticeView }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	return (
		<li
			className="card stack notice"
			data-urgent={notice.urgency === "high" || undefined}
		>
			<div className="card-head">
				<strong>{notice.title}</strong>
				{notice.urgency === "high" ? (
					<Badge tone="warn">{t("Urgent")}</Badge>
				) : null}
			</div>
			{notice.body ? <p>{notice.body}</p> : null}
			<p className="meta">{ago(notice.raisedAt, Date.now())}</p>
			{error ? <Failure message={error} /> : null}
			<div className="actions">
				{notice.open ? (
					<a className="button" href={hrefOfNotice(notice.open)}>
						{t("Open")}
					</a>
				) : null}
				{notice.ackable ? (
					notice.acked ? (
						<span className="meta">
							<Icon name="check" size={14} /> {t("Handled")}
						</span>
					) : (
						<button
							type="button"
							className="secondary"
							disabled={busy}
							onClick={async () => {
								setBusy(true);
								setError(undefined);
								try {
									await ackNotice(notice.tag);
								} catch (failure) {
									setError(messageOf(failure));
								} finally {
									setBusy(false);
								}
							}}
						>
							{t("Handled")}
						</button>
					)
				) : null}
			</div>
		</li>
	);
}

/** The person's open notices, newest first. Each opens its room or page; one that wants an answer can be marked handled. */
export function NoticesPage() {
	const { notices, known } = useNotices();
	const [, tick] = useState(0);
	// Times read "5 min ago" and age while the page stays open.
	useEffect(() => {
		const timer = setInterval(() => tick((n) => n + 1), 60_000);
		return () => clearInterval(timer);
	}, []);
	return (
		<div className="page">
			<header className="page-head">
				<h1>{t("Notices")}</h1>
			</header>
			{notices.length === 0 ? (
				<Empty>{known ? t("Nothing needs you.") : t("Loading…")}</Empty>
			) : (
				<ul className="stack notices">
					{notices.map((notice) => (
						<NoticeRow key={notice.tag} notice={notice} />
					))}
				</ul>
			)}
		</div>
	);
}
