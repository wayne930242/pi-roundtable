import {
	type CardPicture,
	DISCORD_LIMITS,
	type DiscordCard,
} from "./poster.ts";
import { invalid } from "./poster-errors.ts";

/** The longest picture address a post carries. */
const AVATAR_URL_MAX = 2_048;

/** The longest address Discord accepts on a link button. */
const LINK_BUTTON_URL_MAX = 512;

/** The longest alt text Discord takes for a thumbnail or a gallery item. */
const PICTURE_DESCRIPTION_MAX = 1_024;

/** Discord's style number for a button that opens an address. */
const LINK_BUTTON_STYLE = 5;

const BUTTON_STYLES = {
	primary: 1,
	secondary: 2,
	success: 3,
	danger: 4,
} as const;

export function isHttps(url: string | undefined): url is string {
	if (url === undefined || url.length > AVATAR_URL_MAX) return false;
	try {
		return new URL(url).protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * The checked, normalised address of a card's `titleUrl`: absolute `http` or `https`, at most 2,048
 * characters once normalised. Non-ASCII characters are percent-encoded (the host as punycode), and
 * so are `(` and `)`, which would end a Markdown link early.
 */
export function checkTitleUrl(url: string): string {
	let href: string;
	try {
		const parsed = new URL(url);
		if (
			url !== url.trim() ||
			!(parsed.protocol === "https:" || parsed.protocol === "http:")
		)
			throw new Error("not http(s)");
		href = parsed.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
	} catch {
		throw invalid(
			`a card's titleUrl is an absolute http or https address of at most ${AVATAR_URL_MAX} characters`,
		);
	}
	if (href.length > AVATAR_URL_MAX)
		throw invalid(
			`a card's titleUrl is an absolute http or https address of at most ${AVATAR_URL_MAX} characters`,
		);
	return href;
}

/** A card title as the label of a Markdown link: `\`, `[` and `]` escaped, so the label cannot end the link early. */
export function linkLabel(title: string): string {
	return title.replace(/[\\[\]]/g, "\\$&");
}

/** The checked wire form of a card's picture: an `https` address, and an alt text of 1 to 1,024 characters when given. */
export function checkPicture(label: string, picture: CardPicture) {
	if (!(isHttps(picture.url) && picture.url === picture.url.trim()))
		throw invalid(
			`${label} has an https address of at most ${AVATAR_URL_MAX} characters`,
		);
	const { description } = picture;
	if (
		description !== undefined &&
		(description === "" || [...description].length > PICTURE_DESCRIPTION_MAX)
	)
		throw invalid(
			`${label} has a description of 1 to ${PICTURE_DESCRIPTION_MAX} characters`,
		);
	return {
		media: { url: picture.url },
		...(description === undefined ? {} : { description }),
	};
}

/** Refuses a card whose text would not fit one message, so a caller shortens it first. */
export function checkCardTextSize(texts: readonly string[]): void {
	const size = texts.reduce((sum, text) => sum + [...text].length, 0);
	if (size > DISCORD_LIMITS.cardTextChars)
		throw invalid(
			`a card holds at most ${DISCORD_LIMITS.cardTextChars} characters of text; shorten it first`,
		);
	if (texts.some((text) => text.trim() === ""))
		throw invalid("a card has no empty text");
}

/**
 * The checked action rows of a card, in Discord's wire form: a row for each menu, then one row of
 * the buttons and link buttons. A Components V2 container and a legacy message hold the same rows.
 */
export function cardRows(card: DiscordCard) {
	const buttons = card.buttons ?? [];
	const links = card.links ?? [];
	if (buttons.length + links.length > DISCORD_LIMITS.cardButtons)
		throw invalid(`a card holds at most ${DISCORD_LIMITS.cardButtons} buttons`);
	for (const link of links) {
		if (link.label === "" || [...link.label].length > 80)
			throw invalid("a link button has a label of 1 to 80 characters");
		if (
			!link.url.startsWith("https://") ||
			[...link.url].length > LINK_BUTTON_URL_MAX
		)
			throw invalid(
				`a link button has an https address of at most ${LINK_BUTTON_URL_MAX} characters`,
			);
	}
	const selects = card.selects ?? [];
	for (const select of selects) {
		if (
			select.customId === "" ||
			[...select.customId].length > 100 ||
			select.placeholder === "" ||
			[...select.placeholder].length > 150 ||
			select.options.length < 1 ||
			select.options.length > DISCORD_LIMITS.selectOptions ||
			select.options.some(
				(option) =>
					option.label === "" ||
					[...option.label].length > 100 ||
					option.value === "" ||
					[...option.value].length > 100,
			)
		)
			throw invalid(
				"a menu has an id of 1 to 100 characters, a placeholder of 1 to 150 and 1 to 25 choices of 1 to 100 characters",
			);
	}
	for (const button of buttons) {
		if (
			button.customId === "" ||
			[...button.customId].length > 100 ||
			button.label === "" ||
			[...button.label].length > 80
		)
			throw invalid(
				"a button has an id of 1 to 100 characters and a label of 1 to 80",
			);
	}
	return [
		...selects.map((select) => ({
			type: 1,
			components: [
				{
					type: 3,
					custom_id: select.customId,
					placeholder: select.placeholder,
					min_values: 1,
					max_values: 1,
					options: select.options.map((option) => ({
						label: option.label,
						value: option.value,
						...(option.selected ? { default: true } : {}),
					})),
				},
			],
		})),
		...(buttons.length + links.length > 0
			? [
					{
						type: 1,
						components: [
							...buttons.map((button) => ({
								type: 2,
								style: BUTTON_STYLES[button.style],
								label: button.label,
								custom_id: button.customId,
								...(button.disabled ? { disabled: true } : {}),
							})),
							...links.map((link) => ({
								type: 2,
								style: LINK_BUTTON_STYLE,
								label: link.label,
								url: link.url,
							})),
						],
					},
				]
			: []),
	];
}
