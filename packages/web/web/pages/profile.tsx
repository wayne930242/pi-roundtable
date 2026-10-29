import { useCallback, useEffect, useRef, useState } from "react";
import type {
	LinkIssuedView,
	LinksView,
	LinkView,
	ProfileView,
	SessionView,
} from "../../src/api-types.ts";
import { Confirm } from "../components/confirm.tsx";
import { Icon } from "../components/icons.tsx";
import { Badge, Failure, Loading } from "../components/states.tsx";
import { accountApi } from "../lib/account-api.ts";
import "../lib/account-styles.ts";
import { api, messageOf } from "../lib/api.ts";
import { translate as t, wording } from "../lib/messages.ts";
import { LogoutForm } from "./logout.tsx";

/** How often a link that waits on the other service is looked at again. */
const POLL_MS = 3_000;

/** A person's picture, or their initial when they have none. */
function Who({ profile }: { profile: ProfileView }) {
	return (
		<div className="who">
			{profile.picture ? (
				<img
					className="who-picture"
					src={`api/people/${encodeURIComponent(profile.principal)}/picture`}
					alt=""
				/>
			) : (
				<span className="who-initial" aria-hidden="true">
					{Array.from(profile.name)[0] ?? "?"}
				</span>
			)}
			<div className="stack">
				<strong>{profile.name}</strong>
				{profile.tier ? (
					<span className="meta">
						<Icon name="shield" size={14} /> {t(TIER_LABELS[profile.tier])}
					</span>
				) : null}
			</div>
		</div>
	);
}

/** One account the person can link: its state, and the way to link or unlink it. */
function LinkRow({
	link,
	changed,
}: {
	link: LinkView;
	changed(view: LinkView): void;
}) {
	const [issued, setIssued] = useState<LinkIssuedView>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const [removing, setRemoving] = useState(false);
	const waiting = link.pending !== undefined || issued !== undefined;
	const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
	// While a code is out, the other service may finish the link by itself.
	useEffect(() => {
		if (!waiting || link.linked) return;
		timer.current = setInterval(() => {
			accountApi.links().then(
				(all) => {
					const now = all.links.find((l) => l.provider === link.provider);
					if (now) changed(now);
				},
				() => undefined,
			);
		}, POLL_MS);
		return () => clearInterval(timer.current);
	}, [waiting, link.linked, link.provider, changed]);
	const run = async (work: () => Promise<void>) => {
		setBusy(true);
		setError(undefined);
		try {
			await work();
		} catch (failure) {
			setError(messageOf(failure));
		} finally {
			setBusy(false);
		}
	};
	const blocked = link.blockedBy.length > 0;
	return (
		<li className="card stack">
			<div className="card-head">
				<strong>{link.label}</strong>
				{link.linked ? (
					<span className="meta">
						<Icon name="check" size={14} /> {t("Linked")}
						{link.linked.displayName ? ` · ${link.linked.displayName}` : ""}
					</span>
				) : link.step === "required" ? (
					<Badge tone="warn">{t("Required")}</Badge>
				) : link.step === "nudge" ? (
					<Badge>{t("Recommended")}</Badge>
				) : null}
			</div>
			{error ? <Failure message={error} /> : null}
			{link.linked ? (
				link.linked.locked ? (
					<p className="meta">
						{t("The server's configuration links this account.")}
					</p>
				) : (
					<div className="actions">
						<button
							type="button"
							className="secondary"
							disabled={busy}
							onClick={() => setRemoving(true)}
						>
							{t("Unlink")}
						</button>
						<Confirm
							open={removing}
							title={t("Unlink {name}?", { name: link.label })}
							confirmLabel={t("Unlink")}
							tone="danger"
							onClose={() => setRemoving(false)}
							onConfirm={async () => {
								changed(await accountApi.unlink(link.provider));
								setIssued(undefined);
							}}
						>
							<p>
								{t(
									"The app will no longer know this account is yours. You can link it again later.",
								)}
							</p>
						</Confirm>
					</div>
				)
			) : waiting ? (
				<div className="stack">
					{issued ? (
						<>
							<p>{issued.instructions}</p>
							<p className="meta">{t("Your code")}</p>
							<code className="link-code">{issued.code}</code>
							<p className="meta">
								{t("The code works until {time}.", {
									time: new Date(issued.expiresAt).toLocaleTimeString(),
								})}
							</p>
						</>
					) : (
						<p className="meta">{t("A code is waiting to be used.")}</p>
					)}
					{link.pending?.redeemedBy ? (
						<p>
							<Icon name="check" size={14} />{" "}
							{t("{name} used the code. Confirm that this is you.", {
								name: link.pending.redeemedBy.displayName,
							})}
						</p>
					) : null}
					<div className="actions">
						<button
							type="button"
							className="secondary"
							disabled={busy}
							onClick={() =>
								run(async () => {
									changed(await accountApi.cancelLink(link.provider));
									setIssued(undefined);
								})
							}
						>
							{t("Cancel")}
						</button>
						<button
							type="button"
							disabled={busy}
							onClick={() =>
								run(async () => {
									const request = issued?.request ?? link.pending?.request;
									if (!request) return;
									changed(await accountApi.confirmLink(link.provider, request));
									setIssued(undefined);
								})
							}
						>
							{t("I did it")}
						</button>
					</div>
				</div>
			) : (
				<div className="stack">
					{blocked ? (
						<p className="meta">
							{t("Link {name} first.", { name: link.blockedBy.join(", ") })}
						</p>
					) : null}
					<div className="actions">
						<button
							type="button"
							disabled={busy || blocked}
							onClick={() =>
								run(async () => {
									setIssued(await accountApi.issueLink(link.provider));
									changed(
										(await accountApi.links()).links.find(
											(l) => l.provider === link.provider,
										) ?? link,
									);
								})
							}
						>
							{t("Link")}
						</button>
					</div>
				</div>
			)}
		</li>
	);
}

/** The hours the person wants no push for a normal notice, and a test that shows push reaches them. */
function Notifications() {
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const [quiet, setQuiet] = useState<{ start: string; end: string }>();
	const [draft, setDraft] = useState({ start: "22:00", end: "07:00" });
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<string>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		accountApi.pushPrefs().then(
			(prefs) => {
				setQuiet(prefs.quiet);
				if (prefs.quiet) setDraft(prefs.quiet);
				setLoaded(true);
			},
			() => setLoaded(true),
		);
	}, []);
	const run = async (work: () => Promise<void>) => {
		setBusy(true);
		setError(undefined);
		setNote(undefined);
		try {
			await work();
		} catch (failure) {
			setError(messageOf(failure));
		} finally {
			setBusy(false);
		}
	};
	if (!loaded) return null;
	return (
		<section className="card stack">
			<h2>{t("Notifications")}</h2>
			<p className="meta">
				{t(
					"In your quiet hours a normal notice waits in the bell instead of ringing your phone. An urgent one still rings.",
				)}
			</p>
			<div className="quiet-row">
				<label>
					{t("From")}{" "}
					<input
						type="time"
						value={draft.start}
						onChange={(event) =>
							setDraft({ ...draft, start: event.target.value })
						}
					/>
				</label>
				<label>
					{t("To")}{" "}
					<input
						type="time"
						value={draft.end}
						onChange={(event) =>
							setDraft({ ...draft, end: event.target.value })
						}
					/>
				</label>
				<span className="meta">{zone}</span>
			</div>
			{error ? <Failure message={error} /> : null}
			{note ? <p className="meta">{note}</p> : null}
			<div className="actions">
				{quiet ? (
					<button
						type="button"
						className="secondary"
						disabled={busy}
						onClick={() =>
							run(async () => {
								await accountApi.setPushPrefs(null);
								setQuiet(undefined);
							})
						}
					>
						{t("Turn off quiet hours")}
					</button>
				) : null}
				<button
					type="button"
					className="secondary"
					disabled={busy}
					onClick={() =>
						run(async () => {
							await accountApi.pushTest();
							setNote(t("A test notification is on its way."));
						})
					}
				>
					{t("Send a test notification")}
				</button>
				<button
					type="button"
					disabled={busy || draft.start === draft.end}
					onClick={() =>
						run(async () => {
							const saved = await accountApi.setPushPrefs({
								...draft,
								timeZone: zone,
							});
							setQuiet(saved.quiet);
						})
					}
				>
					{t("Save")}
				</button>
			</div>
		</section>
	);
}

/** Which of their accounts names the person in the app, when more than one could. */
function ShownAs({
	profile,
	changed,
}: {
	profile: ProfileView;
	changed(view: ProfileView): void;
}) {
	const [error, setError] = useState<string>();
	if (profile.sources.length === 0) return null;
	const choose = async (provider: string | null) => {
		setError(undefined);
		try {
			changed(await accountApi.chooseSource(provider));
		} catch (failure) {
			setError(messageOf(failure));
		}
	};
	return (
		<section className="card stack">
			<h2>{t("Shown as")}</h2>
			<p className="meta">
				{t(
					"The name and picture of this account are what others see in the app.",
				)}
			</p>
			<fieldset className="choice">
				<legend className="visually-hidden">{t("Shown as")}</legend>
				<label>
					<input
						type="radio"
						name="shown-as"
						checked={profile.source === undefined}
						onChange={() => choose(null)}
					/>
					{t("Automatic")}
				</label>
				{profile.sources.map((source) => (
					<label key={source.provider}>
						<input
							type="radio"
							name="shown-as"
							checked={profile.source === source.provider}
							onChange={() => choose(source.provider)}
						/>
						{t(source.label)}
					</label>
				))}
			</fieldset>
			{error ? <Failure message={error} /> : null}
		</section>
	);
}

/** Who the person is, the accounts they linked, which of them names them, and how to sign out; the page the gate never hides. */
export function ProfilePage() {
	const [session, setSession] = useState<SessionView>();
	const [profile, setProfile] = useState<ProfileView>();
	const [links, setLinks] = useState<LinksView>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		api.session().then(setSession, (failure) => setError(messageOf(failure)));
		accountApi.profile().then(setProfile, () => undefined);
		accountApi.links().then(setLinks, () => undefined);
	}, []);
	const linkChanged = useCallback((view: LinkView) => {
		setLinks((all) =>
			all
				? {
						links: all.links.map((l) =>
							l.provider === view.provider ? view : l,
						),
					}
				: all,
		);
		// Linking or unlinking may change who can name the person.
		accountApi.profile().then(setProfile, () => undefined);
	}, []);
	if (error) return <Failure message={error} />;
	if (!session) return <Loading />;
	return (
		<div className="page">
			<header className="page-head">
				<h1>{t("Profile")}</h1>
			</header>
			<section className="card stack">
				<h2>{t("Account")}</h2>
				{profile ? (
					<Who profile={profile} />
				) : (
					<p className="meta">
						{t("Signed in as {name}.", { name: session.principal.name })}
					</p>
				)}
				<LogoutForm auth={session.auth} />
			</section>
			{links && links.links.length > 0 ? (
				<section className="stack">
					<h2>{t("Your accounts")}</h2>
					<ul className="stack notices">
						{links.links.map((link) => (
							<LinkRow key={link.provider} link={link} changed={linkChanged} />
						))}
					</ul>
				</section>
			) : null}
			{profile ? <ShownAs profile={profile} changed={setProfile} /> : null}
			{session.push ? <Notifications /> : null}
		</div>
	);
}

const TIER_LABELS = {
	owner: wording("Owner"),
	admin: wording("Admin"),
	member: wording("Member"),
} as const;
