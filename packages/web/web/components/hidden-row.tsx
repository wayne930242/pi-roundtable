import { translate as t } from "../lib/messages.ts";
import { hrefFor } from "../lib/router.ts";
import { Icon } from "./icons.tsx";

/** The one collapsed row at the end of the list: how many rooms are hidden and archived, with a dot when a hidden room has unread. */
export default function HiddenRow(props: {
	hidden: number;
	archived: number;
	dot: boolean;
}) {
	return (
		<a className="hidden-row" href={hrefFor("hidden")}>
			<span>
				{t("Hidden {hidden} · Archived {archived}", {
					hidden: props.hidden,
					archived: props.archived,
				})}
			</span>
			{props.dot ? (
				<i className="chip-dot" role="img" aria-label={t("Unread messages")} />
			) : null}
			<Icon name="chevron" size={16} />
		</a>
	);
}
