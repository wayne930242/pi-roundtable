import { memo, useState } from "react";

/** A hue from a name, so the same agent always has the same fallback color. */
function hueOf(name: string): number {
	let hash = 0;
	for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
	return hash;
}

const initialsOf = (name: string) =>
	Array.from(name.trim()).slice(0, 2).join("").toUpperCase() || "?";

/** An agent's picture, or its initials on a tint of its own when there is none or it did not load. */
export const Avatar = memo(function Avatar(props: {
	name: string;
	src?: string | undefined;
	size?: number;
}) {
	const [failed, setFailed] = useState(false);
	const size = props.size ?? 40;
	return (
		<span
			className="avatar"
			style={{
				width: size,
				height: size,
				fontSize: size * 0.38,
				["--hue" as string]: hueOf(props.name),
			}}
		>
			{props.src && !failed ? (
				<img
					src={props.src}
					alt=""
					width={size}
					height={size}
					loading="lazy"
					decoding="async"
					onError={() => setFailed(true)}
				/>
			) : (
				<span aria-hidden="true">{initialsOf(props.name)}</span>
			)}
		</span>
	);
});
