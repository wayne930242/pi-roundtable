import type {
	AvatarState,
	CharacterLook,
	CharacterSpec,
	Expression,
} from "pi-roundtable/characters";
import { memo, useId, useMemo } from "react";
import { suggestionFor } from "../lib/character-spec.ts";
import { type Kit, useKit } from "../lib/kit.ts";
import { useCharacterStyle } from "../lib/look.ts";

/** The suffix that keeps one drawing's clip paths apart from the next one's: lower-case letters and digits only. */
function uidOf(id: string): string {
	return `c${id.toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(0, 16);
}

export interface CharacterProps {
	/** The agent's spec as the page received it; one that does not parse is drawn as the suggestion for `name`. */
	spec: CharacterSpec | undefined;
	look: CharacterLook;
	frame?: "disc" | "shield" | undefined;
	state?: AvatarState | undefined;
	expr?: Expression | undefined;
	/** Pixels, set through the style so the page's CSP stays as it is. */
	size?: number | undefined;
	/** False draws the character standing still. */
	live?: boolean | undefined;
	/** Names the picture for a screen reader; without it the picture is decoration beside the agent's name. */
	label?: string | undefined;
	/** The agent's name, for the suggestion that stands in for a missing or refused spec. */
	name?: string | undefined;
}

/** The elements the kit's output is made of; a drawing with any other element is not injected. */
const ELEMENTS = new Set([
	"svg",
	"g",
	"path",
	"circle",
	"ellipse",
	"rect",
	"clipPath",
]);
/** Attributes the kit never emits: links, inline styles, event handlers, and CSS variables. */
const FORBIDDEN_ATTRIBUTES = /\bhref\s*=|\bstyle\s*=|\bon[a-z]+\s*=|var\(/i;

/** The drawing when it holds only the kit's elements; otherwise an empty host and a console error, never a throw. */
export function checked(svg: string): string {
	const names = [...svg.matchAll(/<\/?([^\s/>]*)/g)].map((m) => m[1] ?? "");
	if (
		names.every((name) => ELEMENTS.has(name)) &&
		!FORBIDDEN_ATTRIBUTES.test(svg)
	)
		return svg;
	console.error("the drawing holds markup the page does not inject");
	return "";
}

function draw(
	kit: Kit,
	props: Pick<
		CharacterProps,
		"spec" | "look" | "frame" | "state" | "expr" | "name" | "label"
	>,
	uid: string,
): string {
	const options = {
		look: props.look,
		frame: props.frame ?? "disc",
		expr: props.expr ?? kit.STATE_EXPRESSION[props.state ?? "idle"],
		uid,
	} as const;
	const owner = { name: props.name ?? props.label ?? "agent" };
	if (props.spec === undefined)
		return checked(kit.composeSvg(suggestionFor(kit, owner), options));
	try {
		return checked(kit.composeSvg(props.spec, options));
	} catch (failure) {
		console.warn(
			`the character of ${owner.name} was refused; drawing a suggestion`,
			failure,
		);
		return checked(kit.composeSvg(suggestionFor(kit, owner), options));
	}
}

/**
 * An agent's character. The drawing is `composeSvg`'s output, which only ever contains the kit's
 * own shapes with literal colors, and it is composed from a spec that has been through the kit's
 * strict check: this is the only place the page injects markup. State motion comes from
 * `characters.css`, keyed on `data-state` of the host.
 */
export const Character = memo(function Character(props: CharacterProps) {
	const uid = uidOf(useId());
	const kit = useKit();
	const { spec, look, frame, state, expr, name, label } = props;
	// The kit loads as a chunk of its own; until it has, the host stands empty at its size.
	const svg = useMemo(
		() =>
			kit
				? draw(kit, { spec, look, frame, state, expr, name, label }, uid)
				: "",
		[kit, spec, look, frame, state, expr, name, label, uid],
	);
	const size = props.size;
	return (
		<span
			className={props.live === false ? "av-host static" : "av-host"}
			data-state={state ?? "idle"}
			{...(label
				? { role: "img", "aria-label": label }
				: { "aria-hidden": true as const })}
			{...(size ? { style: { width: size, height: size } } : {})}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: composeSvg output from a parsed spec, the only injection in the app
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	);
});

/** A character that takes the page's look and scheme, so a caller need not. */
export const PageCharacter = memo(function PageCharacter(
	props: Omit<CharacterProps, "look" | "frame">,
) {
	const { look, frame } = useCharacterStyle();
	return <Character {...props} look={look} frame={frame} />;
});

/** Up to three members' characters overlapping, for a group; static. */
export const CharacterStack = memo(function CharacterStack(props: {
	members: readonly { name: string; spec: CharacterSpec | undefined }[];
	size: number;
}) {
	const shown = props.members.slice(0, 3);
	return (
		<span
			className="av-stack"
			aria-hidden="true"
			style={{
				width: props.size * (1 + (shown.length - 1) * 0.45),
				height: props.size,
			}}
		>
			{shown.map((member, index) => (
				<span
					key={member.name}
					className="av-stack-item"
					style={{
						left: index * props.size * 0.45,
						zIndex: shown.length - index,
					}}
				>
					<PageCharacter
						spec={member.spec}
						name={member.name}
						size={props.size}
						live={false}
					/>
				</span>
			))}
		</span>
	);
});
