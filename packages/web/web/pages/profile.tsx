import { useEffect, useState } from "react";
import type { SessionView } from "../../src/api-types.ts";
import { Icon } from "../components/icons.tsx";
import { Failure, Loading } from "../components/states.tsx";
import { api, messageOf } from "../lib/api.ts";
import { translate as t, wording } from "../lib/messages.ts";
import { LogoutForm } from "./logout.tsx";

/** Who the person is signed in as, and how to sign out; the page the gate never hides. */
export function ProfilePage() {
	const [session, setSession] = useState<SessionView>();
	const [error, setError] = useState<string>();
	useEffect(() => {
		api.session().then(setSession, (failure) => setError(messageOf(failure)));
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
				<p className="meta">
					{t("Signed in as {name}.", { name: session.principal.name })}
				</p>
				{session.tier ? (
					<p className="meta">
						<Icon name="shield" size={14} /> {t(TIER_LABELS[session.tier])}
					</p>
				) : null}
				<LogoutForm auth={session.auth} />
			</section>
		</div>
	);
}

const TIER_LABELS = {
	owner: wording("Owner"),
	admin: wording("Admin"),
	member: wording("Member"),
} as const;
