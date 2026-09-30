/** Links whose preview is the point: a GIF or a video shows inline. */
const PREVIEWED_HOSTS = [
	"giphy.com",
	"media.giphy.com",
	"tenor.com",
	"youtube.com",
	"www.youtube.com",
	"youtu.be",
];

const URL_CHARS = "[A-Za-z0-9\\-._~:/?#\\[\\]@!$&'*+,;=%]+";
const BARE_URL = new RegExp(`(^|[^<(])(https?://${URL_CHARS})`, "g");
const MARKDOWN_URL = new RegExp(`\\]\\((https?://${URL_CHARS})\\)`, "g");

function keepsPreview(url: string): boolean {
	try {
		return PREVIEWED_HOSTS.includes(new URL(url).hostname);
	} catch {
		return true;
	}
}

/**
 * Wraps links in `<…>` so Discord does not unfold a preview card for each cited source.
 * GIF and video links keep their preview. Trailing sentence punctuation stays outside.
 */
export function quietLinks(text: string): string {
	const bare = text.replace(BARE_URL, (match, before: string, raw: string) => {
		const url = raw.replace(/[.,;:!?'\]]+$/, "");
		if (keepsPreview(url)) return match;
		return `${before}<${url}>${raw.slice(url.length)}`;
	});
	return bare.replace(MARKDOWN_URL, (match, url: string) =>
		keepsPreview(url) ? match : `](<${url}>)`,
	);
}
