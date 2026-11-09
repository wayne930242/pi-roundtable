import type { SchedulesView, ScheduleView } from "../api-types.ts";
import type { Authenticated } from "../auth/authenticator.ts";
import { json } from "../http.ts";
import { bad, HttpError } from "./api-http.ts";

import type { AppApiOptions } from "./routes-options.ts";

/** The schedules pane: the owners see every schedule, anyone else their own. */
export class ScheduleApi {
	readonly #options: Pick<
		AppApiOptions,
		"schedules" | "rooms" | "identity" | "changed"
	>;

	constructor(
		options: Pick<
			AppApiOptions,
			"schedules" | "rooms" | "identity" | "changed"
		>,
	) {
		this.#options = options;
	}

	/** Whether a schedule is the visitor's own: its creator id names their principal. */
	async #ownSchedule(
		createdById: string,
		principalId: string,
	): Promise<boolean> {
		if (createdById === principalId) return true;
		// A schedule from 0.8 names its creator by a user id that the backfill made a principal's id.
		return (
			(await this.#options.identity.principal(createdById))?.id === principalId
		);
	}

	async schedules(
		method: string,
		id: string | undefined,
		admission: Authenticated,
	): Promise<Response> {
		const { schedules, rooms } = this.#options;
		if (!schedules) throw new HttpError(404, "This pane is not served.");
		const { tier, principal } = admission.visitor;
		const owner = tier === "owner";
		if (method === "GET" && !id) {
			const all = await schedules.all();
			const views: ScheduleView[] = [];
			for (const schedule of all) {
				// The owners see every schedule; anyone else sees their own, and no room of the owners.
				if (
					!owner &&
					!(await this.#ownSchedule(schedule.createdById, principal.id))
				)
					continue;
				const room = owner ? await rooms.resolve(schedule.channel) : undefined;
				views.push({
					id: schedule.id,
					...(room ? { room: room.key } : {}),
					channel: schedule.channel,
					label: room?.displayName ?? schedule.channel,
					title: schedule.title,
					prompt: schedule.prompt,
					recurrence: schedule.recurrence,
					nextRun: schedule.nextRun.toISOString(),
					...(schedule.lastRun
						? { lastRun: schedule.lastRun.toISOString() }
						: {}),
					...(schedule.lastStatus ? { lastStatus: schedule.lastStatus } : {}),
					createdBy: schedule.createdByName,
				});
			}
			return json({ schedules: views } satisfies SchedulesView);
		}
		if (method === "DELETE" && id) {
			const number = Number(id);
			if (!Number.isInteger(number)) throw bad("The schedule id is a number.");
			// Another person's schedule is not there to remove, for anyone but the owners.
			if (!owner) {
				const found = await schedules.get(number);
				if (
					!found ||
					!(await this.#ownSchedule(found.createdById, principal.id))
				)
					throw new HttpError(404, "There is no such schedule.");
			}
			const removed = await schedules.remove(number);
			if (!removed) throw new HttpError(404, "There is no such schedule.");
			this.#options.changed();
			return json({ ok: true });
		}
		throw new HttpError(405, "Method not allowed.");
	}
}
