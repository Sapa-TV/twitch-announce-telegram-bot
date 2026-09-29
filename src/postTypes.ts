/**
 * Конфиг постинга: окна времени по Москве, типы постов, вопросы и кнопки.
 * Правь только этот файл — код трогать не нужно.
 *
 * Тип поста определяет две вещи у поста в канале:
 *   — `signature` дописывается в конец текста;
 *   — `buttons` — сколько URL-кнопок вешается под постом (лейблы из
 *     `AppConfig.buttons` в src/config.ts, порядок сохраняется).
 *
 * Как работает выбор типа:
 *   — текущий час попал в одно из `windows` → спрашиваем 2 кнопками:
 *     подпись окна (`windows[].suggestedType`) + `questions.inWindowExtra`;
 *   — не попал → спрашиваем 3 кнопками `questions.outOfWindowOptions`.
 */

export type PostTypeId = "morning" | "evening" | "common" | "watch" | "post";

export type PostType = {
	/** Текст кнопки в вопросе «что это за пост». */
	label: string;
	/** Подпись, которая дописывается в конец текста поста. */
	signature: string;
	/** Лейблы кнопок из `AppConfig.buttons`, которые вешаем на пост. */
	buttons: string[];
};

export type TimeWindow = {
	/** Начало окна, час МСК, включительно. */
	from: number;
	/** Конец окна, час МСК, включительно (15 → до 15:59). */
	to: number;
	/** Тип поста, который предлагаем, если сейчас попали в это окно. */
	suggestedType: PostTypeId;
};

export type PostTypesConfig = {
	/** Таймзона, в которой считаем окна. */
	timezone: string;
	/** Сколько живёт неопубликованный черновик. */
	draftTtlMs: number;
	windows: TimeWindow[];
	types: Record<PostTypeId, PostType>;
	questions: {
		/** Вопрос в стримовое окно. Подстановки: {hour} {from} {to} {label}. */
		inWindow: string;
		/** Кнопки к {label} в окне — обычно «просто пост». */
		inWindowExtra: PostTypeId[];
		/** Вопрос вне стримового окна. Подстановка: {hour}. */
		outOfWindow: string;
		/** Все варианты, когда время не стримовое. */
		outOfWindowOptions: PostTypeId[];
	};
	replies: {
		/** В вопросе после успеха. Подстановка: {label}. */
		published: string;
		/** В вопросе после «Отмена». */
		cancelled: string;
		/** Черновик не нашёлся или протух — подменка: {minutes}. */
		expired: string;
		/** Подменки: {label} {error}. */
		failed: string;
	};
};

export const postTypes: PostTypesConfig = {
	timezone: "Europe/Moscow",
	draftTtlMs: 30 * 60 * 1000,
	windows: [
		{ from: 7, to: 15, suggestedType: "morning" },
		{ from: 18, to: 23, suggestedType: "evening" },
	],
	types: {
		morning: {
			label: "Утренний стрим",
			signature: "☀️ Утренний стрим, общий: заходи в любое время, чат открыт.",
			buttons: ["Twitch", "Vk Video live", "Чат в телеге"],
		},
		evening: {
			label: "Вечерний стрим",
			signature: "🌙 Вечерний стрим, просмотровый: смотрим вместе, пиши в чат!",
			buttons: ["Twitch", "Чат в телеге"],
		},
		common: {
			label: "Общий стрим",
			signature: "📺 Общий стрим: смотри сам, без компании, чат открыт.",
			buttons: ["Twitch", "Vk Video live", "Чат в телеге"],
		},
		watch: {
			label: "Просмотровый стрим",
			signature: "👀 Смотрим вместе: реакции и чат — только в эфире.",
			buttons: ["Twitch", "Чат в телеге"],
		},
		post: {
			label: "Просто пост",
			signature: "📢 Все анонсы и записи стримов — здесь, в канале.",
			buttons: ["Youtube", "Чат в телеге"],
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
