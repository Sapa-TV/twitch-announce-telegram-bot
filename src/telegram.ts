import { type Context, Markup, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import type { Message } from "telegraf/types";
import { getConfig } from "./config.js";
import { describeTelegramFailure } from "./errors.js";
import { dropDraft, peekDraft, saveDraft, type MediaKind } from "./drafts.js";
import type { PostTypeId } from "./config.js";
import { notifyAdmins, publishDraft, renderTemplate } from "./share.js";
import { findWindow, hourInTimeZone } from "./time.js";
import {
	deleteEventSub,
	getEventSubStatus,
	missingTwitchEnv,
	subscribeIfNeeded,
	twitchConfigured,
} from "./twitch.js";

let botInstance: Telegraf | null = null;

const FORWARDABLE_MEDIA_KEYS = [
	"animation",
	"audio",
	"document",
	"photo",
	"sticker",
	"video",
	"video_note",
	"voice",
] as const;

/** Медиа, у которых в Telegram есть поле caption — в них впишется подпись. */
const CAPTIONABLE_MEDIA_KEYS = [
	"animation",
	"audio",
	"document",
	"photo",
	"video",
	"video_note",
] as const;

/** Префикс callback_data нового флоу. Не пересекается с `twitch_*`. */
const POST_ACTION_PREFIX = "post:";
const CANCEL_TYPE = "cancel" as const;

type ActionRun = () => Promise<string>;

function hasForwardableMedia(message: Message): boolean {
	return FORWARDABLE_MEDIA_KEYS.some((key) => key in message);
}

function mediaKindOf(message: Message): MediaKind {
	if (!hasForwardableMedia(message)) return "none";
	return CAPTIONABLE_MEDIA_KEYS.some((key) => key in message)
		? "captionable"
		: "plain";
}

/** То, что попадёт в пост. */
function bodyOf(message: Message): string {
	if ("text" in message) return message.text;
	if ("caption" in message && message.caption) return message.caption;
	return "";
}

/** Отвечает на нажатие кнопки: показывает и результат, и понятную причину сбоя. */
async function runAction(
	ctx: Context,
	title: string,
	run: ActionRun,
): Promise<void> {
	await ctx.answerCbQuery().catch(() => undefined);
	try {
		await ctx.reply(await run());
	} catch (err) {
		console.error(`${title} failed:`, err);
		await ctx
			.reply(`❌ ${title}: не получилось\n${describeTelegramFailure(err)}`)
			.catch(() => undefined);
	}
}

/**
 * Спрашивает, что за пост прислали. Список кнопок зависит от текущего часа
 * МСК: попали в стримовое окно — 2 варианта, не попали — 3.
 */
async function askPostType(
	ctx: Context,
	source: {
		userId: number;
		chatId: number;
		messageId: number;
		body: string;
		media: MediaKind;
	},
): Promise<void> {
	const config = getConfig();
	const posts = config.posts;
	const hour = hourInTimeZone(new Date(), posts.timezone);
	const window = findWindow(hour, posts.windows);

	const options: PostTypeId[] = window
		? [window.suggest, ...posts.questions.inWindowExtra]
		: posts.questions.outOfWindowOptions;
	const label = window ? posts.types[window.suggest].label : "";
	const question = renderTemplate(
		window ? posts.questions.inWindow : posts.questions.outOfWindow,
		{
			hour: String(hour),
			from: window ? String(window.from) : "",
			to: window ? String(window.to) : "",
			label,
		},
	);

	const keyboard = Markup.inlineKeyboard([
		options.map((id) =>
			Markup.button.callback(
				posts.types[id].label,
				`${POST_ACTION_PREFIX}${id}`,
			),
		),
		[Markup.button.callback("Отмена", `${POST_ACTION_PREFIX}${CANCEL_TYPE}`)],
	]);

	const sent = await ctx.reply(question, keyboard);
	await saveDraft({
		...source,
		questionChatId: sent.chat.id,
		questionMessageId: sent.message_id,
		createdAt: Date.now(),
	});
}

/** Публикует сохранённый черновик в канал и дописывает в вопрос итог. */
async function publishAndConfirm(
	ctx: Context,
	userId: number,
	typeId: string,
): Promise<void> {
	const config = getConfig();
	const posts = config.posts;
	const draft = await peekDraft(userId);

	if (!draft) {
		const text = renderTemplate(posts.replies.expired, {
			minutes: String(Math.round(posts.draftTtlMs / 60000)),
		});
		await ctx.answerCbQuery(text).catch(() => undefined);
		await replaceQuestion(ctx, text);
		return;
	}

	if (typeId === CANCEL_TYPE) {
		await dropDraft(userId);
		await ctx.answerCbQuery("Отменено").catch(() => undefined);
		await replaceQuestion(ctx, posts.replies.cancelled);
		return;
	}

	const type = posts.types[typeId as PostTypeId];
	if (!type) {
		await ctx
			.answerCbQuery(`Неизвестный тип поста: ${typeId}`)
			.catch(() => undefined);
		return;
	}

	await ctx.answerCbQuery("Публикую…").catch(() => undefined);
	try {
		const messageId = await publishDraft(
			ctx.telegram,
			draft,
			typeId as PostTypeId,
		);
		console.log(
			"post published to Telegram, type:",
			typeId,
			"message_id:",
			messageId,
		);
	} catch (err) {
		// Черновик оставляем — по той же кнопке можно повторить.
		console.error("post publish failed:", err);
		const text = renderTemplate(posts.replies.failed, {
			label: type.label,
			error: describeTelegramFailure(err, `канал ${config.telegram.channelId}`),
		});
		await ctx.answerCbQuery("Не получилось").catch(() => undefined);
		await replaceQuestion(ctx, text);
		return;
	}

	await dropDraft(userId);
	await replaceQuestion(
		ctx,
		renderTemplate(posts.replies.published, { label: type.label }),
	);
	if (config.telegram.replyToAuthor) {
		await ctx.reply("Опубликовано").catch(() => undefined);
	}
}

/** Вопрос живёт в личке — переписываем его вместо нового сообщения. */
async function replaceQuestion(ctx: Context, text: string): Promise<void> {
	await ctx
		.editMessageText(text)
		.catch(() => ctx.reply(text).catch(() => undefined));
}

export function getBot(): Telegraf {
	if (!botInstance) {
		botInstance = createBot();
	}
	return botInstance;
}

function createBot(): Telegraf {
	const config = getConfig();
	const bot = new Telegraf(config.telegram.token);

	bot.on(message(), async (ctx, next) => {
		if (!config.telegram.allowedUserIds.includes(ctx.from.id)) return;
		const text =
			"text" in ctx.message && ctx.message.text.length > 0
				? ctx.message.text
				: undefined;
		if (text?.startsWith("/")) return next();
		if (!text && !hasForwardableMedia(ctx.message)) return next();

		const body = bodyOf(ctx.message);
		// Медиа без подписи само по себе не пусто, а вот текст из пробелов в
		// канал не отправишь — Telegram вернёт 400 на пустой text.
		if (body.trim() === "" && !hasForwardableMedia(ctx.message)) {
			await ctx
				.reply("Пустое сообщение — публиковать нечего.")
				.catch(() => undefined);
			return;
		}

		try {
			// Сначала вопрос, публикация — только после выбора типа.
			await askPostType(ctx, {
				userId: ctx.from.id,
				chatId: ctx.chat.id,
				messageId: ctx.message.message_id,
				body,
				media: mediaKindOf(ctx.message),
			});
		} catch (err) {
			// Не смогли даже спросить — автору сразу причина, а не стек из bot.catch.
			console.error("post type question failed:", err);
			await ctx
				.reply(
					`❌ Не удалось задать вопрос о типе поста:\n${describeTelegramFailure(err)}`,
				)
				.catch(() => undefined);
		}
	});

	bot.action(new RegExp(`^${POST_ACTION_PREFIX}(.+)$`), async (ctx) => {
		const [, typeId] = ctx.match;
		const userId = ctx.from?.id;
		if (!userId) {
			await ctx
				.answerCbQuery("Не удалось определить автора")
				.catch(() => undefined);
			return;
		}
		await publishAndConfirm(ctx, userId, typeId);
	});

	bot.command("menu", async (ctx) => {
		// Без Twitch-кредов кнопки управления подпиской бесполезны — каждое
		// нажатие всё равно упало бы. Показываем только текст.
		if (!twitchConfigured()) {
			await ctx.reply(
				`Бот постинга. Уведомления о начале стрима выключены: не заданы ${missingTwitchEnv().join(", ")}. Постинг в канал работает.`,
			);
			return;
		}
		await ctx.reply(
			"Бот постинга — управление Twitch:",
			Markup.inlineKeyboard([
				Markup.button.callback("Статус подписки", "twitch_status"),
				Markup.button.callback("Включить", "twitch_on"),
				Markup.button.callback("Выключить", "twitch_off"),
			]),
		);
	});

	// Кнопки из старых сообщений с меню остаются в чате — отвечаем на них
	// внятным текстом, а не ошибкой.
	bot.action(/^twitch_(status|on|off)$/, async (ctx) => {
		await ctx.answerCbQuery().catch(() => undefined);
		await ctx
			.reply(`Twitch не настроен: не заданы ${missingTwitchEnv().join(", ")}.`)
			.catch(() => undefined);
	});

	if (twitchConfigured()) {
		bot.action("twitch_status", (ctx) =>
			runAction(ctx, "Статус подписки", async () => {
				const sub = await getEventSubStatus();
				return sub ? `Статус: ${sub.status} (id ${sub.id})` : "Подписки нет";
			}),
		);

		bot.action("twitch_on", (ctx) =>
			runAction(ctx, "Включение подписки", async () => {
				const result = await subscribeIfNeeded();
				return result.changed
					? "Подписка создаётся (ждёт подтверждения Twitch)…"
					: "Подписка уже активна";
			}),
		);

		bot.action("twitch_off", (ctx) =>
			runAction(ctx, "Выключение подписки", async () => {
				const deleted = await deleteEventSub();
				return deleted > 0
					? `Подписка удалена (${deleted})`
					: "Подписки не было";
			}),
		);
	}

	bot.catch((err, ctx) => {
		console.error("bot error:", err, ctx.update);
		void notifyAdmins(
			bot.telegram,
			`❌ Ошибка бота:\n${describeTelegramFailure(err)}`,
		);
	});

	return bot;
}
