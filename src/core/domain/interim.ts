import type { BlockSupport } from "./block-support.ts";

/** A message an interim post made, which the turn edits in place as it goes. */
export interface InterimMessage {
	edit(text: string): Promise<void>;
}

/**
 * Where a running turn posts the text it writes before its final answer: the channel the
 * final reply goes to, under the same name. Each call posts one ordinary message of at most
 * Discord's 2000 characters. The surface's block support (`blocks`, `blockText`) says how the text
 * is cut: the host's surface port fills it in from the surface that serves the channel.
 */
export interface InterimPosts extends BlockSupport {
	post(text: string): Promise<InterimMessage>;
	/**
	 * Whether the turn's progress message names the tools it called, on a line of its own; true
	 * unless false. A surface that shows the tools elsewhere, such as a progress pane, sets false:
	 * the progress message then carries only the turn's narration, and a run that wrote none posts
	 * nothing.
	 */
	tools?: boolean;
}

/** Whether a turn posts its intermediate text as it goes; "on" by default. */
export type InterimTextMode = "on" | "off";
