import { useEffect, useState } from "react";
import type { SessionView } from "../../src/api-types.ts";
import { Icon, type IconName } from "../components/icons.tsx";
import { api } from "../lib/api.ts";
import { useSelector } from "../lib/app-store.ts";
import { translate as t } from "../lib/messages.ts";
import { setTheme, type ThemePreference, useTheme } from "../lib/theme.ts";

/** The browser's offer to install the page, kept until the person asks for it. */
interface InstallPrompt extends Event {
	prompt(): Promise<void>;
	userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
let deferred: InstallPrompt | undefined;
if (typeof window !== "undefined")
	window.addEventListener("beforeinstallprompt", (event) => {
		event.preventDefault();
		deferred = event as InstallPrompt;
	});

const standalone = () =>
	typeof matchMedia === "function" &&
	(matchMedia("(display-mode: standalone)").matches ||
		(navigator as Navigator & { standalone?: boolean }).standalone === true);

const THEMES: { value: ThemePreference; label: string; icon: IconName }[] = [
	{ value: "system", label: "System", icon: "system" },
	{ value: "light", label: "Light", icon: "sun" },
	{ value: "dark", label: "Dark", icon: "moon" },
];

/** How the page looks, how to put it on a home screen, and who is signed in. */
export function SettingsPage() {
	const { preference } = useTheme();
	const principal = useSelector((state) => state.principal);
	const [session, setSession] = useState<SessionView>();
	const [canInstall, setCanInstall] = useState(deferred !== undefined);
	useEffect(() => {
		api.session().then(setSession, () => undefined);
		const onInstallable = () => setCanInstall(true);
		window.addEventListener("beforeinstallprompt", onInstallable);
		return () =>
			window.removeEventListener("beforeinstallprompt", onInstallable);
	}, []);
	const installed = standalone();
	return (
		<div className="page">
			<header className="page-head">
				<h1>{t("Settings")}</h1>
			</header>
			<section className="card stack">
				<h2>{t("Appearance")}</h2>
				<fieldset className="segmented segmented-wide">
					<legend className="visually-hidden">{t("Color scheme")}</legend>
					{THEMES.map((theme) => (
						<label key={theme.value} data-checked={preference === theme.value}>
							<input
								type="radio"
								name="theme"
								checked={preference === theme.value}
								onChange={(event) => {
									const box = event.target.getBoundingClientRect();
									setTheme(theme.value, {
										x: box.left + box.width / 2,
										y: box.top + box.height / 2,
									});
								}}
							/>
							<Icon name={theme.icon} size={18} />
							{t(theme.label)}
						</label>
					))}
				</fieldset>
			</section>
			<section className="card stack">
				<h2>{t("Install")}</h2>
				{installed ? (
					<p className="meta">{t("This page is installed on this device.")}</p>
				) : canInstall ? (
					<>
						<p className="meta">
							{t(
								"Install it to open from your home screen or dock, in its own window.",
							)}
						</p>
						<div className="actions">
							<button
								type="button"
								onClick={async () => {
									await deferred?.prompt();
									deferred = undefined;
									setCanInstall(false);
								}}
							>
								<Icon name="download" size={16} />
								{t("Install the app")}
							</button>
						</div>
					</>
				) : (
					<p className="meta">
						{t(
							"To install it, use your browser's Install option, or on iPhone and iPad, Share and then Add to Home Screen.",
						)}
					</p>
				)}
			</section>
			<section className="card stack">
				<h2>{t("Account")}</h2>
				<p className="meta">
					{principal
						? t("Signed in as {name}.", { name: principal.name })
						: session
							? t("Signed in as {name}.", { name: session.principal.name })
							: ""}
				</p>
				{session?.auth === "password" ? (
					<form method="post" action="auth/logout">
						<div className="actions">
							<button type="submit" className="secondary">
								<Icon name="logout" size={16} />
								{t("Log out")}
							</button>
						</div>
					</form>
				) : null}
			</section>
		</div>
	);
}
