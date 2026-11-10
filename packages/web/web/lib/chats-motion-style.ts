// The figures' motion on the chat home: the whole figure moves by transform alone, from its feet, so
// nothing around it shifts and no script runs per frame. The figure alone moves: the accent badge's
// disc and ring stay still. A figure breathes at rest and while its agent works, pops once for a new
// unread message and squashes under a press (not while a pin is held to move it). The rows use a
// smaller amplitude than the pins. Reduced motion turns all of it off. The head and the held item
// move on top of this, see `chats-parts-style.ts`.

export const CHATS_MOTION_CSS = `
.pin,
.chat-row {
	--breathe: 1.03;
	--pop: 1.18;
	--wiggle: 8deg;
}

.chat-row {
	--breathe: 1.015;
	--pop: 1.1;
	--wiggle: 4deg;
}

.pin .av-host > svg,
.chat-row .av-host > svg {
	transform-origin: 50% 100%;
	transition: transform 160ms cubic-bezier(0.34, 1.56, 0.64, 1);
	animation: fig-breathe 3s ease-in-out var(--phase, 0s) infinite;
}

.pin .av-host[data-state="done"] > svg,
.pin .av-host[data-state="error"] > svg,
.chat-row .av-host[data-state="done"] > svg,
.chat-row .av-host[data-state="error"] > svg {
	animation: none;
}

.pin[data-pop] .av-host > svg,
.chat-row[data-pop] .av-host > svg {
	animation: fig-pop 450ms cubic-bezier(0.34, 1.56, 0.64, 1) 1;
}

/* A pin held to move it is pressed too, but stays as it is. */
[data-pin-item]:not([data-lifted]) .pin:active .av-host > svg,
.chat-row:active .av-host > svg {
	animation: none;
	transform: scale(1.06, 0.9);
}

@keyframes fig-breathe {
	50% {
		transform: scale(var(--breathe));
	}
}

@keyframes fig-pop {
	0% {
		transform: scale(1);
	}
	35% {
		transform: scale(var(--pop)) rotate(calc(var(--wiggle) * -1));
	}
	55% {
		transform: scale(0.95) rotate(var(--wiggle));
	}
	75% {
		transform: scale(1.02) rotate(calc(var(--wiggle) * -0.5));
	}
	100% {
		transform: scale(1);
	}
}

@media (prefers-reduced-motion: reduce) {
	.pin .av-host > svg,
	.chat-row .av-host > svg {
		animation: none;
		transition: none;
	}

	[data-pin-item]:not([data-lifted]) .pin:active .av-host > svg,
	.chat-row:active .av-host > svg {
		transform: none;
	}
}
`;
