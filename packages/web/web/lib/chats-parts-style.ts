// The parts of a figure on the chat home move with what its agent does: the head turns about the
// neck and the held item swings, on top of the whole figure's breathing (`chats-motion-style.ts`).
// Only transform and opacity change, and the kit's own body motion stands down, because the host's
// svg already moves the whole figure. A pin moves its parts at rest too, a row only while its agent
// does something (a row at rest is drawn `static`, which stops them), at half the amplitude. A loop
// shares the figure's `--phase`, so neighbours do not move in step, and the head's nod and the
// item's sweep share one period. The selectors name the kit's `hd` and `prop` classes alone: the
// head group's inner classes carry transform attributes a rule would override.

/** Where the head turns: `PIVOTS.neck` of the kit, which a test holds equal. */
export const NECK = "50px 76px";

export const CHATS_PARTS_CSS = `
.pin {
	--hd: 1;
	--it: 1;
}

.chat-row {
	--hd: 0.5;
	--it: 0.5;
}

.pin .av-host .av .ch,
.chat-row .av-host .av .ch {
	animation: none;
}

.pin .av .hd,
.chat-row .av .hd {
	transform-box: view-box;
	transform-origin: ${NECK};
}

/* A pin at rest: a glance now and then, still for most of the cycle. */
.pin .av-host[data-state="idle"] .hd {
	animation: hd-glance 8s ease-in-out var(--phase, 0s) infinite;
}

.pin .av-host[data-state="thinking"] .hd,
.chat-row .av-host[data-state="thinking"] .hd {
	animation: hd-ponder 3.2s ease-in-out var(--phase, 0s) infinite;
}

.pin .av-host[data-state="working"] .hd,
.chat-row .av-host[data-state="working"] .hd {
	animation: hd-nod 1.12s ease-in-out var(--phase, 0s) infinite;
}

.pin .av-host[data-state="working"] .prop,
.chat-row .av-host[data-state="working"] .prop {
	animation: it-sweep 0.56s ease-in-out var(--phase, 0s) infinite alternate;
}

.pin .av-host[data-state="waiting"] .hd,
.chat-row .av-host[data-state="waiting"] .hd {
	animation: hd-cock 1.2s ease-in-out var(--phase, 0s) infinite;
}

.pin .av-host[data-state="waiting"] .prop,
.chat-row .av-host[data-state="waiting"] .prop {
	animation: it-raise 1.2s ease-in-out var(--phase, 0s) infinite;
}

.pin .av-host[data-state="done"] .hd,
.chat-row .av-host[data-state="done"] .hd {
	animation: hd-nod-once 0.6s ease-out 1;
}

.pin .av-host[data-state="done"] .prop,
.chat-row .av-host[data-state="done"] .prop {
	animation: it-flourish 0.7s cubic-bezier(0.3, 1.6, 0.5, 1) 1;
}

.pin .av-host[data-state="error"] .hd,
.chat-row .av-host[data-state="error"] .hd {
	animation: hd-shake 0.5s ease-in-out 2;
}

.pin .av-host[data-state="error"] .prop,
.chat-row .av-host[data-state="error"] .prop {
	animation: it-drop 0.6s ease-out 1 forwards;
}

.pin .av-host[data-state="sleepy"] .hd,
.chat-row .av-host[data-state="sleepy"] .hd {
	animation: hd-doze 6s ease-in-out var(--phase, 0s) infinite;
}

.pin .av-host[data-state="sleepy"] .prop,
.chat-row .av-host[data-state="sleepy"] .prop {
	transform: rotate(calc(10deg * var(--it)));
}

/* A new message. */
.pin[data-pop] .av .hd,
.chat-row[data-pop] .av .hd {
	animation: hd-perk 450ms cubic-bezier(0.34, 1.56, 0.64, 1) 1;
}

.pin[data-pop] .av .prop,
.chat-row[data-pop] .av .prop {
	animation: it-hop 450ms cubic-bezier(0.34, 1.56, 0.64, 1) 1;
}

/* A press ducks the head, but not while a pin is held to move it. */
[data-pin-item]:not([data-lifted]) .pin:active .av .hd,
.chat-row:active .av .hd {
	animation: none;
	transform: translateY(calc(2px * var(--hd)));
}

@keyframes hd-glance {
	0%,
	56%,
	84%,
	100% {
		transform: rotate(0);
	}
	62%,
	72% {
		transform: rotate(calc(4deg * var(--hd)));
	}
}

@keyframes hd-ponder {
	0%,
	100% {
		transform: rotate(calc(-5deg * var(--hd)));
	}
	50% {
		transform: rotate(calc(5deg * var(--hd)));
	}
}

@keyframes hd-nod {
	0%,
	100% {
		transform: translateY(0);
	}
	50% {
		transform: translateY(calc(1.6px * var(--hd))) rotate(calc(1deg * var(--hd)));
	}
}

@keyframes hd-cock {
	0%,
	100% {
		transform: rotate(calc(-6deg * var(--hd)));
	}
	50% {
		transform: rotate(calc(-8deg * var(--hd)));
	}
}

@keyframes hd-nod-once {
	0%,
	100% {
		transform: translateY(0);
	}
	40% {
		transform: translateY(calc(2.4px * var(--hd)));
	}
}

@keyframes hd-shake {
	0%,
	100% {
		transform: rotate(0);
	}
	25% {
		transform: rotate(calc(-5deg * var(--hd)));
	}
	75% {
		transform: rotate(calc(5deg * var(--hd)));
	}
}

@keyframes hd-doze {
	0%,
	100% {
		transform: rotate(calc(5deg * var(--hd))) translateY(1px);
	}
	50% {
		transform: rotate(calc(7deg * var(--hd))) translateY(1.8px);
	}
}

@keyframes hd-perk {
	0%,
	100% {
		transform: translateY(0);
	}
	35% {
		transform: translateY(calc(-2.6px * var(--hd))) rotate(calc(-4deg * var(--hd)));
	}
	70% {
		transform: translateY(calc(0.6px * var(--hd)));
	}
}

@keyframes it-sweep {
	from {
		transform: rotate(calc(-9deg * var(--it)));
	}
	to {
		transform: rotate(calc(9deg * var(--it)));
	}
}

@keyframes it-raise {
	0%,
	100% {
		transform: rotate(calc(-6deg * var(--it)));
	}
	50% {
		transform: rotate(calc(-10deg * var(--it)));
	}
}

@keyframes it-flourish {
	0%,
	100% {
		transform: rotate(0);
	}
	40% {
		transform: rotate(calc(-16deg * var(--it)));
	}
	70% {
		transform: rotate(calc(4deg * var(--it)));
	}
}

@keyframes it-drop {
	0% {
		transform: rotate(0);
	}
	60% {
		transform: rotate(calc(12deg * var(--it)));
	}
	100% {
		transform: rotate(calc(8deg * var(--it)));
	}
}

@keyframes it-hop {
	0%,
	100% {
		transform: rotate(0) translateY(0);
	}
	35% {
		transform: rotate(calc(-12deg * var(--it))) translateY(-2px);
	}
	70% {
		transform: rotate(calc(4deg * var(--it)));
	}
}

@media (prefers-reduced-motion: reduce) {
	.pin .av *,
	.chat-row .av * {
		animation: none !important;
	}

	.pin .av .hd,
	.pin .av .prop,
	.chat-row .av .hd,
	.chat-row .av .prop {
		transform: none !important;
	}
}
`;
