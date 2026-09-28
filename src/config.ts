import "dotenv/config";

export type Button = { label: string; url: string };

export type AppConfig = {
	telegram: {
		token: string;
		channelId: string;
		allowedUserIds: number[];
		webhookSecret?: string;
		replyToAuthor: boolean;
	};
	// Twitch опционален: без этих переменных бот постит в канал как обычно,
	// а уведомления о начале стрима просто выключены.
	twitch: {
		clientId?: string;
		clientSecret?: string;
		broadcasterUserId?: string;
		eventSubSecret?: string;
	};
	baseUrl: string;
	buttons: Button[];
	templates: {
		streamOnline: string;
	};
};

let cached: AppConfig | null = null;

/** Лениво собирает конфиг и кэширует. Кидает ошибку с именем переменной при первом вызове. */
export function getConfig(): AppConfig {
	if (!cached) {
		cached = buildConfig();
	}
	return cached;
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required env variable: ${name}`);
	}
	return value;
}

function parseUserIds(raw: string | undefined): number[] {
	if (!raw) throw new Error("Missing required env variable: ALLOWED_USER_IDS");
	return raw
		.split(",")
		.map((id) => Number(id.trim()))
		.filter((id) => Number.isFinite(id));
}

/** Переменная, которая может быть не задана: пустая строка и пробелы — это undefined. */
function optionalEnv(name: string): string | undefined {
	return process.env[name]?.trim() || undefined;
}

const buttons: Button[] = [
	{ label: "Twitch", url: "https://www.twitch.tv/Sapushka_" },
	{ label: "Vk Video live", url: "https://live.vkvideo.ru/sapushka_" },
	{ label: "Youtube", url: "https://www.youtube.com/@sapa_sapushka" },
	{ label: "Чат в телеге", url: "https://t.me/Sapushka_chat" },
];

function buildConfig(): AppConfig {
	const baseUrl = requiredEnv("PUBLIC_BASE_URL").replace(/\/+$/, "");

	return {
		telegram: {
			token: requiredEnv("TELEGRAM_BOT_TOKEN"),
			channelId: requiredEnv("TELEGRAM_CHANNEL_ID"),
			allowedUserIds: parseUserIds(process.env.ALLOWED_USER_IDS),
			webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
			replyToAuthor: process.env.REPLY_TO_AUTHOR !== "false",
		},
		twitch: {
			clientId: optionalEnv("TWITCH_CLIENT_ID"),
			clientSecret: optionalEnv("TWITCH_CLIENT_SECRET"),
			broadcasterUserId: optionalEnv("TWITCH_BROADCASTER_USER_ID"),
			eventSubSecret: optionalEnv("EVENTSUB_SECRET"),
		},
		baseUrl,
		buttons,
		templates: {
			// сообщение из бота (1:1 как было), без шаблонизации
			streamOnline: "🎬 {channel} запустила стрим, не пропусти!\n\n{title}",
		},
	};
}
