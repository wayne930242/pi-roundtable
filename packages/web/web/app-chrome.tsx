import { useEffect } from "react";
import { Icon, type IconName } from "./components/icons.tsx";
import { translate as t } from "./lib/messages.ts";
import { setTheme, useTheme } from "./lib/theme.ts";

/** One pane in the rail and the tab bar. */
export interface NavItem {
	pane: string;
	label: string;
	icon: IconName;
}

/** Keeps the layout the size of what the person can see: the visible area shrinks when the on-screen keyboard rises. */
export function useViewportSize(): void {
	useEffect(() => {
		const viewport = window.visualViewport;
		const root = document.documentElement;
		const apply = () => {
			root.style.setProperty(
				"--app-height",
				`${viewport?.height ?? window.innerHeight}px`,
			);
			root.style.setProperty("--app-top", `${viewport?.offsetTop ?? 0}px`);
		};
		apply();
		viewport?.addEventListener("resize", apply);
		viewport?.addEventListener("scroll", apply);
		window.addEventListener("resize", apply);
		return () => {
			viewport?.removeEventListener("resize", apply);
			viewport?.removeEventListener("scroll", apply);
			window.removeEventListener("resize", apply);
		};
	}, []);
}

export function ThemeButton() {
	const { resolved } = useTheme();
	return (
		<button
			type="button"
			className="icon-button"
			aria-label={
				resolved === "dark" ? t("Switch to light") : t("Switch to dark")
			}
			onClick={(event) => {
				const box = event.currentTarget.getBoundingClientRect();
				setTheme(resolved === "dark" ? "light" : "dark", {
					x: box.left + box.width / 2,
					y: box.top + box.height / 2,
				});
			}}
		>
			<Icon name={resolved === "dark" ? "sun" : "moon"} />
		</button>
	);
}
