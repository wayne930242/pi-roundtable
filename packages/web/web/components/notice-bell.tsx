import "../lib/account-styles.ts";
import { translate as t } from "../lib/messages.ts";
import { useNotices } from "../lib/notices.ts";
import { hrefFor } from "../lib/router.ts";
import { Icon } from "./icons.tsx";

/**
 * The bell: a link to the person's notices, with the count of those waiting on them. The count is
 * the one the app icon shows. It is drawn only where the app admits more than its owners.
 */
export default function NoticeBell({ current }: { current?: boolean }) {
	const { badge } = useNotices();
	return (
		<a
			className="icon-button bell"
			href={hrefFor("notices")}
			aria-current={current ? "page" : undefined}
			aria-label={
				badge > 0
					? t("Notices, {count} waiting", { count: badge })
					: t("Notices")
			}
		>
			<Icon name="bell" />
			{badge > 0 ? (
				<span className="bell-count" aria-hidden="true">
					{badge > 99 ? "99+" : badge}
				</span>
			) : null}
		</a>
	);
}
