// The styles of the account pages (notices, onboarding, profile) and the bell. They load with those
// pages, not with the first page, so the first load is as small as it was; each of them imports this.
const STYLES = `
.bell{position:relative}
.bell-count{position:absolute;top:.25rem;right:.15rem;min-width:1.05rem;padding:0 .28rem;border-radius:var(--radius-full);background:var(--warn);color:var(--bg);font-size:.65rem;font-weight:var(--weight-bold);line-height:1.05rem;text-align:center}
.notices{list-style:none;margin:0;padding:0}
.notice[data-urgent]{border-color:var(--warn)}
.steps{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:var(--space-3)}
.steps>li{display:flex;flex-direction:column;align-items:flex-start;gap:var(--space-2);padding-left:var(--space-3);border-left:3px solid var(--border)}
.steps>li[data-done]{border-left-color:var(--accent)}
.who{display:flex;align-items:center;gap:var(--space-3)}
.who-picture{width:3.5rem;height:3.5rem;border-radius:var(--radius-full);object-fit:cover;background:var(--surface-2)}
.who-initial{display:inline-flex;align-items:center;justify-content:center;width:3.5rem;height:3.5rem;border-radius:var(--radius-full);background:var(--accent-soft);color:var(--accent);font-size:1.4rem;font-weight:var(--weight-bold)}
.link-code{display:block;width:fit-content;font-family:var(--mono,ui-monospace,monospace);font-size:1.6rem;letter-spacing:.15em;padding:var(--space-2) var(--space-3);border:1px dashed var(--border);border-radius:var(--radius);user-select:all}
.choice{display:flex;flex-direction:column;gap:var(--space-2);border:0;padding:0;margin:0}
.choice label{display:flex;align-items:center;gap:var(--space-2);min-height:var(--touch)}
.quiet-row{display:flex;flex-wrap:wrap;gap:var(--space-3);align-items:center}
`;

if (
	typeof document !== "undefined" &&
	!document.getElementById("account-styles")
) {
	const style = document.createElement("style");
	style.id = "account-styles";
	style.textContent = STYLES;
	document.head.append(style);
}

export {};
