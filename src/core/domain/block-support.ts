import type { BlockKind } from "pi-better-show";

/** How a block that a surface does not draw reads as text. */
export type BlockTextFlavor = "discord" | "line" | "plain";

/** What a surface says about display blocks (see pi-better-show): the kinds it draws and the text it reads the rest as. */
export interface BlockSupport {
	/** The kinds drawn by the surface itself; absent = none. */
	readonly blocks?: readonly BlockKind[];
	/** The flavor of text for the other kinds; absent = `discord`. */
	readonly blockText?: BlockTextFlavor;
}
