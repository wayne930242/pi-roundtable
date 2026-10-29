import type { SessionView } from "../../src/api-types.ts";
import { Icon } from "../components/icons.tsx";
import { translate as t } from "../lib/messages.ts";
import { disablePush } from "../lib/push.ts";

/**
 * The Log out button, for a sign-in the app keeps a session of (`password` and `oidc`); a proxy's
 * sign-in is the proxy's to end. It posts a form so the server clears the cookie and answers with
 * the page to go to, and it stops this device's pushes first: a shared device must not keep
 * getting a person's notifications after they log out.
 */
export function LogoutForm({ auth }: { auth: SessionView["auth"] }) {
	if (auth !== "password" && auth !== "oidc") return null;
	return (
		<form
			method="post"
			action="auth/logout"
			onSubmit={(event) => {
				event.preventDefault();
				const form = event.currentTarget;
				disablePush()
					.catch(() => undefined)
					.finally(() => form.submit());
			}}
		>
			<div className="actions">
				<button type="submit" className="secondary">
					<Icon name="logout" size={16} />
					{t("Log out")}
				</button>
			</div>
		</form>
	);
}
