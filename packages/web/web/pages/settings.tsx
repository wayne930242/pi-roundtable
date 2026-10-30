import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { PushDeviceView, SessionView } from "../../src/api-types.ts";
import { Icon, type IconName } from "../components/icons.tsx";
import { api, messageOf } from "../lib/api.ts";
import { useSelector } from "../lib/app-store.ts";
import { useConfig } from "../lib/config.ts";
import { hostUi } from "../lib/frame-taps.ts";
import { type PageLook, setLook, useLook } from "../lib/look.ts";
import { translate as t, wording } from "../lib/messages.ts";
import {
	disablePush,
	enablePush,
	type PushState,
	pushState,
	thisDevice,
} from "../lib/push.ts";
import { hrefFor } from "../lib/router.ts";
import { setTheme, type ThemePreference, useTheme } from "../lib/theme.ts";
import { toast } from "../lib/toast.ts";
import { LogoutForm } from "./logout.tsx";

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
	{ value: "system", label: wording("System"), icon: "system" },
	{ value: "light", label: wording("Light"), icon: "sun" },
	{ value: "dark", label: wording("Dark"), icon: "moon" },
];

const LOOKS: { value: PageLook; label: string; hint: string }[] = [
	{
		value: "modern",
		label: wording("Modern"),
		hint: wording("Plain and neutral, with round avatars."),
	},
	{
		value: "camelot",
		label: wording("Camelot"),
		hint: wording(
			"Parchment by day, night castle by night, gold rules, shield avatars and wax seals.",
		),
	},
];

/** Push on this device, and the devices that get it. */
function Notifications({
	enabled,
	quietHours,
}: {
	enabled: boolean;
	quietHours: SessionView["quietHours"];
}) {
	const [state, setState] = useState<PushState>();
	const [devices, setDevices] = useState<PushDeviceView[]>([]);
	const [current, setCurrent] = useState<string>();
	const [busy, setBusy] = useState(false);
	const refresh = useCallback(async () => {
		setState(await pushState());
		setCurrent(await thisDevice());
		setDevices((await api.pushDevices()).devices);
	}, []);
	useEffect(() => {
		if (enabled) refresh().catch(() => setState("unsupported"));
	}, [enabled, refresh]);
	if (!enabled) return null;
	const change = async (work: () => Promise<void>) => {
		setBusy(true);
		try {
			await work();
		} catch (failure) {
			toast(
				failure instanceof Error && failure.message === "permission"
					? t(
							"Notifications were not allowed. Allow them in the browser's site settings.",
						)
					: messageOf(failure),
				"danger",
			);
		} finally {
			await refresh().catch(() => undefined);
			setBusy(false);
		}
	};
	return (
		<section className="card stack">
			<h2>{t("Notifications")}</h2>
			<p className="meta">
				{state === "unsupported"
					? t(
							"This browser cannot get push notifications. On iPhone and iPad, install the app from Share, Add to Home Screen, and open it from there.",
						)
					: state === "blocked"
						? t(
								"Notifications are blocked for this site. Allow them in the browser's site settings.",
							)
						: t(
								"Get a notification on this device when a card waits for you or a knight reports on its own, while the app is not open.",
							)}
			</p>
			{quietHours ? (
				<p className="meta">
					{t(
						"Quiet hours, {start} to {end} ({zone}): no notification for a knight's report or a notice. A card waiting for you still notifies. The server sets the hours.",
						{
							start: quietHours.start,
							end: quietHours.end,
							zone: quietHours.timeZone,
						},
					)}
				</p>
			) : null}
			{state === "off" || state === "on" ? (
				<div className="actions">
					<button
						type="button"
						className={state === "on" ? "secondary" : undefined}
						disabled={busy}
						onClick={() => change(state === "on" ? disablePush : enablePush)}
					>
						{state === "on"
							? t("Turn off on this device")
							: t("Turn on for this device")}
					</button>
				</div>
			) : null}
			{devices.length > 0 ? (
				<ul className="stack">
					{devices.map((device) => (
						<li key={device.id} className="card-head">
							<span>
								{device.label ?? t("Device")}
								{device.id === current ? ` (${t("this device")})` : ""}
							</span>
							<button
								type="button"
								className="secondary"
								disabled={busy}
								onClick={() =>
									change(async () => {
										if (device.id === current) await disablePush();
										else await api.removePushDevice(device.id);
									})
								}
							>
								{t("Remove")}
							</button>
						</li>
					))}
				</ul>
			) : null}
		</section>
	);
}

// The host's own pages that belong with settings are listed by code that loads only where a host has them.
const HostSettingsPages = lazy(() =>
	hostUi().then((ui) => ({ default: ui.HostSettingsPages })),
);

/** How the page looks, how to put it on a home screen, which devices get push, and who is signed in. */
export function SettingsPage() {
	const { preference } = useTheme();
	const look = useLook();
	const config = useConfig();
	const hostLook = config.look ?? "modern";
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
			{config.pages?.some((page) => page.place === "settings") ? (
				<Suspense fallback={null}>
					<HostSettingsPages />
				</Suspense>
			) : null}
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
				<fieldset className="segmented segmented-wide">
					<legend className="visually-hidden">{t("Look")}</legend>
					{LOOKS.map((option) => (
						<label key={option.value} data-checked={look === option.value}>
							<input
								type="radio"
								name="look"
								checked={look === option.value}
								// Choosing the look the host sets goes back to following the host.
								onChange={() =>
									setLook(option.value === hostLook ? undefined : option.value)
								}
							/>
							<span
								className="look-swatch"
								data-swatch={option.value}
								aria-hidden="true"
							>
								<i />
								<i />
								<i />
							</span>
							{t(option.label)}
						</label>
					))}
				</fieldset>
				<p className="meta">
					{t(LOOKS.find((option) => option.value === look)?.hint ?? "")}
				</p>
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
			{session?.prompts ? (
				<section className="card stack">
					<h2>{t("Main prompts")}</h2>
					<ul className="menu">
						<li>
							<a className="menu-item menu-link" href={hrefFor("prompts")}>
								<span className="menu-text">
									<strong>{t("Edit the main prompts")}</strong>
									<span className="meta">
										{t(
											"The texts the main knight and the other knights start from, with a diff to read before you save and a way back to the file's text.",
										)}
									</span>
								</span>
								<Icon name="chevron" size={16} />
							</a>
						</li>
					</ul>
				</section>
			) : null}
			<Notifications
				enabled={session?.push === true}
				quietHours={session?.quietHours}
			/>
			<section className="card stack">
				<h2>{t("Account")}</h2>
				<p className="meta">
					{principal
						? t("Signed in as {name}.", { name: principal.name })
						: session
							? t("Signed in as {name}.", { name: session.principal.name })
							: ""}
				</p>
				{session ? <LogoutForm auth={session.auth} /> : null}
			</section>
		</div>
	);
}
