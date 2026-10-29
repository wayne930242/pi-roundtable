import { useState } from "react";
import type { PictureRef } from "../../src/api-types.ts";
import { installHostStyle } from "../lib/host-style.ts";

installHostStyle();

/** Where a picture is served: a stored file, or a person's picture; initials need no address. */
export function pictureSrc(
	picture: PictureRef | undefined,
): string | undefined {
	if (!picture) return undefined;
	if ("file" in picture) return `api/files/${encodeURIComponent(picture.file)}`;
	if ("principal" in picture)
		return `api/people/${encodeURIComponent(picture.principal)}/picture`;
	return undefined;
}

/** One or two letters for a name: a Latin name's first letters, a Chinese name's first character. */
export function initialsOf(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	const first = [...(words[0] ?? "?")][0] ?? "?";
	if (/[\u3400-\u9fff]/.test(first)) return first;
	const last = words.length > 1 ? [...(words.at(-1) ?? "")][0] : undefined;
	return `${first}${last ?? ""}`.toUpperCase();
}

/** A colour for a name, dark enough to carry white letters. */
export function colorOf(name: string): string {
	let hash = 0;
	for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
	return `hsl(${hash} 42% 40%)`;
}

/**
 * A person's, a stored file's or an outside party's picture, in a circle. When the picture cannot be
 * loaded, or none was given, the name's initials stand in.
 */
export function HostPicture(props: {
	picture?: PictureRef | undefined;
	name: string;
	size?: number;
}) {
	const [failed, setFailed] = useState(false);
	const size = props.size ?? 32;
	const src = failed ? undefined : pictureSrc(props.picture);
	const given =
		props.picture && "initials" in props.picture ? props.picture : undefined;
	const letters = given?.initials ?? initialsOf(props.name);
	const color = given?.color ?? colorOf(props.name);
	return (
		<span
			className="hpic"
			style={{
				width: size,
				height: size,
				fontSize: Math.round(size * 0.4),
				...(src ? {} : { background: color }),
			}}
		>
			{src ? (
				<img
					src={src}
					alt=""
					loading="lazy"
					decoding="async"
					onError={() => setFailed(true)}
				/>
			) : (
				<span aria-hidden="true">{letters}</span>
			)}
		</span>
	);
}
