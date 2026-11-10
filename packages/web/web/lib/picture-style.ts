// The styles of a person's, a file's or an outside party's picture. They load with the first
// picture drawn, as a constructed stylesheet, so the page's own stylesheet stays as small as before.

export const PICTURE_CSS = `
.hpic {
	flex: none;
	display: inline-grid;
	place-items: center;
	overflow: hidden;
	border-radius: var(--radius-full);
	background: var(--surface-3);
	color: #fff;
	font-weight: var(--weight-bold);
	line-height: 1;
	user-select: none;
}

.hpic > img {
	width: 100%;
	height: 100%;
	object-fit: cover;
}

/* A person's knight stands free on its own badge, and the place held for one not known yet is empty. */
.hpic[data-knight],
.hpic[data-wait] {
	overflow: visible;
	background: none;
}
`;
