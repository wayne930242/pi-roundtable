import type { IdentityService, Tier } from "pi-roundtable";
import type { PushOutbox } from "../push/outbox.ts";
import type { LinkProver, OnboardingStep, Viewer } from "../web-app.ts";
import { linkStep, PUSH_STEP } from "./service.ts";

export interface BuiltInStepsOptions {
	/** `onboarding.links`: provider → required or nudge. */
	links: Readonly<Record<string, "required" | "nudge">>;
	/** `onboarding.push` and `onboarding.pushWaiver`. */
	push: { mode: "required" | "nudge" | "off"; waiver: boolean };
	/** The tiers whose people may receive push; the push step applies to these only. */
	pushTiers: readonly Tier[];
	prover(
		provider: string,
	): Pick<LinkProver, "provider" | "label" | "status"> | undefined;
	identity: Pick<IdentityService, "identities">;
	outbox: Pick<PushOutbox, "lastReceiptAt">;
}

/**
 * The steps `onboarding` asks for. `link:<provider>` is done when the prover says the account is
 * linked, or when the person has an identity of that provider from any source (a configuration, CLI
 * or plugin link covers an owner, who never proves what the host already knows). `push` is done
 * when a device of the person reported back within 30 days: a test push, or any notice.
 */
export function builtInSteps(options: BuiltInStepsOptions): OnboardingStep[] {
	const steps: OnboardingStep[] = [];
	for (const [provider, mode] of Object.entries(options.links)) {
		steps.push({
			id: linkStep(provider),
			// Read when asked: a host registers its provers after the app has made its steps.
			get label() {
				return options.prover(provider)?.label ?? provider;
			},
			required: mode === "required",
			builtin: "link",
			open: { page: "profile" },
			done: (viewer) => linked(options, provider, viewer),
		});
	}
	if (options.push.mode !== "off") {
		const required = options.push.mode === "required";
		steps.push({
			id: PUSH_STEP,
			label: "Turn on notifications",
			required,
			builtin: "push",
			open: { page: "onboarding" },
			applies: (viewer) => options.pushTiers.includes(viewer.tier),
			done: async (viewer) =>
				(await options.outbox.lastReceiptAt(viewer.principalId)) !== undefined,
			...(required && options.push.waiver
				? {
						waiver: {
							label: "Skip for now",
							confirm:
								"Skip turning on notifications? You will not hear when something needs you.",
						},
					}
				: {}),
		});
	}
	return steps;
}

async function linked(
	options: BuiltInStepsOptions,
	provider: string,
	viewer: Viewer,
): Promise<boolean> {
	const prover = options.prover(provider);
	if (prover && (await prover.status(viewer.principalId)).linked) return true;
	const identities = await options.identity.identities(viewer.principalId);
	return identities.some((link) => link.provider === provider);
}
