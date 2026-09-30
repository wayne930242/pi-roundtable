import type { CatalogContext } from "./types.ts";

/** What each channel operation is called in the owner's grant panels. */
export function channelsEn(_ctx: CatalogContext) {
	return {
		opRead: "Read messages and channel data",
		opSend: "Send text, images, and attachments",
		opEdit: "Edit the bot's messages and attachments",
		opPin: "Pin and unpin",
		opDelete: "Delete messages",
		opChannel: "Change channel settings",
		opPermissions: "Change channel permissions",
	};
}

export function channelsZhTW(
	_ctx: CatalogContext,
): ReturnType<typeof channelsEn> {
	return {
		opRead: "讀取訊息與頻道資料",
		opSend: "發送文字、圖片與附件",
		opEdit: "修改 Bot 訊息與附件",
		opPin: "置頂與取消置頂",
		opDelete: "刪除訊息",
		opChannel: "修改頻道設定",
		opPermissions: "修改頻道權限",
	};
}
