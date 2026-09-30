import "dotenv/config";

export type Button = { label: string; url: string };

/**
 * Типов ровно три: общий стрим, просмотровый стрим, пост. Утро и вечер — не
 * типы, а окна времени: попал в окно → предлагаем его тип кнопкой по умолчанию,
 * не попал → спрашиваем все три.
 */

export type PostTypeId = "common" | "watch" | "post";

export type PostType = {
	label: string;
	/** Дописывается в конец текста поста. */
	signature: string;
	buttons: Button[];
};

/** Границы включительные: 7..15 — это 7:00–15:59. */
export type TimeWindow = {
	from: number;
	to: number;
	suggest: PostTypeId;
};

export type PostTypesConfig = {
	/** Таймзона, в которой считаем окна. */
	timezone: string;
	/** Сколько живёт неопубликованный черновик. */
	draftTtlMs: number;
	windows: TimeWindow[];
	types: Record<PostTypeId, PostType>;
	questions: {
		/** Подстановки: {hour} {from} {to} {label}. */
		inWindow: string;
		/** Кнопки к {label} в окне — обычно «просто пост». */
		inWindowExtra: PostTypeId[];
		/** Подстановка: {hour}. */
		outOfWindow: string;
		outOfWindowOptions: PostTypeId[];
	};
	replies: {
		/** Подстановка: {label}. */
		published: string;
		cancelled: string;
		/** Подстановка: {minutes}. */
		expired: string;
		/** Подстановки: {label} {error}. */
		failed: string;
	};
};

// Порядок — кнопки в постах без типа (stream.online).
const twitch: Button = {
	label: "Twitch",
	url: "https://www.twitch.tv/Sapushka_",
};
const vkVideo: Button = {
	label: "Vk Video live",
	url: "https://live.vkvideo.ru/sapushka_",
};
const youtube: Button = {
	label: "Youtube",
	url: "https://www.youtube.com/@sapa_sapushka",
};
const telegramChat: Button = {
	label: "Чат в телеге",
	url: "https://t.me/Sapushka_chat",
};
const websiteStream: Button = {
	label: "Стрим на сайте",
	url: "https://sapa-tv.ru/stream",
};
const website: Button = {
	label: "Мой сайт",
	url: "https://sapa-tv.ru",
};

const buttons: Button[] = [twitch, vkVideo, youtube, telegramChat];

const postTypes: PostTypesConfig = {
	timezone: "Europe/Moscow",
	draftTtlMs: 30 * 60 * 1000,
	windows: [
		{ from: 7, to: 15, suggest: "common" },
		{ from: 18, to: 23, suggest: "watch" },
	],
	types: {
		common: {
			label: "Общий стрим",
			signature: "📺 Общий стрим: смотри сам, без компании, чат открыт.",
			buttons: [twitch, vkVideo, youtube, telegramChat],
		},
		watch: {
			label: "Просмотровый стрим",
			signature: "👀 Смотрим вместе: реакции и чат — только в эфире.",
			buttons: [twitch, websiteStream, telegramChat],
		},
		post: {
			label: "Просто пост",
			signature: "📢 Все анонсы и записи стримов — здесь, в канале.",
			buttons: [telegramChat],
		},
	},
	questions: {
		inWindow:
			"Сейчас {hour}:00 МСК — стримовое окно ({from}:00–{to}:59).\nЧто публикуем?",
		inWindowExtra: ["post"],
		outOfWindow:
			"Сейчас {hour}:00 МСК — не стримовое время.\nЭто анонс стрима или пост в канал?",
		outOfWindowOptions: ["post", "common", "watch"],
	},
	replies: {
		published: "✅ Опубликовано в канал: {label}",
		cancelled: "🚫 Отменено, в канал ничего не ушло.",
		expired:
			"⌛ Черновик не нашёл ({minutes} мин прошло). Пришли сообщение ещё раз.",
		failed: "❌ Не опубликовано ({label}):\n{error}",
	},
};

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
	// Redis (Upstash) опционален: нужен, чтобы черновик неопубликованного поста
	// переживал перезапуск serverless-функции. Без него черновик живёт в памяти.
	redis: {
		url?: string;
		token?: string;
	};
	baseUrl: string;
	// Порядок — кнопки в постах без типа.
	buttons: Button[];
	posts: PostTypesConfig;
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
		// Имена переменных у интеграции Redis на Vercel неизвестны наверняка:
		// часть ставит UPSTASH_REDIS_REST_*, часть — KV_REST_API_* (так их
		// называл @vercel/kv, который тоже был поверх Upstash). Берём обе.
		redis: {
			url:
				optionalEnv("UPSTASH_REDIS_REST_URL") ?? optionalEnv("KV_REST_API_URL"),
			token:
				optionalEnv("UPSTASH_REDIS_REST_TOKEN") ??
				optionalEnv("KV_REST_API_TOKEN"),
		},
		baseUrl,
		buttons,
		posts: postTypes,
		templates: {
			// сообщение из бота (1:1 как было), без шаблонизации
			streamOnline: "🎬 {channel} запустила стрим, не пропусти!\n\n{title}",
		},
	};
}
