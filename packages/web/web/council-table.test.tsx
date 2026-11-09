import { expect, spyOn, test } from "bun:test";
import {
	agent,
	all,
	button,
	config,
	councilPage,
	everyone,
	group,
	load,
	page,
	profileOf,
	q,
	sent,
	settle,
	show,
	tickOf,
	ticks,
	typeInto,
} from "./council-fixture.tsx";
import { api } from "./lib/api.ts";
import { store } from "./lib/app-store.ts";
import { ConfigContext } from "./lib/config.ts";
import { chooseCouncil, startingTicks } from "./lib/council.ts";
import { seatMenuOf } from "./lib/menus.ts";
import { teamApi } from "./lib/team-api.ts";
import { TablePage } from "./pages/table.tsx";

councilPage();

test("with no group at all the table says there is no council, and the sheet starts from the unmuted agents", async () => {
	load(
		everyone.map((one) =>
			one.name === "scout" ? { ...one, muted: true as const } : one,
		),
	);
	await show();
	expect(page.container.textContent).toContain("No council yet");
	expect(all("g.seat")).toHaveLength(0);
	await page.click(button("Pick who sits") ?? null);
	await settle();
	const on = ticks().filter((box) => box.checked);
	// eight of the eight unmuted, the coordinator first; the muted one is not ticked
	expect(on).toHaveLength(8);
	expect(tickOf("scout")?.checked).toBe(false);
	expect(q(".council-count")?.textContent).toContain("8 of 8 picked");
	expect(q(".council-count")?.textContent).toContain("At most 8 knights");
	// a council is made by naming it
	expect(button("Make council")?.disabled).toBe(true);
});

test("a temp knight is not in the tick list, the starting ticks or the seats of the table", async () => {
	const helper = agent("scout-1", {
		helper: { parent: "app:agent.scout", parentName: "scout" },
	});
	expect(startingTicks([...everyone.slice(0, 3), helper])).toEqual([
		"guide",
		"scout",
		"mason",
	]);
	load([...everyone.slice(0, 3), helper]);
	await show();
	await page.click(button("Pick who sits") ?? null);
	await settle();
	expect(tickOf("scout-1")).toBeUndefined();
	expect(ticks()).toHaveLength(3);
});

test("saving the first council makes a group, puts it on the table and its address", async () => {
	load(everyone.slice(0, 3));
	const create = spyOn(teamApi, "createGroup").mockImplementation(
		async (made) => {
			load([...everyone.slice(0, 3), group(made.name, made.members)]);
			return profileOf(made.name, made.members, made.host);
		},
	);
	// once the new group is on the table the sheet, still closing, reads its profile
	const profile = spyOn(teamApi, "group").mockImplementation(async (name) =>
		profileOf(name, ["guide", "scout", "mason"]),
	);
	try {
		await show();
		await page.click(button("Pick who sits") ?? null);
		await settle();
		await typeInto(
			q<HTMLInputElement>(
				'.council-sheet input[type="text"], .council-sheet label input:not([type])',
			),
			"Night Watch",
		);
		await page.click(button("Make council") ?? null);
		await settle();
		expect(create).toHaveBeenCalledWith({
			name: "night-watch",
			displayName: "Night Watch",
			members: ["guide", "scout", "mason"],
			host: "guide",
		});
		expect(decodeURIComponent(window.location.hash)).toBe(
			"#/table/night-watch",
		);
		expect(window.localStorage.getItem("rt-table-council")).toBe(
			"app:group.night-watch",
		);
	} finally {
		profile.mockRestore();
		create.mockRestore();
	}
});

test("a group is a council: the chip names it, only its members sit, and picking another switches the table", async () => {
	load([
		...everyone,
		group("crew", ["guide", "scout", "mason"]),
		group("ops", ["cook", "nurse"]),
	]);
	const profile = spyOn(teamApi, "group").mockResolvedValue(
		profileOf("crew", ["guide", "scout", "mason"]),
	);
	try {
		await show();
		expect(button("Crew ▾")).toBeDefined();
		expect(all("g.seat")).toHaveLength(3);
		await page.click(button("Crew ▾") ?? null);
		await settle();
		const rows = all<HTMLButtonElement>(".council-row");
		expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(
			["Crew", "Ops"],
		);
		expect(rows[0]?.getAttribute("aria-current")).toBe("true");
		await page.click(rows[1] ?? null);
		expect(decodeURIComponent(window.location.hash)).toBe("#/table/ops");
		expect(window.localStorage.getItem("rt-table-council")).toBe(
			"app:group.ops",
		);
		expect(button("Ops ▾")).toBeDefined();
		// the seats that leave glide out of the ring before they are gone
		for (let tries = 0; tries < 30 && all("g.seat").length !== 2; tries += 1)
			await settle();
		expect(
			all("g.seat").map((seat) => seat.getAttribute("aria-label")),
		).toEqual(["cook (idle)", "nurse (idle)"]);
	} finally {
		profile.mockRestore();
	}
});

test("the council this device chose is what the table shows when the address names none", async () => {
	load([
		...everyone,
		group("crew", ["guide", "scout"]),
		group("ops", ["cook", "nurse", "pilot"]),
	]);
	chooseCouncil("app:group.ops");
	await show();
	expect(all("g.seat")).toHaveLength(3);
});

test("ticking edits the council in place: the ninth tick is refused, and Done sends the members in the order ticked", async () => {
	load([...everyone, group("crew", ["guide", "scout", "mason"])]);
	const profile = spyOn(teamApi, "group").mockResolvedValue(
		profileOf("crew", ["guide", "scout", "mason"], "scout"),
	);
	const update = spyOn(teamApi, "updateGroup").mockResolvedValue(
		profileOf("crew", ["guide", "scout", "mason", "cook", "nurse"]),
	);
	try {
		await show();
		await page.click(button("Crew ▾") ?? null);
		await settle();
		expect(q(".council-count")?.textContent).toContain("3 of 8 picked");
		expect(button("Done")?.disabled).toBe(true);
		// the council's host shows as pressed
		await page.click(tickOf("nurse") ?? null);
		await page.click(tickOf("cook") ?? null);
		expect(q(".council-count")?.textContent).toContain("5 of 8 picked");
		for (const name of ["pilot", "smith", "baker"])
			await page.click(tickOf(name) ?? null);
		expect(q(".council-count")?.textContent).toContain("At most 8 knights");
		expect(tickOf("clerk")?.disabled).toBe(true);
		await page.click(tickOf("baker") ?? null);
		await page.click(tickOf("smith") ?? null);
		await page.click(tickOf("pilot") ?? null);
		await page.click(button("Done") ?? null);
		await settle();
		// no host change: the council's host is still one of its members
		expect(update).toHaveBeenCalledWith("crew", {
			members: ["guide", "scout", "mason", "nurse", "cook"],
		});
	} finally {
		update.mockRestore();
		profile.mockRestore();
	}
});

test("Save as a new council keeps the old one and makes another group from the ticks", async () => {
	load([...everyone, group("crew", ["guide", "scout"])]);
	const profile = spyOn(teamApi, "group").mockResolvedValue(
		profileOf("crew", ["guide", "scout"]),
	);
	const update = spyOn(teamApi, "updateGroup");
	const create = spyOn(teamApi, "createGroup").mockImplementation(
		async (made) => {
			load([
				...everyone,
				group("crew", ["guide", "scout"]),
				group(made.name, made.members),
			]);
			return profileOf(made.name, made.members, made.host);
		},
	);
	try {
		await show();
		await page.click(button("Crew ▾") ?? null);
		await settle();
		await page.click(tickOf("mason") ?? null);
		await page.click(button("Save as a new council") ?? null);
		await typeInto(
			q<HTMLInputElement>(".council-sheet label input:not([type])"),
			"Crew",
		);
		await page.click(button("Save as a new council") ?? null);
		await settle();
		expect(update).not.toHaveBeenCalled();
		// the permanent name is free among the groups and the agents
		expect(create).toHaveBeenCalledWith({
			name: "crew-2",
			displayName: "Crew",
			members: ["guide", "scout", "mason"],
			host: "guide",
		});
	} finally {
		create.mockRestore();
		update.mockRestore();
		profile.mockRestore();
	}
});

test("a council made of a group that has no member left says so and offers the tick list", async () => {
	load([...everyone, group("crew", ["ghost", "other"])]);
	await show();
	expect(page.container.textContent).toContain("The council is empty");
	expect(button("Edit this council")).toBeDefined();
});

test("an address that names no group goes back to the plain table in place", async () => {
	load([...everyone, group("crew", ["guide", "scout"])]);
	window.location.hash = "#/table/ghost";
	await page.render(
		<ConfigContext.Provider value={config}>
			<TablePage focus="ghost" />
		</ConfigContext.Provider>,
	);
	await settle();
	expect(window.location.hash).toBe("#/table");
});

test("a seat's menu has the private chat and takes the knight out of the council, without muting it", async () => {
	load([...everyone, group("crew", ["guide", "scout", "mason"])]);
	const profile = spyOn(teamApi, "group").mockResolvedValue(
		profileOf("crew", ["guide", "scout", "mason"], "scout"),
	);
	const update = spyOn(teamApi, "updateGroup").mockResolvedValue(
		profileOf("crew", ["guide", "mason"]),
	);
	const mute = spyOn(api, "setMute");
	try {
		const menu = await seatMenuOf("app:agent.scout", "app:group.crew");
		expect(menu?.items.map((item) => item.id)).toEqual(["chat", "leave"]);
		await page.act(async () => {
			await menu?.items.find((item) => item.id === "leave")?.run();
		});
		// the host left with the knight, so the first member left takes it
		expect(update).toHaveBeenCalledWith("crew", {
			members: ["guide", "mason"],
			host: "guide",
		});
		expect(mute).not.toHaveBeenCalled();
		await page.act(async () => {
			await menu?.items.find((item) => item.id === "chat")?.run();
		});
		expect(decodeURIComponent(window.location.hash)).toBe(
			"#/room/app:agent.scout",
		);
	} finally {
		mute.mockRestore();
		update.mockRestore();
		profile.mockRestore();
	}
});

test("the last two members cannot be taken out: the council is offered for archiving instead", async () => {
	load([...everyone, group("pair", ["guide", "scout"])]);
	const update = spyOn(teamApi, "updateGroup");
	try {
		await show();
		const menu = await seatMenuOf("app:agent.scout", "app:group.pair");
		await page.act(async () => {
			await menu?.items.find((item) => item.id === "leave")?.run();
		});
		expect(update).not.toHaveBeenCalled();
		await settle();
		expect(document.body.textContent).toContain("Pair");
	} finally {
		update.mockRestore();
	}
});

test("a running round marks the seats and fills the strip above the box, and a member who only thinks gets neither the light nor the camera", async () => {
	load([...everyone, group("crew", ["guide", "scout", "mason"])]);
	await show();
	const crewRoom = "app:group.crew";
	await page.act(() => {
		store.dispatch({
			type: "activity",
			room: crewRoom,
			typing: true,
			stoppable: true,
		});
		store.dispatch({
			type: "round",
			room: crewRoom,
			round: {
				id: 3,
				state: "running",
				current: "scout",
				next: ["mason"],
				spoken: ["guide"],
				replies: 1,
				limit: 8,
			},
		});
	});
	for (
		let tries = 0;
		tries < 30 &&
		q('g.seat[data-seat="scout"]')?.getAttribute("data-state") !== "thinking";
		tries += 1
	)
		await settle();
	// the member the round names thinks while no word of theirs has come: no light, no camera yet
	const states = () =>
		Object.fromEntries(
			all("g.seat").map((seat) => [
				seat.getAttribute("data-seat"),
				seat.getAttribute("data-state"),
			]),
		);
	expect(states()).toEqual({
		guide: "idle",
		scout: "thinking",
		mason: "idle",
	});
	expect(q(".t2d.dim")).toBeNull();
	expect(all("g.seat[data-focus]")).toEqual([]);
	// the seats wear the same signs as the strip
	const plate = (name: string) =>
		all<SVGTextElement>(`g.seat[data-seat="${name}"] text`).at(0)?.textContent;
	expect(plate("guide")).toBe("✓ guide");
	expect(plate("mason")).toBe("① mason");
	expect(plate("scout")).toBe("scout");
	expect(q(".scene-box .order-strip .order-chip")?.textContent).toBe(
		"Reply 2 of 8",
	);
	// Stop ends the whole round, and says so
	expect(
		q<HTMLButtonElement>(".composer-stop")?.getAttribute("aria-label"),
	).toBe("Stop the round");
	await page.click(q<HTMLButtonElement>(".composer-stop"));
	expect(sent).toContainEqual({ type: "stop", room: crewRoom });
});
