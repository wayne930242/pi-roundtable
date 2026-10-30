import { type ConsolePresentation, message } from "../features.ts";
import { escapeHtml } from "../http.ts";
import { iconLinks } from "../page-presentation.ts";

/** The login page's CSP: no script at all, one inline style, its own icon, and the form posts only to this origin. */
export const LOGIN_CSP =
	"default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** The login page, as one server-rendered document with no script; `note` is a line above the field. */
export function loginPage(
	mount: string,
	title: string,
	presentation: ConsolePresentation | undefined,
	note?: string,
): string {
	const say = (source: string) => escapeHtml(message(presentation, source));
	return `<!doctype html>
<html lang="${escapeHtml(presentation?.locale ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${iconLinks(mount, false)}
<title>${escapeHtml(title)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f6f4;color:#1c1c1a}
@media(prefers-color-scheme:dark){body{background:#151514;color:#ecece8}input{background:#222220;color:inherit}}
form{width:min(22rem,calc(100vw - 2rem));display:grid;gap:1rem}
h1{font-size:1.25rem;margin:0}
label{display:grid;gap:.25rem}
input,button{font:inherit;padding:.6rem .75rem;border-radius:.5rem;border:1px solid #8886}
button{cursor:pointer;background:#2d5be3;color:#fff;border-color:transparent}
.note{margin:0;color:#b3261e}
</style>
</head>
<body>
<form method="post" action="${escapeHtml(mount)}/auth/login">
<h1>${escapeHtml(title)}</h1>
${note ? `<p class="note" role="alert">${escapeHtml(note)}</p>` : ""}
<label>${say("Password")}<input type="password" name="password" autocomplete="current-password" autofocus required></label>
<button type="submit">${say("Sign in")}</button>
</form>
</body>
</html>
`;
}
