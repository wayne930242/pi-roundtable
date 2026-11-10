import { useState } from "react";
import type { PictureRef } from "../../src/api-types.ts";
import { installStyle } from "../lib/lazy-style.ts";
import { usePersonKnight } from "../lib/person-knight.ts";
import { PICTURE_CSS } from "../lib/picture-style.ts";
import { PageCharacter } from "./character.tsx";

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
	for (const char of name)
		hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 360;
	return `hsl(${hash} 42% 40%)`;
}

/** The pictures that could not be loaded, so one 404 is all a page life spends on a source. */
const noPicture = new Set<string>();

/** Records that a person has no account picture, where the page already knows it. */
export function knownWithoutPicture(principal: string): void {
	const src = pictureSrc({ principal });
	if (src) noPicture.add(src);
}

interface PictureProps {
	picture?: PictureRef | undefined;
	name: string;
	size?: number | undefined;
}

/**
 * A person as the app shows them: the knight they made for themselves, on the page's badge and
 * standing still; without one their account picture, and the name's initials when there is none.
 * Until the page knows whether they have a knight, the place is held empty at its size.
 */
export function PersonPicture(props: {
	principal: string;
	name: string;
	size?: number | undefined;
}) {
	installStyle("picture", PICTURE_CSS);
	const knight = usePersonKnight(props.principal);
	const size = props.size ?? 32;
	if (knight === null)
		return (
			<Circle
				picture={{ principal: props.principal }}
				name={props.name}
				size={size}
			/>
		);
	return (
		<span
			className="hpic"
			{...(knight ? { "data-knight": "" } : { "data-wait": "" })}
			style={{ width: size, height: size }}
		>
			{knight ? (
				<PageCharacter
					spec={knight}
					name={props.principal}
					size={size}
					live={false}
				/>
			) : null}
		</span>
	);
}

/**
 * A person's, a stored file's or an outside party's picture, in a circle. A person is drawn by
 * `PersonPicture`. When the picture cannot be loaded, or none was given, the name's initials stand in.
 */
export function HostPicture(props: PictureProps) {
	const { picture } = props;
	return picture && "principal" in picture ? (
		<PersonPicture
			principal={picture.principal}
			name={props.name}
			size={props.size}
		/>
	) : (
		<Circle {...props} />
	);
}

function Circle(props: PictureProps) {
	installStyle("picture", PICTURE_CSS);
	const [, redraw] = useState(0);
	const size = props.size ?? 32;
	const address = pictureSrc(props.picture);
	const src = address && !noPicture.has(address) ? address : undefined;
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
					onError={() => {
						noPicture.add(src);
						redraw((n) => n + 1);
					}}
				/>
			) : (
				<span aria-hidden="true">{letters}</span>
			)}
		</span>
	);
}
