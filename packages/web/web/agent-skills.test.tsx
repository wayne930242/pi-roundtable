import { expect, spyOn, test } from "bun:test";
import {
	all,
	button,
	open,
	page,
	q,
	settle,
	setupAgentSheet,
	skillGroups,
	skillList,
	skills,
} from "./agent-sheet-fixture.tsx";
import { openAgentSheet } from "./lib/agent-sheet.ts";
import { ApiFailure } from "./lib/api.ts";
import { editApi } from "./lib/edit-api.ts";
import { teamApi } from "./lib/team-api.ts";

setupAgentSheet();

test("the sheet lists the host's skills: the built-in one as a chip that stays, the others to add, each change saved as the server says", async () => {
	const set = spyOn(teamApi, "setSkills").mockResolvedValue(
		skillList(["kit-do"]),
	);
	try {
		await open();
		expect(skills).toHaveBeenCalledWith("scout");
		const chips = () =>
			q('section[aria-label="Skills"] .skill-chips')?.textContent;
		expect(chips()).toBe("1 carried1 built in");
		// Only what it does not carry is listed, with a control to add it.
		const rows = all('section[aria-label="Skills"] .skill-rows li');
		expect(rows.map((one) => one.querySelector("strong")?.textContent)).toEqual(
			["kit-do"],
		);
		const add = q<HTMLButtonElement>(
			'section[aria-label="Skills"] button[aria-label="kit-do"]',
		);
		expect(add?.getAttribute("aria-pressed")).toBe("false");
		await page.click(add);
		await page.act(() => settle(40));
		expect(set).toHaveBeenCalledWith("scout", { add: ["kit-do"] });
		expect(chips()).toBe("2 carried1 built inkit-do");
		expect(q('section[aria-label="Skills"] .skill-rows')).toBeNull();
		// Its chip takes it off again.
		set.mockResolvedValue(skillList());
		await page.click(
			q('section[aria-label="Skills"] button[aria-label="Remove kit-do"]'),
		);
		await page.act(() => settle(40));
		expect(set).toHaveBeenLastCalledWith("scout", { remove: ["kit-do"] });
	} finally {
		set.mockRestore();
	}
});

/** Opens the sheet without waiting for the creator's chunk, until the skills have come. */
async function openAtSkills(skills: boolean) {
	await open({ skills, creator: false });
	for (
		let waited = 0;
		waited < 3000 && !q('section[aria-label="Skills"]');
		waited += 40
	)
		await page.act(() => settle(40));
}

test("Skills opens the sheet scrolled to the skills, titled with how many the knight carries", async () => {
	const scrolled: Element[] = [];
	const original = Element.prototype.scrollIntoView;
	Element.prototype.scrollIntoView = function (this: Element) {
		scrolled.push(this);
	};
	const set = spyOn(teamApi, "setSkills").mockResolvedValue(
		skillList(["kit-do"]),
	);
	try {
		await openAtSkills(true);
		const section = q('section[aria-label="Skills"]');
		expect(section).not.toBeNull();
		expect(scrolled).toEqual([section as Element]);
		expect(document.activeElement).toBe(section);
		// The built-in one counts: it is carried.
		expect(section?.querySelector("h3")?.textContent).toBe("Skills (1)");
		await page.click(
			q('section[aria-label="Skills"] button[aria-label="kit-do"]'),
		);
		await page.act(() => settle(40));
		expect(q('section[aria-label="Skills"] h3')?.textContent).toBe(
			"Skills (2)",
		);
	} finally {
		Element.prototype.scrollIntoView = original;
		set.mockRestore();
	}
});

test("Edit knight does not scroll to the skills; Skills after it for the same knight does", async () => {
	const scrolled: Element[] = [];
	const original = Element.prototype.scrollIntoView;
	Element.prototype.scrollIntoView = function (this: Element) {
		scrolled.push(this);
	};
	try {
		await openAtSkills(false);
		expect(q('section[aria-label="Skills"]')).not.toBeNull();
		expect(scrolled).toHaveLength(0);
		await page.act(() => openAgentSheet("scout", { skills: true }));
		await page.act(() => settle(80));
		expect(scrolled.map((one) => one.getAttribute("aria-label"))).toEqual([
			"Skills",
		]);
	} finally {
		Element.prototype.scrollIntoView = original;
	}
});

test("a refused skill change shows the server's words and leaves the switch where it was", async () => {
	const set = spyOn(teamApi, "setSkills").mockRejectedValue(
		new Error("Unknown skills: kit-do."),
	);
	try {
		await open();
		await page.click(
			q('section[aria-label="Skills"] button[aria-label="kit-do"]'),
		);
		await page.act(() => settle(40));
		expect(document.body.textContent).toContain("Unknown skills: kit-do.");
		expect(
			q(
				'section[aria-label="Skills"] button[aria-label="kit-do"]',
			)?.getAttribute("aria-pressed"),
		).toBe("false");
	} finally {
		set.mockRestore();
	}
});

test("a skill group's switch says what it lacks, asks first, switches on only the missing skills and switches them off again", async () => {
	skillGroups.mockResolvedValue({
		groups: [
			{ name: "basics", description: "Basics.", skills: ["writing-skills"] },
			{
				name: "coding",
				description: "Coding.",
				skills: ["writing-skills", "kit-do"],
			},
		],
	});
	const apply = spyOn(editApi, "applySkillGroup").mockImplementation(
		async (_group, _agent, on = true) => {
			skills.mockResolvedValue(skillList(on ? ["kit-do"] : []));
			return on
				? { added: ["kit-do"], removed: [] }
				: { added: [], removed: ["kit-do"] };
		},
	);
	try {
		await open({ creator: false });
		await page.act(() => settle(80));
		const toggle = (group: string) =>
			q<HTMLButtonElement>(
				`.skill-apply button[aria-label="Skill group ${group}"]`,
			);
		const row = (group: string) => toggle(group)?.closest(".skill-apply");
		const filter = (group: string) =>
			all<HTMLButtonElement>(".skill-filters button").find(
				(one) => one.textContent === group,
			) ?? null;
		// A group's switch shows once the group is picked as the list's filter.
		expect(q(".skill-apply")).toBeNull();
		await page.click(filter("basics"));
		expect(filter("basics")?.getAttribute("aria-pressed")).toBe("true");
		expect(row("basics")?.textContent).toContain("Carries all of it.");
		expect(toggle("basics")?.getAttribute("aria-checked")).toBe("true");
		// Only built-in skills: there is nothing to switch off.
		expect(toggle("basics")?.disabled).toBe(true);
		await page.click(filter("coding"));
		expect(toggle("basics")).toBeNull();
		expect(row("coding")?.textContent).toContain("Lacks 1: kit-do");
		expect(toggle("coding")?.getAttribute("aria-checked")).toBe("false");
		await page.click(toggle("coding"));
		const confirmOn = q<HTMLDialogElement>(
			'dialog[aria-label="Switch this skill group on?"]',
		);
		expect(confirmOn?.open).toBe(true);
		expect(confirmOn?.textContent).toContain("scout will also carry: kit-do.");
		expect(apply).not.toHaveBeenCalled();
		await page.click(button("Switch on"));
		await page.act(() => settle(80));
		expect(apply).toHaveBeenCalledWith("coding", "scout", true);
		expect(document.body.textContent).toContain("Switched on: kit-do");
		expect(
			q('section[aria-label="Skills"] button[aria-label="Remove kit-do"]'),
		).not.toBeNull();
		expect(toggle("coding")?.getAttribute("aria-checked")).toBe("true");
		await page.click(toggle("coding"));
		const confirmOff = q<HTMLDialogElement>(
			'dialog[aria-label="Switch this skill group off?"]',
		);
		expect(confirmOff?.open).toBe(true);
		expect(confirmOff?.textContent).toContain(
			"scout will no longer carry: kit-do.",
		);
		await page.click(button("Switch off"));
		await page.act(() => settle(80));
		expect(apply).toHaveBeenLastCalledWith("coding", "scout", false);
		expect(document.body.textContent).toContain("Switched off: kit-do");
		expect(toggle("coding")?.getAttribute("aria-checked")).toBe("false");
	} finally {
		apply.mockRestore();
	}
});

test("without skill groups the sheet shows no group filters or switches", async () => {
	await open({ creator: false });
	await page.act(() => settle(80));
	expect(q('section[aria-label="Skills"]')).not.toBeNull();
	expect(q(".skill-apply")).toBeNull();
	expect(all(".skill-filters button").map((one) => one.textContent)).toEqual([
		"Show carried",
	]);
});

test("a host without skills shows no skills section", async () => {
	skills.mockRejectedValue(
		new ApiFailure("This host has no skills.", undefined, 404),
	);
	await open();
	expect(q('section[aria-label="Skills"]')).toBeNull();
	expect(q(".agent-sheet .failure")).toBeNull();
});
