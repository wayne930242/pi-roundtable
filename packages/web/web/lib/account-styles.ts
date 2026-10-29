// The styles of the account pages and the bell sit in a sheet of their own that the first of them
// links, so the first load does not carry them; each of them imports this. A sheet, not an inline
// `<style>`: the page's CSP allows only styles from its own origin.
import sheet from "../styles/account.css" with { type: "file" };

if (
	typeof document !== "undefined" &&
	!document.getElementById("account-styles")
) {
	const link = document.createElement("link");
	link.id = "account-styles";
	link.rel = "stylesheet";
	link.href = new URL(sheet, import.meta.url).href;
	document.head.append(link);
}
