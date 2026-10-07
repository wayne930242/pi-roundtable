import { expect, test } from "bun:test";
import { TicketBook } from "./tickets.ts";

const ada = {
	id: "oidc:op:ada",
	name: "Ada",
	roles: [],
	expiresAt: new Date(Date.now() + 60_000),
};

test("a ticket is spent once, by the token's person", () => {
	const book = new TicketBook({ ttlMs: 30_000 });
	const { ticket, expiresAt } = book.issue(ada);
	expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30_000);
	expect(book.redeem(ticket)).toEqual(ada);
	expect(book.redeem(ticket)).toBeUndefined();
	expect(book.redeem("made-up")).toBeUndefined();
});

test("an old ticket is refused, and one never outlives its token", () => {
	let now = 1_000_000;
	const book = new TicketBook({ ttlMs: 30_000, now: () => now });
	const late = book.issue({ ...ada, expiresAt: new Date(now + 60_000) });
	now += 30_001;
	expect(book.redeem(late.ticket)).toBeUndefined();
	const short = book.issue({ ...ada, expiresAt: new Date(now + 5_000) });
	expect(short.expiresAt.getTime()).toBe(now + 5_000);
	now += 5_001;
	expect(book.redeem(short.ticket)).toBeUndefined();
});

test("holds at most `max` tickets, dropping the oldest first", () => {
	const book = new TicketBook({ ttlMs: 30_000, max: 2 });
	const first = book.issue(ada);
	const second = book.issue(ada);
	const third = book.issue(ada);
	expect(book.redeem(first.ticket)).toBeUndefined();
	expect(book.redeem(second.ticket)).toEqual(ada);
	expect(book.redeem(third.ticket)).toEqual(ada);
});
