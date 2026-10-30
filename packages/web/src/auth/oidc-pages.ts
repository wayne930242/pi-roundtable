import { type ConsolePresentation, message } from "../features.ts";
import { escapeHtml } from "../http.ts";
import { iconLinks } from "../page-presentation.ts";
import { LOGIN_CSP } from "./login-page.ts";

/** What a page of the sign-in flow tells, and the link it offers. */
type Notice = "signed-out" | "failed" | "not-allowed";

/**
 * The static pages of the sign-in flow: logged out, a sign-in that did not complete, and a person
 * the app does not admit. They carry no script and no detail of why: the reason goes to the log.
 */
export function oidcPage(
	notice: Notice,
	mount: string,
	title: string,
	presentation: ConsolePresentation | undefined,
	status: number,
): Response {
	const say = (source: string) => escapeHtml(message(presentation, source));
	const text =
		notice === "signed-out"
			? say("You are signed out.")
			: notice === "not-allowed"
				? say("This account is not allowed to use this app.")
				: say("Sign-in did not complete.");
	const link = notice === "signed-out" ? say("Sign in") : say("Try again");
	const html = `<!doctype html>
<html lang="${escapeHtml(presentation?.locale ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
${iconLinks(mount, false)}
<title>${escapeHtml(title)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f6f4;color:#1c1c1a}
@media(prefers-color-scheme:dark){body{background:#151514;color:#ecece8}}
main{width:min(22rem,calc(100vw - 2rem));display:grid;gap:1rem}
h1{font-size:1.25rem;margin:0}
p{margin:0}
a{font:inherit;padding:.6rem .75rem;border-radius:.5rem;background:#2d5be3;color:#fff;text-decoration:none;text-align:center}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<p role="${notice === "signed-out" ? "status" : "alert"}">${text}</p>
<a href="${escapeHtml(mount)}/login">${link}</a>
</main>
</body>
</html>
`;
	return new Response(html, {
		status,
		headers: {
			"content-type": "text/html;charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": LOGIN_CSP,
		},
	});
}
