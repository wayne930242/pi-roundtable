export const EXPRESSIONS = [
	"neutral",
	"happy",
	"thinking",
	"concerned",
	"apologetic",
	"surprised",
	"proud",
	"amused",
	"curious",
	"sympathetic",
	"playful",
	"determined",
	"sleepy",
] as const;

export type Expression = (typeof EXPRESSIONS)[number];

export function isExpression(value: string): value is Expression {
	return (EXPRESSIONS as readonly string[]).includes(value);
}
