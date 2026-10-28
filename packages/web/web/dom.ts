// A DOM for the tests that click and type: happy-dom, registered for one test file and removed
// after it, so the files that render to strings still see a page-less runtime.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

export interface TestPage {
	container: HTMLElement;
	/** Renders `node` and lets its effects and updates settle. */
	render(node: ReactNode): Promise<void>;
	/** Runs `work` the way a browser event would, then lets React settle. */
	act(work: () => void | Promise<void>): Promise<void>;
	/** Clicks an element. */
	click(element: Element | null): Promise<void>;
	unmount(): Promise<void>;
}

/** Registers the DOM; call `page.unmount()` and `releaseDom()` when the file is done. */
export async function openPage(): Promise<TestPage> {
	if (!GlobalRegistrator.isRegistered)
		GlobalRegistrator.register({ url: "http://localhost/" });
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
	const { act } = await import("react");
	const { createRoot } = await import("react-dom/client");
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const run = async (work: () => void | Promise<void>) => {
		await act(async () => {
			await work();
		});
	};
	return {
		container,
		render: (node) => run(() => root.render(node)),
		act: run,
		click: (element) => {
			if (!(element instanceof HTMLElement))
				throw new Error("nothing to click");
			return run(() => element.click());
		},
		unmount: async () => {
			await run(() => root.unmount());
			container.remove();
		},
	};
}

export async function releaseDom(): Promise<void> {
	if (GlobalRegistrator.isRegistered) await GlobalRegistrator.unregister();
}
