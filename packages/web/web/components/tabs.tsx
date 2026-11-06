import type { KeyboardEvent } from "react";

/** The ids that tie a tab to its panel, from the tab bar's prefix. */
export const tabId = (prefix: string, value: string): string =>
	`${prefix}-tab-${value}`;
export const panelId = (prefix: string, value: string): string =>
	`${prefix}-panel-${value}`;

/**
 * A row of tabs, the one that is on selected. The arrow keys, Home and End move among them and
 * select the one they land on; only the selected tab is in the tab order. With a `prefix`, each tab
 * names the panel it controls (`panelId`), which carries `role="tabpanel"`.
 */
export function Tabs<Value extends string>(props: {
	label: string;
	value: Value;
	tabs: readonly { value: Value; label: string }[];
	onChange(value: Value): void;
	prefix?: string;
	className?: string;
}) {
	const { prefix } = props;
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const at = props.tabs.findIndex((tab) => tab.value === props.value);
		const last = props.tabs.length - 1;
		const to =
			event.key === "ArrowRight"
				? at >= last
					? 0
					: at + 1
				: event.key === "ArrowLeft"
					? at <= 0
						? last
						: at - 1
					: event.key === "Home"
						? 0
						: event.key === "End"
							? last
							: -1;
		const next = props.tabs[to];
		if (!next) return;
		event.preventDefault();
		props.onChange(next.value);
		const buttons =
			event.currentTarget.querySelectorAll<HTMLElement>("[role=tab]");
		buttons[to]?.focus();
	};
	return (
		<div
			className={props.className ? `tabs ${props.className}` : "tabs"}
			role="tablist"
			aria-label={props.label}
			onKeyDown={onKeyDown}
		>
			{props.tabs.map((tab) => {
				const on = tab.value === props.value;
				return (
					<button
						key={tab.value}
						type="button"
						role="tab"
						aria-selected={on}
						tabIndex={on ? 0 : -1}
						{...(prefix
							? {
									id: tabId(prefix, tab.value),
									"aria-controls": panelId(prefix, tab.value),
								}
							: {})}
						onClick={() => props.onChange(tab.value)}
					>
						{tab.label}
					</button>
				);
			})}
		</div>
	);
}
