// Plugin helpers, versioned like the main entry; see the plugin guide.
// The host-shell tools and the hold rule that keeps risky commands behind the owner's approval.

export {
	SHELL_TOOLS,
	shellHoldRule,
} from "../core/modules/host-shell/shell-policy.ts";
