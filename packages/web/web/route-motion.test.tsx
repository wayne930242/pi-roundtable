import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { openPage, releaseDom, type TestPage } from "./dom.ts";
import { pageKey, setRouting, useRoute } from "./lib/router.ts";

let page: TestPage;
let transitions = 0;
beforeAll(async () => {
	page = await openPage();
	Reflect.set(document, "startViewTransition", (update: () => void) => {
		transitions++;
		update();
		const done = Promise.resolve();
		return { ready: done, updateCallbackDone: done, finished: done };
	});
});
afterEach(() => {
	window.location.hash = "";
});
afterAll(async () => {
	await page.unmount();
	await releaseDom();
});

function Where() {
	const route = useRoute();
	return <p id="where">{`${route.pane}/${route.key ?? ""}`}</p>;
}

const go = async (hash: string) => {
	window.location.hash = hash;
	await page.act(async () => {
		window.dispatchEvent(new HashChangeEvent("hashchange"));
	});
};

test("a move from one folder to another cross-fades nothing, and a move to another pane still does", async () => {
	window.location.hash = "#/workspace/agents%3Asrc";
	await page.render(<Where />);
	const where = () => page.container.querySelector("#where")?.textContent;
	expect(where()).toBe("workspace/agents:src");
	transitions = 0;
	await go("#/workspace/agents%3Adata");
	expect(where()).toBe("workspace/agents:data");
	expect(transitions).toBe(0);
	await go("#/rooms");
	expect(where()).toBe("rooms/");
	expect(transitions).toBe(1);
	await go("#/workspace/agents%3Asrc");
	expect(transitions).toBe(2);
});

test("the files keep one page name across places, so the tree and the listing are not mounted afresh; other panes are named by their key", () => {
	expect(pageKey("workspace", "agents:src", true)).toBe(
		pageKey("workspace", "agents:data", true),
	);
	expect(pageKey("workspace", undefined, false)).toBe(
		pageKey("workspace", "agents:src", false),
	);
	expect(pageKey("room", "a", true)).toBe(pageKey("room", "b", true));
	expect(pageKey("room", "a", false)).not.toBe(pageKey("room", "b", false));
	expect(pageKey("agent", "a", true)).not.toBe(pageKey("agent", "b", true));
	expect(pageKey("workspace", "x", true)).not.toBe(
		pageKey("settings", "x", true),
	);
});

function Late(props: { show: boolean }) {
	return props.show ? <Shown /> : null;
}

function Shown() {
	const route = useRoute();
	return (
		<>
			<p id="inner">{`${route.pane}/${route.key ?? ""}`}</p>
			<a id="folder" href="/app/workspace/agents%3Asrc%2F">
				src
			</a>
		</>
	);
}

test("a link click reaches every useRoute, also one mounted after the page's own", async () => {
	setRouting("/app");
	// The shell's route listens first, as when Files is reached from the tab bar.
	window.history.replaceState(null, "", "/app/rooms");
	function Shell() {
		const route = useRoute();
		return (
			<>
				<p id="outer">{`${route.pane}/${route.key ?? ""}`}</p>
				<Late show={route.pane === "workspace"} />
			</>
		);
	}
	try {
		await page.render(<Shell />);
		const text = (id: string) =>
			page.container.querySelector(`#${id}`)?.textContent;
		await page.act(async () => {
			window.history.pushState(null, "", "/app/workspace");
			window.dispatchEvent(new PopStateEvent("popstate"));
		});
		expect(text("inner")).toBe("workspace/");
		await page.act(async () => {
			(page.container.querySelector("#folder") as HTMLElement).click();
		});
		expect(text("outer")).toBe("workspace/agents:src/");
		expect(text("inner")).toBe("workspace/agents:src/");
	} finally {
		setRouting(undefined);
		window.history.replaceState(null, "", "/");
	}
});
