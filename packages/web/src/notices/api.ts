import { ConsoleHttpError as HttpError, json } from "../http.ts";
import type { FrameHandler, PluggedFrames, RouteArea } from "../web-app.ts";
import type { NoticeService } from "./service.ts";

/**
 * `GET api/notices` and `POST api/notices/<tag>/ack`. Both are the signed-in person's own: the
 * principal is the session's, and a notice not addressed to them answers 404 as if there were none.
 */
export function noticesArea(notices: NoticeService): RouteArea {
	return {
		area: "notices",
		async handle(request, parts, { visitor }) {
			try {
				const principalId = visitor.principal.id;
				const [tag, action] = parts;
				if (tag === undefined && request.method === "GET")
					return json(await notices.listFor(principalId));
				if (tag !== undefined && action === "ack" && parts.length === 2) {
					if (request.method !== "POST")
						throw new HttpError(405, "Method not allowed.");
					if (!(await notices.ack(tag, principalId)))
						throw new HttpError(404, "There is no such notice to handle.");
					return json({ ok: true });
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

/** The `ack` frame: the person handled a notice. A notice that is not theirs, or needs no answer, is refused. */
export function ackFrame(
	notices: NoticeService,
): FrameHandler<PluggedFrames["ack"]> {
	return async ({ frame, viewer, refuse }) => {
		if (!(await notices.ack(frame.tag, viewer.principalId)))
			refuse("not_accepted");
	};
}
