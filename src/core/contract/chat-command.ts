/**
 * A Pi extension command (one a package or session tool registers with `pi.registerCommand`) that a
 * plugin vouches for as safe to run from a chat message: it needs no screen and does not control
 * the session. Pi runs a message that starts with `/` and names a registered command instead of
 * sending it to the model, so only the owner's message can start one. The room's command menu
 * lists the declared commands to the owner.
 */
export interface ChatCommand {
	/** Without the slash: lowercase letters, digits, dashes and underscores, starting with a letter. `clear`, `new` and `skill` are the app's own. */
	name: string;
	/** One line for the menu. */
	description: string;
}
