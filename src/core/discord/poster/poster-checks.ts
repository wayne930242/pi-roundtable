import {
	type CardPicture,
	DISCORD_LIMITS,
	type DiscordCard,
	type WebhookCardPost,
	type WebhookPost,
} from "./poster.ts";
import { DiscordPosterError } from "./poster-errors.ts";

/** The flag that makes a message a Components V2 message. */
export const COMPONENTS_V2_FLAG = 1 << 15;

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

const SNOWFLAKE = /^[0-9]{17,20}$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function invalid(message: string): DiscordPosterError {
	return new DiscordPosterError("invalid", message);
}

/** Refuses an id that is not a Discord id before it is put in a route. */
export function checkSnowflake(label: string, value: string): string {
	if (!SNOWFLAKE.test(value))
		throw invalid(`${label} is not a Discord id (17 to 20 digits)`);
	return value;
}

function checkMentions(mentions: readonly string[] | undefined): string[] {
	const list = [...new Set(mentions ?? [])];
	if (list.length > DISCORD_LIMITS.mentions)
		throw invalid(`a post may ping at most ${DISCORD_LIMITS.mentions} people`);
	return list.map((id) => checkSnowflake("a mention", id));
}

/** Whether Discord would refuse the name: "discord" or "clyde" in it (any case, full-width too). */
function forbiddenWord(name: string): boolean {
	return /clyde|discord/i.test(name.normalize("NFKC"));
}

/** A webhook's name: 1 to 80 characters, without the words Discord refuses. */
export function checkWebhookName(name: string): string {
	const { min, max } = DISCORD_LIMITS.usernameChars;
	const chars = [...name].length;
	if (chars < min || chars > max)
		throw invalid(`a webhook name is ${min} to ${max} characters`);
	if (forbiddenWord(name))
		throw invalid('a webhook name has no "discord" or "clyde" in it');
	return name;
}

/** The username a post shows: the same rule, and not "everyone" or "here". */
function checkUsername(raw: string): string {
	const username = raw.trim();
	const { min, max } = DISCORD_LIMITS.usernameChars;
	if (username.length < min || username.length > max)
		throw invalid(`a username is ${min} to ${max} characters`);
	if (
		forbiddenWord(username) ||
		["everyone", "here"].includes(username.normalize("NFKC").toLowerCase())
	)
		throw invalid(
			'a username is not "everyone" or "here" and has no "discord" or "clyde" in it',
		);
	return username;
}

/** The body fields every post and edit carries: the text, and the only people it may ping. */
export function checkedText(
	content: string | undefined,
	mentions: readonly string[] | undefined,
): { content?: string; allowed_mentions: { parse: []; users: string[] } } {
	if (content !== undefined && content.length > DISCORD_LIMITS.contentChars)
		throw invalid(
			`a message is at most ${DISCORD_LIMITS.contentChars} characters; split it first`,
		);
	return {
		...(content === undefined ? {} : { content }),
		// parse is empty: no @everyone, role or user is pinged from the text; users names them.
		allowed_mentions: { parse: [], users: checkMentions(mentions) },
	};
}

/** The checked body of a webhook's card post or edit: the card, and for a post the name and picture it shows. */
export function checkedWebhookCard(post: WebhookCardPost) {
	const webhook = checkWebhookName(post.webhook);
	const username = checkUsername(post.username);
	const card = cardBody(post.card);
	return {
		webhook,
		body: {
			username,
			...(isHttps(post.avatarUrl) ? { avatar_url: post.avatarUrl } : {}),
			...card,
		},
	};
}

/** The checked body of a webhook post, its webhook name, and the files to send with it. */
export function checkedPost(post: WebhookPost) {
	const webhook = checkWebhookName(post.webhook);
	const username = checkUsername(post.username);
	const files = post.files ?? [];
	if (files.length > DISCORD_LIMITS.filesPerPost)
		throw invalid(
			`a post carries at most ${DISCORD_LIMITS.filesPerPost} files`,
		);
	const bytes = files.reduce((sum, file) => sum + file.data.byteLength, 0);
	if (bytes > DISCORD_LIMITS.postBytes)
		throw invalid(
			`the files of a post total at most ${DISCORD_LIMITS.postBytes} bytes`,
		);
	if (!post.content && files.length === 0)
		throw invalid("a post needs text or a file");
	return {
		webhook,
		body: {
			username,
			...(isHttps(post.avatarUrl) ? { avatar_url: post.avatarUrl } : {}),
			...checkedText(post.content, post.mentions),
		},
		files,
	};
}

/** The checked wire form of a card's picture: an `https` address, and an alt text of 1 to 1,024 characters when given. */
function checkPicture(label: string, picture: CardPicture) {
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

function isHttps(url: string | undefined): url is string {
	if (url === undefined || url.length > AVATAR_URL_MAX) return false;
	try {
		return new URL(url).protocol === "https:";
	} catch {
		return false;
	}
}

/** Whether the bytes are a PNG no larger than a webhook avatar may be. */
export function checkAvatar(png: Uint8Array): void {
	if (png.byteLength > DISCORD_LIMITS.avatarBytes)
		throw invalid(
			`an avatar is at most ${DISCORD_LIMITS.avatarBytes} bytes, this one is ${png.byteLength}`,
		);
	if (!PNG_SIGNATURE.every((byte, index) => png[index] === byte))
		throw invalid("an avatar is a PNG");
}

/** A channel or thread name: 1 to 100 characters. */
export function checkChannelName(label: string, name: string): void {
	const chars = [...name].length;
	if (chars < 1 || chars > DISCORD_LIMITS.channelNameChars)
		throw invalid(
			`${label} is 1 to ${DISCORD_LIMITS.channelNameChars} characters`,
		);
}

/**
 * The body of a card: a container (with a colour bar when `accent` is set) holding the heading, a
 * divider, one text block per section and a quiet line at the end. It refuses a card whose text
 * would not fit one message, so a caller shortens it first. No mention in it pings.
 */
export function cardBody(card: DiscordCard) {
	const heading = `### ${card.title}`;
	const main = [heading, ...card.sections.filter((section) => section !== "")];
	const footer = card.footer ? [`-# ${card.footer}`] : [];
	const texts = [...main, ...footer];
	const size = texts.reduce((sum, text) => sum + [...text].length, 0);
	if (size > DISCORD_LIMITS.cardTextChars)
		throw invalid(
			`a card holds at most ${DISCORD_LIMITS.cardTextChars} characters of text; shorten it first`,
		);
	if (texts.some((text) => text.trim() === ""))
		throw invalid("a card has no empty text");
	const [first, ...rest] = main;
	const thumbnail = card.thumbnail
		? checkPicture("a card's thumbnail", card.thumbnail)
		: undefined;
	const image = card.image
		? checkPicture("a card's image", card.image)
		: undefined;
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
	return {
		flags: COMPONENTS_V2_FLAG,
		components: [
			{
				type: 17,
				...(card.accent === undefined ? {} : { accent_color: card.accent }),
				components: [
					thumbnail
						? {
								type: 9,
								components: [{ type: 10, content: first }],
								accessory: { type: 11, ...thumbnail },
							}
						: { type: 10, content: first },
					...(texts.length > 1
						? [{ type: 14, divider: true, spacing: 1 }]
						: []),
					...rest.map((content) => ({ type: 10, content })),
					...(image ? [{ type: 12, items: [image] }] : []),
					...footer.map((content) => ({ type: 10, content })),
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
				],
			},
		],
		allowed_mentions: { parse: [] as never[] },
	};
}
