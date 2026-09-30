import { Redis } from "@upstash/redis";
import { getConfig } from "./config.js";
import { errorMessage } from "./errors.js";

/** Что за медиа прислали — от этого зависит, можно ли дописать подпись в пост. */
export type MediaKind =
	/** Только текст. */
	| "none"
	/** Медиа, у Telegram есть поле caption (фото, видео, документ…). */
	| "captionable"
	/** Медиа без caption (стикер, голосовое) — подпись в пост не влезет. */
	| "plain";

export type Draft = {
	userId: number;
	/** Отсюда копируем медиа в канал. */
	chatId: number;
	/** id сообщения в этом чате. */
	messageId: number;
	/** Текст сообщения или подпись к медиа. */
	body: string;
	media: MediaKind;
	/** Сообщение бота с вопросом — его редактируем после выбора. */
	questionChatId: number;
	questionMessageId: number;
	createdAt: number;
};

const KEY_PREFIX = "tgbot:draft:";

function draftKey(userId: number): string {
	return `${KEY_PREFIX}${userId}`;
}

function ttlSeconds(): number {
	return Math.max(1, Math.ceil(getConfig().posts.draftTtlMs / 1000));
}

// undefined — ещё не создавали, null — Redis не настроен.
let client: Redis | null | undefined;

function getClient(): Redis | null {
	if (client === undefined) {
		const { url, token } = getConfig().redis;
		client = url && token ? new Redis({ url, token }) : null;
		if (client) {
			const names = process.env.UPSTASH_REDIS_REST_URL
				? "UPSTASH_REDIS_REST_*"
				: "KV_REST_API_*";
			console.log("redis configured, drafts persist across deploys:", names);
		} else {
			console.warn(
				"redis not configured, drafts live in memory only (lost on redeploy)",
			);
		}
	}
	return client;
}

// План Б, если Redis не ответил: держим черновик в памяти процесса. К памяти
// обращаемся только после неудачи в Redis, чтобы не вычитывать удалённое вслед
// за публикацией на другом инстансе.
const memory = new Map<number, Draft>();

function isAlive(draft: Draft): boolean {
	return Date.now() - draft.createdAt < getConfig().posts.draftTtlMs;
}

function readMemory(userId: number): Draft | undefined {
	const draft = memory.get(userId);
	if (!draft) return undefined;
	if (!isAlive(draft)) {
		memory.delete(userId);
		return undefined;
	}
	return draft;
}

export async function saveDraft(draft: Draft): Promise<void> {
	const redis = getClient();
	if (redis) {
		try {
			await redis.set(draftKey(draft.userId), JSON.stringify(draft), {
				ex: ttlSeconds(),
			});
			return;
		} catch (err) {
			console.error("draft save to redis failed:", err);
		}
	}
	memory.set(draft.userId, draft);
}

export async function peekDraft(userId: number): Promise<Draft | undefined> {
	const redis = getClient();
	if (redis) {
		try {
			const draft = await redis.get<Draft>(draftKey(userId));
			if (draft) return draft;
		} catch (err) {
			console.error("draft read from redis failed:", err);
		}
	}
	return readMemory(userId);
}

export async function dropDraft(userId: number): Promise<void> {
	memory.delete(userId);
	const redis = getClient();
	if (!redis) return;
	try {
		await redis.del(draftKey(userId));
	} catch (err) {
		// Удаление не критично: запись и так протухнет по TTL.
		console.error("draft delete in redis failed:", err);
	}
}

/** Для /api/setup — не бросает, всегда отвечает. */
export async function pingRedis(): Promise<{
	configured: boolean;
	result: string;
}> {
	const redis = getClient();
	if (!redis) {
		return { configured: false, result: "not configured" };
	}
	try {
		return { configured: true, result: await redis.ping() };
	} catch (err) {
		return { configured: true, result: `error: ${errorMessage(err)}` };
	}
}
