// Plugin helpers, versioned like the main entry; see the plugin guide.
// The host-shell tools and the hold rule that keeps risky commands behind the owner's approval.

export {
	type PushPolicy,
	SHELL_TOOLS,
	shellHoldRule,
	shellHoldRuleFor,
} from "../core/modules/host-shell/shell-policy.ts";
