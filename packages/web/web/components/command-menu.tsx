import {
	type KeyboardEvent,
	type RefObject,
	useEffect,
	useId,
	useState,
} from "react";
import { installStyle } from "../lib/lazy-style.ts";
import { commandQuery, type SlashCommand } from "../lib/slash-commands.ts";

const COMMAND_MENU_CSS = `
/* A zero-height anchor just above the bar: the menu opens upward from it, over the room's messages. */
.command-anchor {
	position: relative;
	height: 0;
	margin-bottom: calc(-1 * var(--space-2));
	z-index: 5;
}

.command-menu {
	position: absolute;
	max-height: min(40vh, 18rem);
	overflow-y: auto;
	right: 0;
	bottom: var(--space-2);
	left: 0;
	display: flex;
	flex-direction: column;
	margin: 0;
	padding: var(--space-1);
	list-style: none;
	border: 1px solid var(--border);
	border-radius: var(--radius-lg);
	background: var(--surface);
	box-shadow: var(--shadow-2);
}

.command-item {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	justify-content: center;
	gap: 0;
	min-height: var(--touch);
	padding: var(--space-2) var(--space-3);
	border: 1px solid transparent;
	border-radius: var(--radius);
	background: none;
	color: var(--text);
	text-align: left;
	cursor: pointer;
}

.command-item:hover:not(:disabled),
.command-item[aria-selected="true"] {
	background: var(--surface-2);
	border-color: transparent;
}

.command-name {
	font-family: var(--font-mono, monospace);
	font-weight: var(--weight-medium);
}

.command-hint {
	color: var(--muted);
	font-size: var(--text-sm);
}
`;

/** The commands whose name or alias begins with what is typed, hidden ones left out. */
function matchingCommands(
	text: string,
	commands: readonly SlashCommand[],
): SlashCommand[] {
	const query = commandQuery(text);
	if (query === undefined) return [];
	return commands.filter(
		(one) =>
			!one.hidden &&
			[one.name, ...(one.aliases ?? [])].some((name) => name.startsWith(query)),
	);
}

/**
 * The menu of commands above the message box while the text is a slash and the start of a name.
 * The box keeps the focus: the keys go through `keys`, which the box asks first, and a tap picks
 * without taking the focus (so a phone's keyboard stays). ↑ and ↓ move, Enter runs the choice,
 * Tab writes its name into the box, and Esc closes the menu until the text changes. The box
 * never calls `keys` while an input method composes.
 */
export default function CommandMenu(props: {
	text: string;
	commands: readonly SlashCommand[];
	keys: RefObject<((event: KeyboardEvent) => boolean) | undefined>;
	area: RefObject<HTMLTextAreaElement | null>;
	onRun(command: SlashCommand): void;
	onComplete(command: SlashCommand): void;
}) {
	installStyle("command-menu", COMMAND_MENU_CSS);
	const id = useId();
	const found = matchingCommands(props.text, props.commands);
	const [active, setActive] = useState(0);
	const [closedFor, setClosedFor] = useState<string>();
	const shown = found.length > 0 && closedFor !== props.text;
	const at = Math.min(active, found.length - 1);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the first choice is the one at every new text
	useEffect(() => setActive(0), [props.text]);
	// A choice made with the keys stays in view in a long list.
	useEffect(() => {
		document
			.getElementById(`${id}-${at}`)
			?.scrollIntoView?.({ block: "nearest" });
	}, [id, at]);
	// The box asks the menu first; a key it takes, the box leaves alone.
	const { keys, area, onRun, onComplete } = props;
	useEffect(() => {
		keys.current = (event) => {
			const one = found[at];
			if (!shown || !one || event.altKey || event.ctrlKey || event.metaKey)
				return false;
			switch (event.key) {
				case "ArrowDown":
				case "ArrowUp":
					setActive(
						(at + (event.key === "ArrowDown" ? 1 : found.length - 1)) %
							found.length,
					);
					break;
				case "Enter":
					if (event.shiftKey) return false;
					onRun(one);
					break;
				case "Tab":
					if (event.shiftKey) return false;
					onComplete(one);
					break;
				case "Escape":
					setClosedFor(props.text);
					break;
				default:
					return false;
			}
			event.preventDefault();
			return true;
		};
		return () => {
			keys.current = undefined;
		};
	}, [keys, found, at, shown, onRun, onComplete, props.text]);
	// The box names the open list and its choice for a screen reader, which keeps reading the box.
	useEffect(() => {
		const element = area.current;
		if (!element || !shown) return;
		element.setAttribute("aria-controls", `${id}-list`);
		element.setAttribute("aria-activedescendant", `${id}-${at}`);
		return () => {
			element.removeAttribute("aria-controls");
			element.removeAttribute("aria-activedescendant");
		};
	}, [area, shown, id, at]);
	if (!shown) return null;
	return (
		<div className="command-anchor">
			{/* The listbox is driven from the box (aria-activedescendant), so its options are not tab stops. */}
			<div className="command-menu" id={`${id}-list`} role="listbox">
				{found.map((one, index) => (
					<button
						key={one.name}
						type="button"
						id={`${id}-${index}`}
						role="option"
						tabIndex={-1}
						aria-selected={index === at}
						className="command-item"
						// Pressing must not take the focus from the box, or a phone's keyboard closes.
						onPointerDown={(event) => event.preventDefault()}
						onMouseDown={(event) => event.preventDefault()}
						onMouseEnter={() => setActive(index)}
						onClick={() => onRun(one)}
					>
						<span className="command-name">/{one.name}</span>
						<span className="command-hint">{one.description}</span>
					</button>
				))}
			</div>
		</div>
	);
}
