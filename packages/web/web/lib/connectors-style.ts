// The styles of the Connectors page's management. They load with the page, as a constructed
// stylesheet, so the page's own stylesheet (which every visit downloads before it draws) stays small.

import { installStyle } from "./lazy-style.ts";

const CONNECTORS_CSS = `
/* The Connectors page's management: an address never breaks the layout, a bundle's channels sit as rows. */
.connector-url,
.connectors-page .grant .meta {
	overflow-wrap: anywhere;
}

.connectors-page .grants,
.connectors-page .audit {
	display: flex;
	flex-direction: column;
	margin: 0;
	padding: 0;
	list-style: none;
}

.connectors-page .grant {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	padding: var(--space-3) 0;
	border-top: 1px solid var(--border);
}

.connectors-page .grant p {
	margin: 0;
}

.connectors-page .audit {
	gap: var(--space-1);
	font-size: var(--text-sm);
}

.mcp-url {
	font-family: var(--font-mono);
}
`;

export const installConnectorsStyle = (): void =>
	installStyle("connectors", CONNECTORS_CSS);
