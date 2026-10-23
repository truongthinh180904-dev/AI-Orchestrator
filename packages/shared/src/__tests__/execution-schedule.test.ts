import { describe, it, expect } from 'vitest';
import {
  TimeWindowSchema,
  ScheduleConfigSchema,
  getZonedTime,
  isInsideWindow,
  isPastDeadline,
  evaluateSchedule,
  parseTimeToMinutes,
  type ScheduleConfig,
} from '../schedule/index.js';

describe('Execution Schedule (OPS-002)', () => {
  describe('Zod Schemas', () => {
    it('validates correct TimeWindowSchema', () => {
      const win = TimeWindowSchema.parse({
        name: 'Overnight',
        start: '22:00',
        end: '06:00',
        days: [1, 2, 3, 4, 5],
      });
      expect(win.name).toBe('Overnight');
      expect(win.start).toBe('22:00');
      expect(win.end).toBe('06:00');
      expect(win.days).toEqual([1, 2, 3, 4, 5]);
    });

    it('rejects invalid time formats in TimeWindowSchema', () => {
      expect(() => TimeWindowSchema.parse({ start: '25:00', end: '06:00' })).toThrow();
      expect(() => TimeWindowSchema.parse({ start: '12:60', end: '06:00' })).toThrow();
      expect(() => TimeWindowSchema.parse({ start: 'invalid', end: '06:00' })).toThrow();
      expect(() =>
        TimeWindowSchema.parse({ start: '09:00', end: '17:00', days: [7] }),
      ).toThrow();
    });

    it('validates and applies defaults in ScheduleConfigSchema', () => {
      const config = ScheduleConfigSchema.parse({});
      expect(config.enabled).toBe(true);
      expect(config.timezone).toBe('UTC');
      expect(config.mode).toBe('ALLOW');
      expect(config.windows).toEqual([]);
      expect(config.stop_at_hour).toBeNull();
      expect(config.graceful_completion).toBe(true);
    });
  });

  describe('parseTimeToMinutes', () => {
    it('converts HH:mm to minutes from start of day', () => {
      expect(parseTimeToMinutes('00:00')).toBe(0);
      expect(parseTimeToMinutes('01:30')).toBe(90);
      expect(parseTimeToMinutes('12:00')).toBe(720);
      expect(parseTimeToMinutes('23:59')).toBe(1439);
    });
  });

  describe('getZonedTime', () => {
    it('extracts date parts accurately in UTC', () => {
      const date = new Date('2026-10-23T14:30:45.000Z');
      const zoned = getZonedTime(date, 'UTC');
      expect(zoned.year).toBe(2026);
      expect(zoned.month).toBe(10);
      expect(zoned.day).toBe(23);
      expect(zoned.hour).toBe(14);
      expect(zoned.minute).toBe(30);
      expect(zoned.second).toBe(45);
      expect(zoned.timeString).toBe('14:30');
      expect(zoned.totalMinutes).toBe(14 * 60 + 30);
    });

    it('extracts date parts accurately in Asia/Ho_Chi_Minh (+07:00)', () => {
      const date = new Date('2026-10-23T14:30:45.000Z'); // 14:30 UTC = 21:30 VN
      const zoned = getZonedTime(date, 'Asia/Ho_Chi_Minh');
      expect(zoned.hour).toBe(21);
      expect(zoned.minute).toBe(30);
      expect(zoned.timeString).toBe('21:30');
    });

    it('falls back safely to UTC if invalid timezone is supplied', () => {
      const date = new Date('2026-10-23T10:00:00.000Z');
      const zoned = getZonedTime(date, 'INVALID_TIMEZONE');
      expect(zoned.hour).toBe(10);
    });
  });

  describe('isInsideWindow', () => {
    it('handles same-day window (e.g. 09:00 - 17:00)', () => {
      const window = {
        name: 'WorkHours',
        start: '09:00',
        end: '17:00',
        days: [1, 2, 3, 4, 5], // Mon-Fri
      };

      // Monday 10:00 -> inside
      const monday10 = getZonedTime(new Date('2026-10-26T10:00:00.000Z'), 'UTC'); // 2026-10-26 is Monday
      expect(monday10.dayOfWeek).toBe(1);
      expect(isInsideWindow(monday10, window)).toBe(true);

      // Monday 08:59 -> outside
      const monday859 = getZonedTime(new Date('2026-10-26T08:59:00.000Z'), 'UTC');
      expect(isInsideWindow(monday859, window)).toBe(false);

      // Monday 17:00 -> outside (end is exclusive)
      const monday1700 = getZonedTime(new Date('2026-10-26T17:00:00.000Z'), 'UTC');
      expect(isInsideWindow(monday1700, window)).toBe(false);

      // Sunday 10:00 -> outside (day not allowed)
      const sunday10 = getZonedTime(new Date('2026-10-25T10:00:00.000Z'), 'UTC'); // 2026-10-25 is Sunday
      expect(sunday10.dayOfWeek).toBe(0);
      expect(isInsideWindow(sunday10, window)).toBe(false);
    });

    it('handles overnight window crossing midnight (e.g. 22:00 - 06:00)', () => {
      const overnightWindow = {
        name: 'NightRun',
        start: '22:00',
        end: '06:00',
        days: [1, 2, 3, 4, 5], // Monday through Friday nights
      };

      // Monday 22:30 -> inside (started Monday)
      const mon2230 = getZonedTime(new Date('2026-10-26T22:30:00.000Z'), 'UTC');
      expect(isInsideWindow(mon2230, overnightWindow)).toBe(true);

      // Tuesday 03:00 -> inside (started Monday night)
      const tue0300 = getZonedTime(new Date('2026-10-27T03:00:00.000Z'), 'UTC');
      expect(tue0300.dayOfWeek).toBe(2);
      expect(isInsideWindow(tue0300, overnightWindow)).toBe(true);

      // Tuesday 06:00 -> outside (end is exclusive)
      const tue0600 = getZonedTime(new Date('2026-10-27T06:00:00.000Z'), 'UTC');
      expect(isInsideWindow(tue0600, overnightWindow)).toBe(false);

      // Tuesday 14:00 -> outside
      const tue1400 = getZonedTime(new Date('2026-10-27T14:00:00.000Z'), 'UTC');
      expect(isInsideWindow(tue1400, overnightWindow)).toBe(false);

      // Sunday 03:00 (started Saturday night which was day 6, not in days [1..5]) -> outside
      const sun0300 = getZonedTime(new Date('2026-10-25T03:00:00.000Z'), 'UTC');
      expect(isInsideWindow(sun0300, overnightWindow)).toBe(false);
    });
  });

  describe('isPastDeadline', () => {
    it('detects when clock passes stop_at_hour', () => {
      const zoned6 = getZonedTime(new Date('2026-10-23T06:45:00.000Z'), 'UTC');
      const zoned7 = getZonedTime(new Date('2026-10-23T07:15:00.000Z'), 'UTC');
      const zoned18 = getZonedTime(new Date('2026-10-23T18:00:00.000Z'), 'UTC');
      const zoned21 = getZonedTime(new Date('2026-10-23T21:00:00.000Z'), 'UTC');

      expect(isPastDeadline(zoned6, 7)).toBe(false);
      expect(isPastDeadline(zoned7, 7)).toBe(true);
      expect(isPastDeadline(zoned18, 7)).toBe(true);
      expect(isPastDeadline(zoned21, 7)).toBe(false); // Resets at night for overnight runs
      expect(isPastDeadline(zoned7, null)).toBe(false);
    });
  });

  describe('evaluateSchedule', () => {
    it('allows execution when schedule is disabled', () => {
      const config: ScheduleConfig = {
        id: 'test',
        name: 'Test',
        enabled: false,
        timezone: 'UTC',
        mode: 'ALLOW',
        windows: [{ start: '22:00', end: '06:00', days: [1, 2] }],
        stop_at_hour: null,
        graceful_completion: true,
        max_runs_per_window: null,
      };

      const result = evaluateSchedule(config, new Date('2026-10-23T12:00:00.000Z'));
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('SCHEDULE_DISABLED');
    });

    it('allows execution when mode is ALWAYS', () => {
      const config: ScheduleConfig = {
        id: 'test',
        name: 'Test',
        enabled: true,
        timezone: 'UTC',
        mode: 'ALWAYS',
        windows: [],
        stop_at_hour: null,
        graceful_completion: true,
        max_runs_per_window: null,
      };

      const result = evaluateSchedule(config, new Date('2026-10-23T12:00:00.000Z'));
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('MODE_ALWAYS');
    });

    it('disallows execution in ALLOW mode when no windows are configured', () => {
      const config: ScheduleConfig = {
        id: 'test',
        name: 'Test',
        enabled: true,
        timezone: 'UTC',
        mode: 'ALLOW',
        windows: [],
        stop_at_hour: null,
        graceful_completion: true,
        max_runs_per_window: null,
      };

      const result = evaluateSchedule(config, new Date('2026-10-23T12:00:00.000Z'));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('NO_WINDOWS_CONFIGURED');
    });

    it('allows execution inside allowed window and reports window details', () => {
      const config: ScheduleConfig = {
        id: 'test',
        name: 'Overnight Schedule',
        enabled: true,
        timezone: 'UTC',
        mode: 'ALLOW',
        windows: [
          {
            name: 'Overnight Window',
            start: '22:00',
            end: '06:00',
            days: [0, 1, 2, 3, 4, 5, 6],
          },
        ],
        stop_at_hour: null,
        graceful_completion: true,
        max_runs_per_window: null,
      };

      const insideDate = new Date('2026-10-23T23:30:00.000Z');
      const result = evaluateSchedule(config, insideDate);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('INSIDE_ALLOWED_WINDOW');
      expect(result.currentWindow?.name).toBe('Overnight Window');
      expect(result.windowEnd).toBeDefined();
    });

    it('disallows execution outside allowed window and calculates next window start', () => {
      const config: ScheduleConfig = {
        id: 'test',
        name: 'Overnight Schedule',
        enabled: true,
        timezone: 'UTC',
        mode: 'ALLOW',
        windows: [
          {
            name: 'Overnight Window',
            start: '22:00',
            end: '06:00',
            days: [0, 1, 2, 3, 4, 5, 6],
          },
        ],
        stop_at_hour: null,
        graceful_completion: true,
        max_runs_per_window: null,
      };

      const outsideDate = new Date('2026-10-23T14:00:00.000Z');
      const result = evaluateSchedule(config, outsideDate);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('OUTSIDE_ALLOWED_WINDOW');
      expect(result.nextWindowStart).toBeDefined();
      expect(result.msUntilNextWindow).toBeGreaterThan(0);
    });

    it('enforces stop_at_hour deadline strictly', () => {
      const config: ScheduleConfig = {
        id: 'test',
        name: 'Overnight with Stop Hour',
        enabled: true,
        timezone: 'UTC',
        mode: 'ALLOW',
        windows: [
          {
            name: 'Overnight Window',
            start: '00:00',
            end: '12:00',
            days: [0, 1, 2, 3, 4, 5, 6],
          },
        ],
        stop_at_hour: 7,
        graceful_completion: true,
        max_runs_per_window: null,
      };

      const pastDeadlineDate = new Date('2026-10-23T08:00:00.000Z');
      const result = evaluateSchedule(config, pastDeadlineDate);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('DEADLINE_REACHED');
    });

    it('supports BLOCK mode (blocks execution inside designated windows)', () => {
      const config: ScheduleConfig = {
        id: 'test',
        name: 'Block Daytime',
        enabled: true,
        timezone: 'UTC',
        mode: 'BLOCK',
        windows: [
          {
            name: 'Peak Working Hours',
            start: '09:00',
            end: '17:00',
            days: [1, 2, 3, 4, 5],
          },
        ],
        stop_at_hour: null,
        graceful_completion: true,
        max_runs_per_window: null,
      };

      // Monday 11:00 -> blocked
      const monday11 = new Date('2026-10-26T11:00:00.000Z');
      const resBlocked = evaluateSchedule(config, monday11);
      expect(resBlocked.allowed).toBe(false);
      expect(resBlocked.reason).toBe('INSIDE_BLOCKED_WINDOW');

      // Monday 20:00 -> allowed
      const monday20 = new Date('2026-10-26T20:00:00.000Z');
      const resAllowed = evaluateSchedule(config, monday20);
      expect(resAllowed.allowed).toBe(true);
      expect(resAllowed.reason).toBe('OUTSIDE_BLOCKED_WINDOW');
    });
  });
});
