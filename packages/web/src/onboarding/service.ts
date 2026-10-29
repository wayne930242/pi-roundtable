import type { IdentityService, Logger, PersonProfiles } from "pi-roundtable";
import type { OnboardingStepView, OnboardingView } from "../api-types.ts";
import type { Gate } from "../gate.ts";
import type {
	OnboardingStep,
	StepStatus,
	Viewer,
	WebApp,
	WebAppRegistry,
} from "../web-app.ts";
import type { OnboardingWaivers } from "./waivers.ts";

type OnboardingPort = WebApp["onboarding"];

/** The id of the notifications step. */
export const PUSH_STEP = "push";
/** The id of the step that links a provider's account. */
export const linkStep = (provider: string): string => `link:${provider}`;

export interface OnboardingServiceOptions {
	registry: Pick<WebAppRegistry, "steps" | "step" | "prover">;
	waivers: Pick<OnboardingWaivers, "waived" | "waive">;
	gate: Pick<Gate, "changed">;
	identity: Pick<IdentityService, "speakerFor" | "principal">;
	profiles?: Pick<PersonProfiles, "of">;
	push: WebApp["push"];
	logger: Logger;
}

/**
 * What a person owes before the app opens, and how they settle it. The steps are the host's
 * (`registerStep`) and the app's own (`link:<provider>`, `push`); a step is undone until its
 * `done` says it is, and a required one may be waived only when it offers a waiver.
 */
export class OnboardingService implements OnboardingPort {
	readonly #options: OnboardingServiceOptions;

	constructor(options: OnboardingServiceOptions) {
		this.#options = options;
	}

	/** The person as a step's callbacks see them, built from their id alone. */
	async viewerFor(principalId: string): Promise<Viewer> {
		const { identity, profiles } = this.#options;
		let tier: Viewer["tier"] = "member";
		try {
			tier = (await identity.speakerFor(principalId)).tier;
		} catch {
			// No tier: they are a member as far as a step is concerned.
		}
		const name =
			(await profiles?.of(principalId))?.name ??
			(await identity.principal(principalId))?.displayName ??
			principalId;
		return { principalId, speakerId: principalId, tier, roles: [], name };
	}

	async status(principalId: string): Promise<StepStatus[]> {
		return this.statuses(await this.viewerFor(principalId));
	}

	/** Every step that applies to the viewer, with whether it is done or waived. */
	async statuses(viewer: Viewer): Promise<StepStatus[]> {
		const found: StepStatus[] = [];
		for (const step of this.#options.registry.steps()) {
			try {
				if (step.applies && !(await step.applies(viewer))) continue;
				const done = await step.done(viewer);
				const waived =
					!done && step.required
						? await this.#options.waivers.waived(viewer.principalId, step.id)
						: false;
				found.push(statusOf(step, done, waived));
			} catch (error) {
				// A step that cannot be read is undone.
				this.#options.logger.warn(
					{ step: step.id, err: error },
					"an onboarding step was not read",
				);
				found.push(statusOf(step, false, false));
			}
		}
		return found;
	}

	changed(principalId: string): void {
		this.#options.gate.changed(principalId);
	}

	/** The steps with the push state, as the onboarding page shows them. */
	async view(viewer: Viewer): Promise<OnboardingView> {
		const [steps, push] = await Promise.all([
			this.statuses(viewer),
			this.#options.push.status(viewer.principalId),
		]);
		return {
			steps: steps.map(
				(step): OnboardingStepView => ({
					id: step.id,
					label: step.label,
					...(step.help ? { help: step.help } : {}),
					...(step.builtin ? { builtin: step.builtin } : {}),
					required: step.required,
					open: step.open,
					...(step.waiver ? { waiver: step.waiver } : {}),
					done: step.done,
					waived: step.waived,
				}),
			),
			push: {
				devices: push.devices,
				...(push.lastReceiptAt
					? { lastReceiptAt: push.lastReceiptAt.toISOString() }
					: {}),
				waived: push.waived,
			},
		};
	}

	/**
	 * Waives a step for the person. Only a required step that offers a waiver can be; any other
	 * answers false. Recorded with who and when, then the gate is asked again.
	 */
	async waive(principalId: string, stepId: string): Promise<boolean> {
		const step = this.#options.registry.step(stepId);
		if (!step?.required || !step.waiver) return false;
		await this.#options.waivers.waive(principalId, stepId);
		this.changed(principalId);
		return true;
	}
}

function statusOf(
	step: OnboardingStep,
	done: boolean,
	waived: boolean,
): StepStatus {
	return {
		id: step.id,
		label: step.label,
		...(step.help ? { help: step.help } : {}),
		...(step.builtin ? { builtin: step.builtin } : {}),
		required: step.required,
		done,
		waived,
		open: step.open,
		...(step.required && step.waiver ? { waiver: step.waiver } : {}),
	};
}
