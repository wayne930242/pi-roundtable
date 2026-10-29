import type { FormInput } from "../../src/api-types.ts";
import type {
	HostActionResult,
	HostListView,
	HostMessagesView,
	HostPageView,
	HostRoomView,
	OpenView,
} from "../../src/host/views.ts";
import { request } from "./api.ts";
import { translate as t, wording } from "./messages.ts";
import { hrefFor } from "./router.ts";
import { followUrl } from "./where.ts";

const part = encodeURIComponent;

/** The refusals the app itself words when it checks a form; a host's own are its own wording. */
const CORE_REFUSALS: ReadonlySet<string> = new Set([
	wording("This action takes no form."),
	wording("The form has no such field."),
	wording("This field is required."),
	wording("Choose from the list."),
	wording("This field takes one value."),
	wording("This field is too long."),
	wording("Give a web address."),
	wording("The action could not be done."),
]);

/** A refusal in the page's words when the app worded it. */
export const refusalText = (error: string): string =>
	CORE_REFUSALS.has(error) ? t(error) : error;

/** A host room's key `<surface>:<kind>.<id>`, split; undefined for a key of another shape. */
export function splitRoomKey(
	key: string,
): { kind: string; id: string } | undefined {
	const colon = key.indexOf(":");
	const dot = key.lastIndexOf(".");
	if (colon < 0 || dot < colon + 2 || dot === key.length - 1) return undefined;
	return { kind: key.slice(colon + 1, dot), id: key.slice(dot + 1) };
}

export const hostApi = {
	list: (kind: string, filter?: string, cursor?: string) => {
		const query = new URLSearchParams();
		if (filter) query.set("filter", filter);
		if (cursor) query.set("cursor", cursor);
		const text = query.toString();
		return request<HostListView>(`host/${part(kind)}${text ? `?${text}` : ""}`);
	},
	open: (kind: string, id: string) =>
		request<HostRoomView>(`host/${part(kind)}/${part(id)}`),
	older: (kind: string, id: string, before: number, limit: number) =>
		request<HostMessagesView>(
			`host/${part(kind)}/${part(id)}/messages?before=${before}&limit=${limit}`,
		),
	act: (
		kind: string,
		id: string,
		press: { action: string; card?: string; input?: FormInput },
	) =>
		request<HostActionResult>(`host/${part(kind)}/${part(id)}/act`, {
			method: "POST",
			body: JSON.stringify(press),
		}),
	page: (id: string, query: Readonly<Record<string, string>>) => {
		const text = new URLSearchParams(query).toString();
		return request<HostPageView>(`pages/${part(id)}${text ? `?${text}` : ""}`);
	},
	pageAct: (id: string, press: { action: string; input?: FormInput }) =>
		request<HostActionResult>(`pages/${part(id)}/act`, {
			method: "POST",
			body: JSON.stringify(press),
		}),
};

/** The address a room, or a message of it, or a page has in the app. */
export function addressOf(target: OpenView): string {
	if ("room" in target) {
		const message =
			target.message === undefined ? "" : `?message=${target.message}`;
		return `${hrefFor("room", target.room)}${message}`;
	}
	const query = new URLSearchParams(target.query ?? {}).toString();
	return `${hrefFor("p", target.page)}${query ? `?${query}` : ""}`;
}

/** Goes to the room, message or page an action named. */
export function openTarget(target: OpenView): void {
	followUrl(new URL(addressOf(target), document.baseURI));
}
