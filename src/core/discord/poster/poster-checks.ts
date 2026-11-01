import {
	DISCORD_LIMITS,
	type DiscordCard,
	type WebhookCardPost,
	type WebhookPost,
} from "./poster.ts";
import {
	cardRows,
	checkCardTextSize,
	checkPicture,
	isHttps,
} from "./poster-card-parts.ts";
import { invalid } from "./poster-errors.ts";
import { legacyCardBody } from "./poster-legacy-card.ts";

export { invalid };

/** The flag that makes a message a Components V2 message. */
export const COMPONENTS_V2_FLAG = 1 << 15;

const SNOWFLAKE = /^[0-9]{17,20}$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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
 * The body of a card. A card with a `preview` is a legacy message (see `legacyCardBody`); any
 * other is a Components V2 message: a container (with a colour bar when `accent` is set) holding
 * the heading, a divider, one text block per section and a quiet line at the end. It refuses a
 * card whose text would not fit one message, so a caller shortens it first. No mention in it pings.
 */
export function cardBody(card: DiscordCard) {
	if (card.preview !== undefined)
		return legacyCardBody({ ...card, preview: card.preview });
	const heading = `### ${card.title}`;
	const main = [heading, ...card.sections.filter((section) => section !== "")];
	const footer = card.footer ? [`-# ${card.footer}`] : [];
	const texts = [...main, ...footer];
	checkCardTextSize(texts);
	const [first, ...rest] = main;
	const thumbnail = card.thumbnail
		? checkPicture("a card's thumbnail", card.thumbnail)
		: undefined;
	const image = card.image
		? checkPicture("a card's image", card.image)
		: undefined;
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
					...cardRows(card),
				],
			},
		],
		allowed_mentions: { parse: [] as never[] },
	};
}
