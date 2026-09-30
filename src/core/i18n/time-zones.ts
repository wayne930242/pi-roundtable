/** A zone's place name: the last part of its IANA id, underscores as spaces ("America/New_York" is "New York"). */
function zoneCity(zone: string): string {
	return (zone.split("/").at(-1) ?? zone).replaceAll("_", " ");
}

/** The zone wording of one catalog, from how it names a zone. */
function zoneWording(place: (zone: string) => string) {
	const zoneTime = (zone: string) => `${place(zone)} time`;
	return {
		zoneName: place,
		zoneTime,
		atTimeError: (zone: string) =>
			`at must be ${zoneTime(zone)} as "YYYY-MM-DD HH:MM"`,
		repeatingTimeError: (zone: string) =>
			`give at ("YYYY-MM-DD HH:MM") for one run, or time ("HH:MM", ${place(zone)}) to repeat`,
	};
}

/** Time-zone wording shared by prompts and schedule tools; the English catalog names a zone by its IANA id. */
export function timeZonesEn() {
	return zoneWording((zone) => zone);
}

/** The Traditional Chinese catalog names a zone by its city, so no zone has a wording of its own. */
export function timeZonesZhTW(): ReturnType<typeof timeZonesEn> {
	return zoneWording(zoneCity);
}
