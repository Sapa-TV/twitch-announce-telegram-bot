import type { TimeWindow } from "./postTypes.js";

const formatters = new Map<string, Intl.DateTimeFormat>();

function hourFormatter(timeZone: string): Intl.DateTimeFormat {
	let formatter = formatters.get(timeZone);
	if (!formatter) {
		// hourCycle: "h23" вместо hour12: false — иначе полночь приходит как "24".
		formatter = new Intl.DateTimeFormat("en-GB", {
			timeZone,
			hour: "numeric",
			hour12: false,
			hourCycle: "h23",
		});
		formatters.set(timeZone, formatter);
	}
	return formatter;
}

/** Час суток (0..23) в таймзоне на момент `date`. */
export function hourInTimeZone(date: Date, timeZone: string): number {
	return Number(hourFormatter(timeZone).format(date));
}

/**
 * Окно, в которое попадает час. Границы включительные: 7..15 — это 7:00–15:59,
 * 18..23 — 18:00–23:59. Первое подходящее окно выигрывает.
 */
export function findWindow(
	hour: number,
	windows: TimeWindow[],
): TimeWindow | undefined {
	return windows.find((w) => hour >= w.from && hour <= w.to);
}
