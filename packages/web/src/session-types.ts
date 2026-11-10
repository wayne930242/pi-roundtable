import type { CharacterSpec } from "pi-roundtable/characters";
import type { AppTier, GateStepView } from "./api-common-types.ts";
import type { PrincipalName } from "./console-types.ts";
import type { PictureRef } from "./message-types.ts";
import type { NoticeView } from "./room-types.ts";

/** Who the page is signed in as. */
export interface SessionView {
	principal: PrincipalName;
	surface: string;
	/** How the console signs the person in; the page offers Log out under `password` and `oidc`. */
	auth: "none" | "password" | "verifier" | "oidc";
	/** The visitor's tier. Sent only where the host admits more than its owners (`admission: "access"`). */
	tier?: AppTier;
	/** The steps still undone before the app opens; present only while the gate is closed. */
	gate?: GateStepView[];
	/** When the credential lapses, if it does. */
	expiresAt?: string;
	/** Web Push is available: the app serves the rooms and a key for it. */
	push?: true;
	/** The host has prompt documents the owner edits (`api/prompts`). */
	prompts?: true;
	/** The host has the skills addon, so an agent-written skill's SKILL.md can be edited and made here (`api/skill-docs`). */
	skillEdit?: true;
	/** The host makes temp knights, so a knight's presets are kept here (`api/agents/<name>/presets`). */
	helpers?: true;
	/** When an agent's post and a notice are not pushed (a card still is); absent = at any hour. */
	quietHours?: {
		/** `HH:MM`, where the window begins. */
		start: string;
		/** `HH:MM`, where it ends; before `start` when it crosses midnight. */
		end: string;
		/** The IANA zone the times are on. */
		timeZone: string;
	};
}

/** The key a browser subscribes to push against. */
export interface PushKeyView {
	key: string;
}

/** One device of the person that gets push; the id is not the endpoint. */
export interface PushDeviceView {
	id: string;
	label?: string;
	createdAt: string;
	lastOkAt?: string;
}

export interface PushDevicesView {
	devices: PushDeviceView[];
}

/** A test push was queued; the device's receipt for `tag` completes the push step. */
export interface PushTestView {
	tag: string;
}

/** The person's own push preferences. */
export interface PushPrefsView {
	/** No push for a normal notice from `start` to `end` on the clock of `timeZone`; absent = none set. */
	quiet?: { start: string; end: string; timeZone: string };
}

/** The person's notices that are not resolved, newest first, and the count the app icon shows. */
export interface NoticesView {
	notices: NoticeView[];
	badge: number;
}

/** One account the person may link, as the profile page shows it. */
export interface LinkView {
	provider: string;
	label: string;
	/** What linking it is for this deployment: `required` gates the app, `nudge` asks; absent = optional. */
	step?: "required" | "nudge";
	/** Providers to link first, and those of them not linked yet (`issue` is refused until none is left). */
	requires: string[];
	blockedBy: string[];
	linked?: {
		displayName?: string;
		/** ISO time. */
		linkedAt: string;
		/** The configuration or the CLI made the link, so it cannot be removed here. */
		locked?: true;
	};
	pending?: {
		request: string;
		/** ISO time. */
		expiresAt: string;
		redeemedBy?: { displayName: string; picture?: PictureRef };
	};
}

export interface LinksView {
	links: LinkView[];
}

/** The code a person puts into the other service to prove an account. */
export interface LinkIssuedView {
	code: string;
	request: string;
	/** ISO time. */
	expiresAt: string;
	instructions: string;
}

/** How the person is shown, and which of their accounts they may pick to show. */
export interface ProfileView {
	name: string;
	/** The account the name comes from; absent when it is the person's own name. */
	source?: string;
	/** A picture is served at `api/people/<principal>/picture`. */
	picture: boolean;
	/** The knight the person made for themselves; the app shows it in place of the picture. */
	character?: CharacterSpec;
	principal: string;
	tier?: AppTier;
	/** The accounts the person linked that can name them; the page shows these as the choice. */
	sources: { provider: string; label: string }[];
}

/** A step of onboarding as the page of steps shows it. */
export interface OnboardingStepView extends GateStepView {
	done: boolean;
	waived: boolean;
}

export interface OnboardingView {
	steps: OnboardingStepView[];
	/** Push on the person's devices: how many are subscribed and when one last reported back. */
	push: { devices: number; lastReceiptAt?: string; waived: boolean };
}

/** A schedule, labelled by the room it belongs to or else its channel. */
export interface ScheduleView {
	id: number;
	/** The room it runs in, when it belongs to one of the app's. */
	room?: string;
	/** The channel key it runs in. */
	channel: string;
	/** What to call that place: the room's name or the channel key. */
	label: string;
	title: string;
	prompt: string;
	/** The schedule's recurrence as the core stores it. */
	recurrence: unknown;
	nextRun: string;
	lastRun?: string;
	lastStatus?: string;
	createdBy: string;
}

export interface SchedulesView {
	schedules: ScheduleView[];
}
