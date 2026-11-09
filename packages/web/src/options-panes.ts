import { OWNER_ONLY_PANES, PANES, type PaneName } from "./api-types.ts";
import { fail } from "./options-common.ts";
import type { TierPanes, WebConsoleOptions } from "./options-types.ts";

const DEFAULT_OWNER_PANES: readonly PaneName[] = [
	"rooms",
	"table",
	"workspace",
	"overview",
	"schedules",
	"conversations",
	"notes",
	"presets",
	"webhooks",
];

/** The panes a member is served by default, of those the owners have. */
const DEFAULT_MEMBER_PANES: readonly PaneName[] = [
	"rooms",
	"conversations",
	"notes",
	"schedules",
	"profile",
];

function checkPaneList(panes: readonly PaneName[], label: string): PaneName[] {
	if (!Array.isArray(panes)) fail(`${label} must be a list of panes`);
	if (panes.length === 0) fail(`${label} is empty; serve at least one pane`);
	for (const pane of panes)
		if (!PANES.includes(pane))
			fail(
				`unknown pane ${JSON.stringify(pane)} in ${label}; the panes are ${PANES.join(", ")}`,
			);
	if (new Set(panes).size !== panes.length) fail(`${label} lists a pane twice`);
	return [...panes];
}

/** The panes of the owners, as before: what the other panes need of them is checked here. */
function checkOwnerPanes(panes: readonly PaneName[]): PaneName[] {
	const list = checkPaneList(panes, "panes");
	for (const pane of ["schedules", "workspace", "presets", "webhooks"] as const)
		if (list.includes(pane) && !list.includes("rooms"))
			fail(`the ${pane} pane needs the rooms pane, which serves its API`);
	if (list.includes("table") && !list.includes("rooms"))
		fail("the table pane needs the rooms pane, whose agents it seats");
	return list;
}

interface CheckedPanes {
	owner: PaneName[];
	admin: PaneName[];
	member: PaneName[];
	given: boolean;
}

export function checkPanes(
	panes: WebConsoleOptions["panes"],
	admission: "owners" | "access",
): CheckedPanes {
	const tiered =
		panes !== undefined && !Array.isArray(panes)
			? (panes as TierPanes)
			: undefined;
	if (tiered && (typeof tiered !== "object" || tiered === null))
		fail("panes must be a list, or { owner, admin?, member }");
	const owner = checkOwnerPanes(
		tiered
			? tiered.owner
			: ((panes as readonly PaneName[] | undefined) ?? [
					...DEFAULT_OWNER_PANES,
					...(admission === "access" ? (["profile"] as const) : []),
				]),
	);
	if (!tiered || admission !== "access") {
		if (tiered && admission === "owners")
			fail(
				'panes names panes per tier, but only admission "access" admits anyone but owners',
			);
		const member =
			admission === "access"
				? DEFAULT_MEMBER_PANES.filter((pane) => owner.includes(pane))
				: [];
		return { owner, admin: member, member, given: panes !== undefined };
	}
	const member = checkPaneList(tiered.member, "panes.member");
	const admin = tiered.admin
		? checkPaneList(tiered.admin, "panes.admin")
		: [...member];
	for (const [label, list] of [
		["panes.member", member],
		["panes.admin", admin],
	] as const) {
		for (const pane of list) {
			if ((OWNER_ONLY_PANES as readonly string[]).includes(pane))
				fail(
					`${label} names the ${pane} pane, which only owners are served: it shows the whole host`,
				);
			if (!owner.includes(pane))
				fail(
					`${label} names the ${pane} pane, which the owners' panes do not have; the pane's API is served for the owners' list`,
				);
		}
		// A member's table seats the host rooms they may list, which the rooms pane brings with its socket.
		if (list.includes("table") && !list.includes("rooms"))
			fail(
				`${label} names the table pane without the rooms pane, whose host rooms it seats`,
			);
	}
	return { owner, admin, member, given: true };
}
