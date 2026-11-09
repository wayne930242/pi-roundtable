// The chip the chat home filters by, kept for the visit: opening a room and coming back finds the
// list as it was left. A folder that is gone is handled by the list, which shows everything.

let chip = "all";

export const lastChip = (): string => chip;
export const rememberChip = (id: string): void => {
	chip = id;
};
