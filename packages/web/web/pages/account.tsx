import { lazy, Suspense } from "react";
import { Loading } from "../components/states.tsx";
import type { PageRouteProps } from "../lib/page-routes.ts";

// The three pages of a person's own account share one route entry in the first load; each is a chunk of its own.
const PAGES = {
	profile: lazy(() =>
		import("./profile.tsx").then((m) => ({ default: m.ProfilePage })),
	),
	notices: lazy(() =>
		import("./notices.tsx").then((m) => ({ default: m.NoticesPage })),
	),
	onboarding: lazy(() =>
		import("./onboarding.tsx").then((m) => ({ default: m.OnboardingPage })),
	),
} as const;

/** The account pages: the profile, the notices and the steps to finish. */
export default function AccountPage({ pane }: PageRouteProps) {
	const Page = PAGES[pane as keyof typeof PAGES];
	return Page ? (
		<Suspense fallback={<Loading />}>
			<Page />
		</Suspense>
	) : null;
}
