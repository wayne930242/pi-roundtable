import type {
	LinkIssuedView,
	LinksView,
	LinkView,
	NoticesView,
	OnboardingView,
	ProfileView,
	PushPrefsView,
	PushTestView,
} from "../../src/api-types.ts";
import { request } from "./api.ts";

/** The calls of the pages that are loaded when first opened: notices, onboarding, the profile and the links. */
export const accountApi = {
	pushTest: () => request<PushTestView>("push/test", { method: "POST" }),
	pushPrefs: () => request<PushPrefsView>("push/prefs"),
	setPushPrefs: (
		quiet: { start: string; end: string; timeZone: string } | null,
	) =>
		request<PushPrefsView>("push/prefs", {
			method: "PUT",
			body: JSON.stringify({ quiet }),
		}),
	notices: () => request<NoticesView>("notices"),
	ackNotice: (tag: string) =>
		request<{ ok: true }>(`notices/${encodeURIComponent(tag)}/ack`, {
			method: "POST",
		}),
	onboarding: () => request<OnboardingView>("onboarding"),
	waive: (step: string) =>
		request<OnboardingView>(`onboarding/${encodeURIComponent(step)}/waive`, {
			method: "POST",
		}),
	profile: () => request<ProfileView>("profile"),
	chooseSource: (provider: string | null) =>
		request<ProfileView>("profile/source", {
			method: "PUT",
			body: JSON.stringify({ provider }),
		}),
	links: () => request<LinksView>("links"),
	issueLink: (provider: string) =>
		request<LinkIssuedView>(`links/${encodeURIComponent(provider)}/issue`, {
			method: "POST",
		}),
	confirmLink: (provider: string, requestId: string) =>
		request<LinkView>(`links/${encodeURIComponent(provider)}/confirm`, {
			method: "POST",
			body: JSON.stringify({ request: requestId }),
		}),
	cancelLink: (provider: string) =>
		request<LinkView>(`links/${encodeURIComponent(provider)}/cancel`, {
			method: "POST",
		}),
	unlink: (provider: string) =>
		request<LinkView>(`links/${encodeURIComponent(provider)}`, {
			method: "DELETE",
		}),
};
