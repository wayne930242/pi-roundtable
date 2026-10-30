// Web Animations for the tests that watch a motion: happy-dom has the call but never runs a clock,
// so an animation here ends when the test says it does (or at once, with `auto`).

interface StubAnimation {
	keyframes: Keyframe[];
	options: KeyframeAnimationOptions;
	target: Element;
	cancelled: boolean;
	finished: Promise<unknown>;
	/** Ends the animation as a clock would. */
	finish(): void;
	cancel(): void;
}

export interface AnimationStub {
	/** Every animation started since the last `restore` or `clear`, in order. */
	animations: StubAnimation[];
	clear(): void;
	restore(): void;
}

export function stubAnimations(auto = false): AnimationStub {
	const original = Reflect.get(HTMLElement.prototype, "animate");
	const animations: StubAnimation[] = [];
	Reflect.set(
		HTMLElement.prototype,
		"animate",
		function (
			this: Element,
			keyframes: Keyframe[],
			options: KeyframeAnimationOptions,
		) {
			let end: (value?: unknown) => void = () => undefined;
			let fail: (reason?: unknown) => void = () => undefined;
			const finished = new Promise<unknown>((resolve, reject) => {
				end = resolve;
				fail = reject;
			});
			// A cancelled animation rejects `finished`; a test that never reads it must not fail on it.
			finished.catch(() => undefined);
			const one: StubAnimation = {
				keyframes,
				options,
				target: this,
				cancelled: false,
				finished,
				finish: () => end(),
				cancel: () => {
					one.cancelled = true;
					fail(new DOMException("cancelled", "AbortError"));
				},
			};
			animations.push(one);
			if (auto) end();
			return one;
		},
	);
	return {
		animations,
		clear: () => {
			animations.length = 0;
		},
		restore: () => {
			Reflect.set(HTMLElement.prototype, "animate", original);
		},
	};
}
