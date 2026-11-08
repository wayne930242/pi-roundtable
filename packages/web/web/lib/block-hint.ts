/**
 * Whether a message may hold a display block (see pi-better-show): a fence whose first word is a
 * kind the app draws (display or interactive), or a GitHub alert. It is a cheap test that keeps the blocks chunk
 * from loading for a message that has none; the chunk's parser decides what really is a block.
 * `blocks.test.tsx` checks the kinds against `DISPLAY_KINDS` and `INTERACTIVE_KINDS`.
 */
export const BLOCK_HINT =
	/^ {0,3}(?:(?:```|~~~)\s*(?:alert|cards|mermaid|mindmap|diff|table|steps|stats|tree|options|suggest|form|checklist|review)\b|>\s*\[!(?:note|tip|important|warning|caution)\])/im;
