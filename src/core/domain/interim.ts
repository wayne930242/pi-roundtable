/** A message an interim post made, which the turn edits in place as it goes. */
export interface InterimMessage {
	edit(text: string): Promise<void>;
}

/**
 * Where a running turn posts the text it writes before its final answer: the channel the
 * final reply goes to, under the same name. Each call posts one ordinary message of at most
 * Discord's 2000 characters.
 */
export interface InterimPosts {
	post(text: string): Promise<InterimMessage>;
}

/** Whether a turn posts its intermediate text as it goes; "on" by default. */
export type InterimTextMode = "on" | "off";
