// The figures' motion on the chat home: the whole figure moves by transform alone, from its feet, so
// nothing around it shifts and no script runs per frame. A figure breathes at rest, sways while its
// agent works, pops once for a new unread message and squashes under a press. The rows use a smaller
// amplitude than the pins. Reduced motion turns all of it off.

export const CHATS_MOTION_CSS = `
.pin,
.chat-row {
	--breathe: 1.03;
	--sway: 6deg;
	--bob: -2px;
	--pop: 1.18;
	--wiggle: 8deg;
}

.chat-row {
	--breathe: 1.015;
	--sway: 3deg;
	--bob: -1px;
	--pop: 1.1;
	--wiggle: 4deg;
}

.pin .av-host,
.chat-row .av-host {
	transform-origin: 50% 100%;
	transition: transform 160ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

.pin[data-motion="idle"] .av-host,
.chat-row[data-motion="idle"] .av-host {
	animation: fig-breathe 3s ease-in-out var(--phase, 0s) infinite;
}

.pin[data-motion="working"] .av-host,
.chat-row[data-motion="working"] .av-host {
	animation: fig-sway 0.9s ease-in-out var(--phase, 0s) infinite;
}

.pin[data-pop] .av-host,
.chat-row[data-pop] .av-host {
	animation: fig-pop 450ms cubic-bezier(0.34, 1.56, 0.64, 1) 1;
}

.pin:active .av-host,
.chat-row:active .av-host {
	animation: none;
	transform: scale(1.06, 0.9);
}

@keyframes fig-breathe {
	50% {
		transform: scale(var(--breathe));
	}
}

@keyframes fig-sway {
	0%,
	100% {
		transform: rotate(calc(var(--sway) * -1)) translateY(0);
	}
	50% {
		transform: rotate(var(--sway)) translateY(var(--bob));
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
	.pin .av-host,
	.chat-row .av-host {
		animation: none;
		transition: none;
	}

	.pin:active .av-host,
	.chat-row:active .av-host {
		transform: none;
	}
}
`;
