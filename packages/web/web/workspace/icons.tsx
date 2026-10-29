import type { ReactNode } from "react";
import { Icon, type IconName } from "../components/icons.tsx";

// The files pane's own drawings, kept with it so the page's first download does not carry them.
const PATHS = {
	folder:
		"M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
	"folder-plus":
		"M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7ZM12 10v6M9 13h6",
	"file-plus": "M6 3h9l4 4v14H6zM14 3v5h5M12 12v6M9 15h6",
} as const;

type Own = keyof typeof PATHS;

const isOwn = (name: IconName | Own): name is Own => name in PATHS;

/** An icon of the page's set, or one of the pane's own. */
export function Glyph(props: {
	name: IconName | Own;
	size?: number;
	className?: string;
}): ReactNode {
	const { name, size = 20, className } = props;
	if (!isOwn(name))
		return (
			<Icon name={name} size={size} {...(className ? { className } : {})} />
		);
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			fill="none"
			stroke="currentColor"
			strokeWidth={1.8}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
			{...(className ? { className } : {})}
		>
			<path d={PATHS[name]} />
		</svg>
	);
}
