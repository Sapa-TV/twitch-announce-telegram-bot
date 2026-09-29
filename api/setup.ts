import type { AppConfig } from "../src/config.js";
import { errorMessage } from "../src/errors.js";
import { jsonError } from "../src/http.js";

export const config = { runtime: "nodejs", maxDuration: 30 };

const TELEGRAM_API = "https://api.telegram.org";

async function load(): Promise<{
	appConfig: AppConfig;
	twitch: typeof import("../src/twitch.js");
	drafts: typeof import("../src/drafts.js");
}> {
	const [{ getConfig }, twitch, drafts] = await Promise.all([
		import("../src/config.js"),
		import("../src/twitch.js"),
		import("../src/drafts.js"),
	]);
	return { appConfig: getConfig(), twitch, drafts };
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	const res = await fetch(url, init);
	return (await res.json()) as unknown;
}

async function setTelegramWebhook(appConfig: AppConfig) {
	const body: Record<string, unknown> = {
		url: `${appConfig.baseUrl}/api/telegram`,
	};
	if (appConfig.telegram.webhookSecret) {
		body.secret_token = appConfig.telegram.webhookSecret;
	}
	return fetchJson(
		`${TELEGRAM_API}/bot${appConfig.telegram.token}/setWebhook`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	);
}

export async function GET(): Promise<Response> {
	let appConfig: AppConfig;
	let twitch: Awaited<ReturnType<typeof load>>["twitch"];
	let drafts: Awaited<ReturnType<typeof load>>["drafts"];
	try {
		({ appConfig, twitch, drafts } = await load());
	} catch (err) {
		return jsonError(err);
	}

	const status = {
		env: {
			telegramTokenSet: Boolean(appConfig.telegram.token),
			channelId: appConfig.telegram.channelId,
			baseUrl: appConfig.baseUrl,
			twitchConfigured: twitch.twitchConfigured(),
			twitchMissingEnv: twitch.missingTwitchEnv(),
			broadcasterUserId: appConfig.twitch.broadcasterUserId ?? null,
		},
		redis: await drafts.pingRedis(),
		telegramWebhook: null as unknown,
		subscription: null as unknown,
	};

	try {
		status.telegramWebhook = await fetchJson(
			`${TELEGRAM_API}/bot${appConfig.telegram.token}/getWebhookInfo`,
		);
	} catch (err) {
		status.telegramWebhook = { error: errorMessage(err) };
	}

	// Подписка спрашивается только при полном наборе Twitch-кредов: иначе
	// запрос к Twitch всё равно упал бы, а setup должен оставаться диагностикой.
	if (twitch.twitchConfigured()) {
		try {
			const sub = await twitch.getEventSubStatus();
			status.subscription = sub
				? { id: sub.id, type: sub.type, status: sub.status }
				: null;
		} catch (err) {
			status.subscription = { error: errorMessage(err) };
		}
	} else {
		status.subscription = { skipped: "Twitch не настроен" };
	}

	return Response.json(status);
}

export async function POST(): Promise<Response> {
	let appConfig: AppConfig;
	let twitch: Awaited<ReturnType<typeof load>>["twitch"];
	try {
		({ appConfig, twitch } = await load());
	} catch (err) {
		return jsonError(err);
	}

	// Webhook Telegram настраивается всегда, подписка Twitch — только если
	// есть креды. Иначе один POST /api/setup падал бы из-за неиспользуемой части.
	const [webhookResult, subscriptionResult] = await Promise.all([
		setTelegramWebhook(appConfig).catch((err) => ({
			error: errorMessage(err),
		})),
		twitch.twitchConfigured()
			? twitch
					.subscribeIfNeeded()
					.catch((err) => ({ error: errorMessage(err) }))
			: Promise.resolve({ skipped: "Twitch не настроен" }),
	]);
	return Response.json({
		webhook: webhookResult,
		subscription: subscriptionResult,
	});
}
