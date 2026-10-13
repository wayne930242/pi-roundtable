/** A failure of this package, named by a short code that is safe to store and log. */
export class LineError extends Error {
	override name = "LineError";
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

/** LINE answered a request with a status that is not a success. The message never holds a response body. */
export class LineApiError extends LineError {
	override name = "LineApiError";
	readonly status: number;
	/** `x-line-request-id` of the failed call, for LINE's support. */
	readonly requestId: string | undefined;

	constructor(
		status: number,
		code: string,
		message: string,
		requestId?: string,
	) {
		super(code, message);
		this.status = status;
		this.requestId = requestId;
	}
}

const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The code to store for a failure: its own when it is a `LineError` or carries a lower-case `code`
 * word, else `handler_error`. The message is never stored, because it may quote what a customer wrote.
 */
export function errorCode(error: unknown): string {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as { code: unknown }).code;
		if (typeof code === "string" && CODE.test(code)) return code;
	}
	return "handler_error";
}
