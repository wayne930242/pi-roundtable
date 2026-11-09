import type { Migration } from "pi-roundtable";
import { HostCardLog } from "../host/cards.ts";
import { RoomReads } from "../host/reads.ts";
import { NOTICE_MIGRATIONS } from "../notices/mount.ts";
import { PushMutes } from "../push/mutes.ts";
import { PushSubscriptions } from "../push/subscriptions.ts";
import { CardLog } from "./card-log.ts";
import { RoomLayout } from "./layout.ts";
import { RoomLog } from "./room-log.ts";
import { WebThreads } from "./threads.ts";

/** The tables the app keeps; the plugin lists them as its own migrations. */
export const APP_MIGRATIONS: readonly Migration[] = [
	RoomLog.migration,
	RoomLog.hostMigration,
	RoomLog.noteMigration,
	RoomLog.intercomMigration,
	RoomLog.startOverMigration,
	RoomLog.jsonValuesMigration,
	RoomLog.deliveryMigration,
	RoomLog.blockAnswersMigration,
	RoomLog.blockAnswersMessageIndexMigration,
	HostCardLog.migration,
	HostCardLog.keepMigration,
	HostCardLog.jsonValuesMigration,
	RoomReads.migration,
	CardLog.migration,
	CardLog.jsonValuesMigration,
	WebThreads.migration,
	WebThreads.dismissedMigration,
	PushSubscriptions.migration,
	PushMutes.migration,
	RoomLayout.migration,
	RoomLayout.hiddenMigration,
	...NOTICE_MIGRATIONS,
];
