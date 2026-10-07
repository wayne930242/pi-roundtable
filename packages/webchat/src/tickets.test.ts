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

test("one person holds at most `perPrincipal` tickets; more drop only their own oldest", () => {
	const book = new TicketBook({ ttlMs: 30_000, perPrincipal: 2 });
	const victim = book.issue(ada);
	const eve = { ...ada, id: "oidc:op:eve", name: "Eve" };
	const issued = Array.from({ length: 10_000 }, () => book.issue(eve));
	expect(book.redeem(victim.ticket)).toEqual(ada);
	expect(book.redeem(issued[0]?.ticket ?? "")).toBeUndefined();
	expect(book.redeem(issued.at(-2)?.ticket ?? "")).toEqual(eve);
	expect(book.redeem(issued.at(-1)?.ticket ?? "")).toEqual(eve);
	// A spent ticket frees its place.
	const again = book.issue(eve);
	const more = book.issue(eve);
	expect(book.redeem(again.ticket)).toEqual(eve);
	expect(book.redeem(more.ticket)).toEqual(eve);
});
