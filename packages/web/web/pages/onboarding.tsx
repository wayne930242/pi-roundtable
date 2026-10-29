import { useCallback, useEffect, useRef, useState } from "react";
import type {
	OnboardingStepView,
	OnboardingView,
} from "../../src/api-types.ts";
import { Confirm } from "../components/confirm.tsx";
import { Icon } from "../components/icons.tsx";
import { Failure, Loading } from "../components/states.tsx";
import { accountApi } from "../lib/account-api.ts";
import "../lib/account-styles.ts";
import { messageOf } from "../lib/api.ts";
import { translate as t } from "../lib/messages.ts";
import { enablePush, type PushState, pushState } from "../lib/push.ts";
import { hrefFor } from "../lib/router.ts";
import { stepHelp, stepLabel } from "../lib/steps.ts";

/** How long the page waits for a test notification to come back, and how often it asks. */
const WAIT_MS = 90_000;
const POLL_MS = 2_000;

const installed = (): boolean =>
	typeof matchMedia === "function" &&
	(matchMedia("(display-mode: standalone)").matches ||
		(navigator as Navigator & { standalone?: boolean }).standalone === true);

const onApple = (): boolean => /iPhone|iPad/.test(navigator.userAgent);

type Test = "idle" | "sending" | "waiting" | "arrived" | "late";

/**
 * Turning on notifications, one step at a time: put the app on the home screen (where the phone
 * needs it), allow notifications, send a test and see it arrive. The step is done when a device
 * reports that a notification arrived; the page asks the server until it does.
 */
function PushStep({
	step,
	view,
	refresh,
}: {
	step: OnboardingStepView;
	view: OnboardingView;
	refresh(): Promise<OnboardingView | undefined>;
}) {
	const [state, setState] = useState<PushState>();
	const [test, setTest] = useState<Test>(step.done ? "arrived" : "idle");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [skipping, setSkipping] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => {
		pushState().then(setState, () => setState("unsupported"));
		return () => clearTimeout(timer.current);
	}, []);
	useEffect(() => {
		if (step.done) setTest("arrived");
	}, [step.done]);

	const wait = useCallback(
		(since: number) => {
			const look = async () => {
				const latest = await refresh();
				if (latest?.steps.find((s) => s.id === step.id)?.done) {
					setTest("arrived");
					return;
				}
				if (Date.now() - since > WAIT_MS) {
					setTest("late");
					return;
				}
				timer.current = setTimeout(look, POLL_MS);
			};
			timer.current = setTimeout(look, POLL_MS);
		},
		[refresh, step.id],
	);
	const sendTest = async () => {
		setBusy(true);
		setError(undefined);
		setTest("sending");
		try {
			await accountApi.pushTest();
			setTest("waiting");
			wait(Date.now());
		} catch (failure) {
			setTest("idle");
			setError(messageOf(failure));
		} finally {
			setBusy(false);
		}
	};
	const allow = async () => {
		setBusy(true);
		setError(undefined);
		try {
			await enablePush();
			setState(await pushState());
			await refresh();
		} catch (failure) {
			setError(
				failure instanceof Error && failure.message === "permission"
					? t(
							"Notifications were not allowed. Allow them in the browser's site settings.",
						)
					: messageOf(failure),
			);
			setState(await pushState().catch(() => "unsupported" as const));
		} finally {
			setBusy(false);
		}
	};

	const needsInstall = state === "unsupported" && onApple() && !installed();
	return (
		<section className="card stack" aria-labelledby={`step-${step.id}`}>
			<div className="card-head">
				<h2 id={`step-${step.id}`}>{stepLabel(step)}</h2>
				{step.done ? (
					<span className="meta">
						<Icon name="check" size={14} /> {t("Done")}
					</span>
				) : null}
			</div>
			<p className="meta">{stepHelp(step)}</p>
			<ol className="steps">
				<li data-done={state === "on" || needsInstall === false || undefined}>
					<strong>{t("Put the app on your phone")}</strong>
					<span className="meta">
						{needsInstall
							? t(
									"On iPhone and iPad, open this page in Safari, tap Share, then Add to Home Screen, and open the app from there.",
								)
							: installed()
								? t("This page is installed on this device.")
								: t(
										"On a phone, add it to the home screen from the browser's menu so notifications reach you when it is closed.",
									)}
					</span>
				</li>
				<li data-done={state === "on" || undefined}>
					<strong>{t("Allow notifications")}</strong>
					{state === "blocked" ? (
						<span className="meta">
							{t(
								"Notifications are blocked for this site. Allow them in the browser's site settings.",
							)}
						</span>
					) : state === "unsupported" ? (
						<span className="meta">
							{t("This browser cannot get push notifications.")}
						</span>
					) : state === "on" ? (
						<span className="meta">{t("Allowed on this device.")}</span>
					) : (
						<button
							type="button"
							disabled={busy || state === undefined}
							onClick={allow}
						>
							{t("Allow notifications")}
						</button>
					)}
				</li>
				<li data-done={step.done || undefined}>
					<strong>{t("Send a test")}</strong>
					{test === "arrived" ? (
						<span className="meta">
							{t("It arrived. Notifications work on this device.")}
						</span>
					) : (
						<>
							<button
								type="button"
								className="secondary"
								disabled={busy || state !== "on" || test === "waiting"}
								onClick={sendTest}
							>
								{test === "waiting"
									? t("Waiting for it…")
									: t("Send a test notification")}
							</button>
							{test === "late" ? (
								<span className="meta">
									{t(
										"It has not arrived. Check that notifications are allowed for this app, then send another.",
									)}
								</span>
							) : null}
						</>
					)}
				</li>
			</ol>
			{error ? <Failure message={error} /> : null}
			{step.waiver && !step.done && !step.waived ? (
				<div className="actions">
					<button
						type="button"
						className="secondary"
						onClick={() => setSkipping(true)}
					>
						{t(step.waiver.label)}
					</button>
					<Confirm
						open={skipping}
						title={t(step.waiver.label)}
						confirmLabel={t("Skip")}
						onClose={() => setSkipping(false)}
						onConfirm={async () => {
							await accountApi.waive(step.id);
							await refresh();
						}}
					>
						<p>{t(step.waiver.confirm)}</p>
					</Confirm>
				</div>
			) : null}
			{view.push.devices > 0 && !step.done ? (
				<p className="meta">
					{t("{count} device(s) will get notifications.", {
						count: view.push.devices,
					})}
				</p>
			) : null}
		</section>
	);
}

/** The steps a person owes, with the notifications step done here and the account links on their profile. */
export function OnboardingPage() {
	const [view, setView] = useState<OnboardingView>();
	const [error, setError] = useState<string>();
	const refresh = useCallback(async () => {
		try {
			const latest = await accountApi.onboarding();
			setView(latest);
			return latest;
		} catch (failure) {
			setError(messageOf(failure));
			return undefined;
		}
	}, []);
	useEffect(() => {
		refresh();
	}, [refresh]);
	if (error && !view) return <Failure message={error} />;
	if (!view) return <Loading />;
	return (
		<div className="page">
			<header className="page-head">
				<h1>{t("Finish setting up")}</h1>
			</header>
			{view.steps.map((step) =>
				step.builtin === "push" ? (
					<PushStep key={step.id} step={step} view={view} refresh={refresh} />
				) : (
					<section key={step.id} className="card stack">
						<div className="card-head">
							<strong>{stepLabel(step)}</strong>
							{step.done || step.waived ? (
								<span className="meta">
									<Icon name="check" size={14} />{" "}
									{step.done ? t("Done") : t("Skipped")}
								</span>
							) : (
								<a className="button-link" href={hrefFor(step.open.page)}>
									{t("Open")}
								</a>
							)}
						</div>
						<p className="meta">{stepHelp(step)}</p>
					</section>
				),
			)}
			{view.steps.length === 0 ? (
				<p className="empty">{t("There is nothing left to set up.")}</p>
			) : null}
		</div>
	);
}
