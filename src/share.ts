import { Markup } from "telegraf";
import type { Telegram } from "telegraf";
import type { Message } from "telegraf/types";
import { getConfig, type Button } from "./config.js";
import { randomStreamOnlineImage } from "./assets.js";
import type { StreamOnlineImage } from "./assets.js";
import type { Draft } from "./drafts.js";
import type { PostType } from "./postTypes.js";

/** Лимиты Telegram Bot API. */
const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;

export function inlineKeyboard() {
	const config = getConfig();
	return Markup.inlineKeyboard(chunk(config.buttons.map(toUrlButton)));
}

/** Кнопки поста по типу: лейблы резолвятся в общий список `config.buttons`. */
export function postTypeKeyboard(type: PostType) {
	const config = getConfig();
	const byLabel = new Map(config.buttons.map((b) => [b.label, b]));
	const picked: Button[] = [];
	for (const label of type.buttons) {
		const button = byLabel.get(label);
		if (button) {
			picked.push(button);
		} else {
			console.warn(`post type: no button labeled "${label}"`);
		}
	}
	// Ни один лейбл не нашёлся — лучше постить с обычными кнопками канала,
	// чем совсем без них.
	if (picked.length === 0) {
		console.warn("post type: no buttons resolved, using channel default");
		return inlineKeyboard();
	}
	return Markup.inlineKeyboard(chunk(picked.map(toUrlButton)));
}

function toUrlButton(button: Button) {
	return Markup.button.url(button.label, button.url);
}

function chunk<T>(items: T[], perRow = 2): T[][] {
	const rows: T[][] = [];
	for (let i = 0; i < items.length; i += perRow) {
		rows.push(items.slice(i, i + perRow));
	}
	return rows;
}

/** Дописывает подпись типа поста в конец текста, укладываясь в лимит Telegram. */
export function appendSignature(
	body: string,
	signature: string,
	limit: number,
): string {
	const suffix = `\n\n${signature}`;
	const text = body.trim();
	if (!text) return signature.slice(0, limit);
	const room = limit - suffix.length;
	if (room <= 0) return signature.slice(0, limit);
	if (text.length <= room) return `${text}${suffix}`;
	return `${text.slice(0, Math.max(0, room - 1)).trimEnd()}…${suffix}`;
}

/**
 * Публикует черновик в канал с кнопками и подписью выбранного типа.
 * Текст идёт через sendMessage, медиа — через copyMessage (файл не перезаливаем).
 */
export async function publishDraft(
	telegram: Telegram,
	draft: Draft,
	type: PostType,
): Promise<number | undefined> {
	const config = getConfig();
	const replyMarkup = { reply_markup: postTypeKeyboard(type).reply_markup };

	if (draft.media === "none") {
		const text = appendSignature(draft.body, type.signature, TEXT_LIMIT);
		const sent = await telegram.sendMessage(
			config.telegram.channelId,
			text,
			replyMarkup,
		);
		return sent.message_id;
	}

	if (draft.media === "captionable") {
		const caption = appendSignature(draft.body, type.signature, CAPTION_LIMIT);
		const copied = await telegram.copyMessage(
			config.telegram.channelId,
			draft.chatId,
			draft.messageId,
			{ ...replyMarkup, caption },
		);
		return copied.message_id;
	}

	// Стикер или голосовое: caption у Telegram не поддерживается, копируем как есть.
	console.log(
		"media without caption support, post published without signature",
	);
	const copied = await telegram.copyMessage(
		config.telegram.channelId,
		draft.chatId,
		draft.messageId,
		replyMarkup,
	);
	return copied.message_id;
}

export async function postToChannel(
	telegram: Telegram,
	text: string,
	options: {
		withImage?: boolean;
		image?: StreamOnlineImage | null;
	} = {},
): Promise<Message.TextMessage | Message.PhotoMessage> {
	const config = getConfig();
	const replyMarkup = { reply_markup: inlineKeyboard().reply_markup };
	const image =
		options.image === undefined && options.withImage
			? await randomStreamOnlineImage()
			: options.image;
	// Картинка только для stream.online (withImage), репосты из ЛС — текстом.
	// Картинки как «фото» — Telegram умеет JPEG/PNG (jfif это jpeg). Нет файла —
	// постим как раньше текстом. Ошибка Telegram (битый файл и т.п.) не глотается,
	// её увидят админы через существующий обработчик.
	if (options.withImage && image) {
		console.log("stream_online image:", image.path);
		return telegram.sendPhoto(
			config.telegram.channelId,
			{ source: image.data, filename: image.filename },
			{ caption: text, ...replyMarkup },
		);
	}
	return telegram.sendMessage(config.telegram.channelId, text, replyMarkup);
}

/** Сообщение всем админам (ALLOWED_USER_IDS) в личку. Ничего не бросает — уведомления best-effort. */
export async function notifyAdmins(
	telegram: Telegram,
	text: string,
): Promise<void> {
	try {
		const config = getConfig();
		const body = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
		const results = await Promise.allSettled(
			config.telegram.allowedUserIds.map((id) =>
				telegram.sendMessage(id, body),
			),
		);
		for (const result of results) {
			// В личку не долетело — пишем в лог Vercel, чтобы уведомление не потерялось.
			if (result.status === "rejected") {
				console.warn("admin notify failed:", result.reason);
			}
		}
	} catch (err) {
		console.warn("admin notify failed:", err);
		// лог в личку не должен ломать обработку запроса
	}
}

export function renderTemplate(
	template: string,
	vars: Record<string, string>,
): string {
	return template.replace(/\{(\w+)\}/g, (match, key: string) => {
		return key in vars ? vars[key] : match;
	});
}
