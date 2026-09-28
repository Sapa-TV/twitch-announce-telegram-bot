import { createHmac, timingSafeEqual } from "node:crypto";
import { ApiClient } from "@twurple/api";
import { AppTokenAuthProvider } from "@twurple/auth";
import { getConfig } from "./config.js";

/** Имена переменных, без которых подписка stream.online работать не будет. */
const TWITCH_ENV_NAMES = [
	"TWITCH_CLIENT_ID",
	"TWITCH_CLIENT_SECRET",
	"TWITCH_BROADCASTER_USER_ID",
	"EVENTSUB_SECRET",
] as const;

let client: ApiClient | null = null;

/** Какие из Twitch-переменных не заданы (пусто — настроен полностью). */
export function missingTwitchEnv(): string[] {
	const twitch = getConfig().twitch;
	const values: Record<(typeof TWITCH_ENV_NAMES)[number], string | undefined> =
		{
			TWITCH_CLIENT_ID: twitch.clientId,
			TWITCH_CLIENT_SECRET: twitch.clientSecret,
			TWITCH_BROADCASTER_USER_ID: twitch.broadcasterUserId,
			EVENTSUB_SECRET: twitch.eventSubSecret,
		};
	return TWITCH_ENV_NAMES.filter((name) => !values[name]);
}

export function twitchConfigured(): boolean {
	return missingTwitchEnv().length === 0;
}

/**
 * Конфиг Twitch, из которого можно строить клиент и подписку. Если часть
 * переменных не задана, бросаем понятную ошибку вместо обращения к Twitch с
 * пустыми креды.
 */
function requireTwitchConfig(): {
	clientId: string;
	clientSecret: string;
	broadcasterUserId: string;
	eventSubSecret: string;
} {
	const twitch = getConfig().twitch;
	const missing = missingTwitchEnv();
	if (missing.length > 0) {
		throw new Error(
			`Twitch не настроен: не заданы переменные ${missing.join(", ")}. Уведомления о начале стрима выключены, постинг в Telegram работает.`,
		);
	}
	return {
		clientId: twitch.clientId as string,
		clientSecret: twitch.clientSecret as string,
		broadcasterUserId: twitch.broadcasterUserId as string,
		eventSubSecret: twitch.eventSubSecret as string,
	};
}

export function getApiClient(): ApiClient {
	if (!client) {
		const { clientId, clientSecret } = requireTwitchConfig();
		const provider = new AppTokenAuthProvider(clientId, clientSecret);
		client = new ApiClient({ authProvider: provider });
	}
	return client;
}

/** Проверка подписи EventSub: HMAC-SHA256(secret, messageId + timestamp + rawBody). */
export function verifyEventSubSignature(
	messageId: string,
	timestamp: string,
	signature: string,
	rawBody: string,
): boolean {
	const secret = getConfig().twitch.eventSubSecret;
	// Секрета нет — подпись проверить нечем, запрос не от Twitch. Fail closed.
	if (!secret) return false;
	const digest = createHmac("sha256", secret)
		.update(messageId + timestamp + rawBody)
		.digest("hex");
	const expected = Buffer.from(`sha256=${digest}`);
	const received = Buffer.from(String(signature));
	if (expected.length !== received.length) return false;
	return timingSafeEqual(expected, received);
}

function broadcasterUserIdOf(sub: { condition: unknown }): string | undefined {
	return (sub.condition as { broadcaster_user_id?: string })
		.broadcaster_user_id;
}

async function getMine() {
	const { broadcasterUserId } = requireTwitchConfig();
	const subs =
		await getApiClient().eventSub.getSubscriptionsForType("stream.online");
	return subs.data.filter((s) => broadcasterUserIdOf(s) === broadcasterUserId);
}

/** Первая подписка stream.online на наш канал (любой статус) или null. */
export async function getEventSubStatus() {
	const mine = await getMine();
	return mine[0] ?? null;
}

/** Идемпотентное создание подписки: enabled — не трогаем, «битую» пересоздаём. */
export async function subscribeIfNeeded(): Promise<{
	changed: boolean;
	id?: string;
}> {
	const mine = await getMine();

	const active = mine.find((s) => s.status === "enabled");
	if (active) return { changed: false, id: active.id };

	const broken = mine.find((s) =>
		[
			"notification_failures_exceeded",
			"webhook_callback_verification_failed",
		].includes(s.status),
	);
	if (broken) await getApiClient().eventSub.deleteSubscription(broken.id);

	const config = getConfig();
	const { broadcasterUserId, eventSubSecret } = requireTwitchConfig();
	const created = await getApiClient().eventSub.createSubscription(
		"stream.online",
		"1",
		{ broadcaster_user_id: broadcasterUserId },
		{
			method: "webhook",
			callback: `${config.baseUrl}/api/twitch`,
			secret: eventSubSecret,
		},
		broadcasterUserId,
	);
	return { changed: true, id: created.id };
}

/** Удалить все подписки stream.online нашего канала. Возвращает сколько удалено. */
export async function deleteEventSub(): Promise<number> {
	const mine = await getMine();
	for (const s of mine) {
		await getApiClient().eventSub.deleteSubscription(s.id);
	}
	return mine.length;
}
