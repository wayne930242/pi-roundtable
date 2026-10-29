import { ConsoleHttpError as HttpError, json } from "../http.ts";
import type { RouteArea } from "../web-app.ts";
import type { OnboardingService } from "./service.ts";

/**
 * `GET api/onboarding` lists the steps that apply to the person; `POST api/onboarding/<step>/waive`
 * waives a required step that offers a waiver. The principal is the session's.
 */
export function onboardingArea(onboarding: OnboardingService): RouteArea {
	return {
		area: "onboarding",
		async handle(request, parts, { viewer }) {
			try {
				const [step, action] = parts;
				if (step === undefined && request.method === "GET")
					return json(await onboarding.view(viewer));
				if (step !== undefined && action === "waive" && parts.length === 2) {
					if (request.method !== "POST")
						throw new HttpError(405, "Method not allowed.");
					if (!(await onboarding.waive(viewer.principalId, step)))
						throw new HttpError(400, "That step cannot be waived.");
					return json(await onboarding.view(viewer));
				}
				throw new HttpError(404, "There is no such API.");
			} catch (error) {
				if (error instanceof HttpError)
					return json({ error: error.message }, error.status);
				throw error;
			}
		},
	};
}
