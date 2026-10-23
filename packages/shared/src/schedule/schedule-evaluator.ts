import type {
  ScheduleConfig,
  ScheduleEvaluationResult,
  TimeWindow,
} from './schedule-types.js';

export interface ZonedTime {
  year: number;
  month: number;
  day: number;
  dayOfWeek: number; // 0=Sunday, 1=Monday, ..., 6=Saturday
  hour: number;
  minute: number;
  second: number;
  totalMinutes: number;
  timeString: string;
  formatted: string;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timezone: string): Intl.DateTimeFormat {
  const existing = formatterCache.get(timezone);
  if (existing) {
    return existing;
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  }
  formatterCache.set(timezone, formatter);
  return formatter;
}

/**
 * Parses "HH:mm" time string into total minutes from start of day.
 */
export function parseTimeToMinutes(timeStr: string): number {
  const parts = timeStr.split(':');
  const h = Number.parseInt(parts[0] ?? '0', 10);
  const m = Number.parseInt(parts[1] ?? '0', 10);
  return h * 60 + m;
}

/**
 * Extracts zoned time details for a given Date and IANA timezone.
 */
export function getZonedTime(date: Date, timezone: string): ZonedTime {
  const formatter = getFormatter(timezone);
  const parts = formatter.formatToParts(date);
  const partMap: Record<string, string> = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }

  const year = Number.parseInt(partMap.year ?? '1970', 10);
  const month = Number.parseInt(partMap.month ?? '1', 10);
  const day = Number.parseInt(partMap.day ?? '1', 10);
  const weekdayStr = partMap.weekday ?? 'Sun';
  const dayOfWeek = WEEKDAY_MAP[weekdayStr] ?? 0;
  const hour = Number.parseInt(partMap.hour ?? '0', 10);
  const minute = Number.parseInt(partMap.minute ?? '0', 10);
  const second = Number.parseInt(partMap.second ?? '0', 10);

  const pad = (n: number) => String(n).padStart(2, '0');
  const timeString = `${pad(hour)}:${pad(minute)}`;
  const formatted = `${year}-${pad(month)}-${pad(day)} ${timeString}:${pad(second)}`;

  return {
    year,
    month,
    day,
    dayOfWeek,
    hour,
    minute,
    second,
    totalMinutes: hour * 60 + minute,
    timeString,
    formatted,
  };
}

/**
 * Checks if the zoned time falls inside a specific time window.
 */
export function isInsideWindow(zoned: ZonedTime, window: TimeWindow): boolean {
  const windowDays = window.days && window.days.length > 0 ? window.days : [0, 1, 2, 3, 4, 5, 6];
  const startMinutes = parseTimeToMinutes(window.start);
  const endMinutes = parseTimeToMinutes(window.end);
  const currentMinutes = zoned.totalMinutes;

  if (startMinutes <= endMinutes) {
    // Same-day window (e.g. 09:00 - 17:00)
    if (!windowDays.includes(zoned.dayOfWeek)) {
      return false;
    }
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  // Overnight window crossing midnight (e.g. 22:00 - 06:00)
  if (currentMinutes >= startMinutes) {
    // First half of overnight window (started today)
    return windowDays.includes(zoned.dayOfWeek);
  }

  if (currentMinutes < endMinutes) {
    // Second half of overnight window (started yesterday)
    const yesterdayDayOfWeek = (zoned.dayOfWeek + 6) % 7;
    return windowDays.includes(yesterdayDayOfWeek);
  }

  return false;
}

/**
 * Checks if current time is past the stop_at_hour deadline.
 * (e.g., stop_at_hour: 7 means halt execution when clock reaches 07:00 until night).
 */
export function isPastDeadline(zoned: ZonedTime, stopAtHour: number | null): boolean {
  if (stopAtHour === null || stopAtHour === undefined) {
    return false;
  }
  // In typical overnight runs, stop_at_hour (e.g. 7) stops during daytime (07:00 to 20:00)
  if (stopAtHour <= 12) {
    return zoned.hour >= stopAtHour && zoned.hour < 20;
  }
  return zoned.hour >= stopAtHour;
}

/**
 * Finds the matching window for the current zoned time, if any.
 */
export function findMatchingWindow(
  zoned: ZonedTime,
  windows: TimeWindow[],
): TimeWindow | undefined {
  for (const win of windows) {
    if (isInsideWindow(zoned, win)) {
      return win;
    }
  }
  return undefined;
}

/**
 * Calculates transition timestamps (windowEnd, nextWindowStart) directly via arithmetic boundary checks.
 */
export function calculateNextTransition(
  date: Date,
  config: ScheduleConfig,
): {
  nextWindowStart?: string;
  msUntilNextWindow?: number;
  windowEnd?: string;
  msUntilWindowEnd?: number;
} {
  if (config.mode === 'ALWAYS' || !config.enabled || config.windows.length === 0) {
    return {};
  }

  const timezone = config.timezone || 'UTC';
  const currentZoned = getZonedTime(date, timezone);
  const currentMatching = findMatchingWindow(currentZoned, config.windows);
  const isCurrentlyInside = Boolean(currentMatching);

  let nextWindowStart: string | undefined;
  let msUntilNextWindow: number | undefined;
  let windowEnd: string | undefined;
  let msUntilWindowEnd: number | undefined;

  if (isCurrentlyInside && currentMatching) {
    // Calculate when the current active window ends
    const startMinutes = parseTimeToMinutes(currentMatching.start);
    const endMinutes = parseTimeToMinutes(currentMatching.end);
    let diffMinutes: number;

    if (startMinutes <= endMinutes) {
      // Same-day window ends today at endMinutes
      diffMinutes = endMinutes - currentZoned.totalMinutes;
    } else {
      // Overnight window
      if (currentZoned.totalMinutes >= startMinutes) {
        // Started today, ends tomorrow at endMinutes
        diffMinutes = 24 * 60 - currentZoned.totalMinutes + endMinutes;
      } else {
        // Started yesterday, ends today at endMinutes
        diffMinutes = endMinutes - currentZoned.totalMinutes;
      }
    }

    const durationMs = diffMinutes * 60 * 1000 - currentZoned.second * 1000;
    if (durationMs > 0) {
      msUntilWindowEnd = durationMs;
      windowEnd = new Date(date.getTime() + durationMs).toISOString();
    }
  } else {
    // Find the next upcoming window start across all configured windows over the next 7 days
    let minNextMs = Number.POSITIVE_INFINITY;

    for (const win of config.windows) {
      const winDays = win.days && win.days.length > 0 ? win.days : [0, 1, 2, 3, 4, 5, 6];
      const winStartMinutes = parseTimeToMinutes(win.start);

      for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
        const candidateDayOfWeek = (currentZoned.dayOfWeek + dayOffset) % 7;
        if (winDays.includes(candidateDayOfWeek)) {
          const diffMinutes = dayOffset * 24 * 60 + winStartMinutes - currentZoned.totalMinutes;
          const candidateMs = diffMinutes * 60 * 1000 - currentZoned.second * 1000;
          if (candidateMs > 0 && candidateMs < minNextMs) {
            minNextMs = candidateMs;
            break;
          }
        }
      }
    }

    if (minNextMs !== Number.POSITIVE_INFINITY) {
      msUntilNextWindow = minNextMs;
      nextWindowStart = new Date(date.getTime() + minNextMs).toISOString();
    }
  }

  return {
    nextWindowStart,
    msUntilNextWindow,
    windowEnd,
    msUntilWindowEnd,
  };
}

/**
 * Evaluates whether task execution is permitted under the provided schedule configuration.
 */
export function evaluateSchedule(
  config: ScheduleConfig,
  currentDate: Date = new Date(),
): ScheduleEvaluationResult {
  const timezone = config.timezone || 'UTC';
  const zoned = getZonedTime(currentDate, timezone);
  const currentTimestamp = currentDate.toISOString();
  const currentLocalTime = zoned.formatted;

  // 1. If schedule is disabled: execution permitted unconditionally
  if (!config.enabled) {
    return {
      allowed: true,
      reason: 'SCHEDULE_DISABLED',
      message: 'Schedule enforcement is disabled; execution permitted',
      activeMode: config.mode,
      currentTimestamp,
      currentLocalTime,
      timezone,
    };
  }

  // 2. If mode is ALWAYS: execution permitted unconditionally
  if (config.mode === 'ALWAYS') {
    return {
      allowed: true,
      reason: 'MODE_ALWAYS',
      message: 'Schedule mode is ALWAYS; execution permitted 24/7',
      activeMode: config.mode,
      currentTimestamp,
      currentLocalTime,
      timezone,
    };
  }

  // 3. Deadline check (stop_at_hour)
  if (isPastDeadline(zoned, config.stop_at_hour)) {
    const transitions = calculateNextTransition(currentDate, config);
    return {
      allowed: false,
      reason: 'DEADLINE_REACHED',
      message: `Past deadline hour (${config.stop_at_hour}:00); execution stopped until next window`,
      activeMode: config.mode,
      currentTimestamp,
      currentLocalTime,
      timezone,
      ...transitions,
    };
  }

  // 4. Windows check
  const matchedWindow = findMatchingWindow(zoned, config.windows);
  const transitions = calculateNextTransition(currentDate, config);

  if (config.mode === 'ALLOW') {
    if (config.windows.length === 0) {
      return {
        allowed: false,
        reason: 'NO_WINDOWS_CONFIGURED',
        message: 'Schedule mode is ALLOW but no execution windows are configured',
        activeMode: config.mode,
        currentTimestamp,
        currentLocalTime,
        timezone,
      };
    }

    if (matchedWindow) {
      return {
        allowed: true,
        reason: 'INSIDE_ALLOWED_WINDOW',
        message: `Current time is inside allowed window '${matchedWindow.name || `${matchedWindow.start}-${matchedWindow.end}`}'`,
        activeMode: config.mode,
        currentTimestamp,
        currentLocalTime,
        timezone,
        currentWindow: matchedWindow,
        ...transitions,
      };
    }

    return {
      allowed: false,
      reason: 'OUTSIDE_ALLOWED_WINDOW',
      message: 'Current time is outside all configured allowed execution windows',
      activeMode: config.mode,
      currentTimestamp,
      currentLocalTime,
      timezone,
      ...transitions,
    };
  }

  // Mode: BLOCK
  if (matchedWindow) {
    return {
      allowed: false,
      reason: 'INSIDE_BLOCKED_WINDOW',
      message: `Current time is inside blocked window '${matchedWindow.name || `${matchedWindow.start}-${matchedWindow.end}`}'`,
      activeMode: config.mode,
      currentTimestamp,
      currentLocalTime,
      timezone,
      currentWindow: matchedWindow,
      ...transitions,
    };
  }

  return {
    allowed: true,
    reason: 'OUTSIDE_BLOCKED_WINDOW',
    message: 'Current time is outside blocked windows; execution permitted',
    activeMode: config.mode,
    currentTimestamp,
    currentLocalTime,
    timezone,
    ...transitions,
  };
}
