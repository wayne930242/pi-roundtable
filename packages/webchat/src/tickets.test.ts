import { expect, test } from "bun:test";
import { TicketBook } from "./tickets.ts";

const ada = {
	id: "oidc:op:ada",
	name: "Ada",
	roles: [],
	expiresAt: new Date(Date.now() + 60_000),
};
const held = (identity = ada, principalId = "p_ada") => ({
	identity,
	principalId,
});

test("a ticket is spent once and retains the principal it was issued for", () => {
	const book = new TicketBook({ ttlMs: 30_000 });
	const { ticket, expiresAt } = book.issue(ada, "p_ada");
	expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30_000);
	expect(book.redeem(ticket)).toEqual(held());
	expect(book.redeem(ticket)).toBeUndefined();
	expect(book.redeem("made-up")).toBeUndefined();
});

test("an old ticket is refused, and one never outlives its token", () => {
	let now = 1_000_000;
	const book = new TicketBook({ ttlMs: 30_000, now: () => now });
	const late = book.issue(
		{ ...ada, expiresAt: new Date(now + 60_000) },
		"p_ada",
	);
	now += 30_001;
	expect(book.redeem(late.ticket)).toBeUndefined();
	const short = book.issue(
		{ ...ada, expiresAt: new Date(now + 5_000) },
		"p_ada",
	);
	expect(short.expiresAt.getTime()).toBe(now + 5_000);
	now += 5_001;
	expect(book.redeem(short.ticket)).toBeUndefined();
});

test("holds at most max tickets, dropping the oldest first", () => {
	const book = new TicketBook({ ttlMs: 30_000, max: 2 });
	const first = book.issue(ada, "p_ada");
	const second = book.issue(ada, "p_ada");
	const third = book.issue(ada, "p_ada");
	expect(book.redeem(first.ticket)).toBeUndefined();
	expect(book.redeem(second.ticket)).toEqual(held());
	expect(book.redeem(third.ticket)).toEqual(held());
});

test("linked actors share ticket limits without evicting another principal", () => {
	const book = new TicketBook({ ttlMs: 30_000, perPrincipal: 2 });
	const victim = book.issue(ada, "p_ada");
	const eve = { ...ada, id: "oidc:op:eve", name: "Eve" };
	const issued = Array.from({ length: 100 }, (_, i) =>
		book.issue({ ...eve, id: `eve-${i}` }, "p_eve"),
	);
	expect(book.redeem(victim.ticket)).toEqual(held());
	expect(book.redeem(issued[0]?.ticket ?? "")).toBeUndefined();
	expect(book.redeem(issued.at(-2)?.ticket ?? "")?.principalId).toBe("p_eve");
	expect(book.redeem(issued.at(-1)?.ticket ?? "")?.principalId).toBe("p_eve");
	const again = book.issue(eve, "p_eve");
	const more = book.issue(eve, "p_eve");
	expect(book.redeem(again.ticket)).toEqual(held(eve, "p_eve"));
	expect(book.redeem(more.ticket)).toEqual(held(eve, "p_eve"));
});
