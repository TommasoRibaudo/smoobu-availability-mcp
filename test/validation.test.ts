import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../src/errors.js';
import {
  addDays,
  addMonths,
  daysBetween,
  eachDay,
  parseIsoDate,
  todayInCostaRica,
  validateCalendarRange,
  validateStay,
} from '../src/validation.js';

const TODAY = '2026-10-04';

function stay(overrides: Partial<Parameters<typeof validateStay>[0]> = {}): Parameters<typeof validateStay>[0] {
  return { arrival: '2026-10-10', departure: '2026-10-13', guests: 2, today: TODAY, maxGuests: 6, ...overrides };
}

function range(overrides: Partial<Parameters<typeof validateCalendarRange>[0]> = {}): Parameters<typeof validateCalendarRange>[0] {
  return { from: '2026-10-10', to: '2026-10-20', today: TODAY, ...overrides };
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(UserFacingError);
    return (err as UserFacingError).message;
  }
  throw new Error('expected function to throw');
}

describe('todayInCostaRica', () => {
  it('is still the previous day at 03:30Z (21:30 in UTC-6)', () => {
    expect(todayInCostaRica(new Date('2026-10-05T03:30:00Z'))).toBe('2026-10-04');
  });

  it('rolls over at 06:00Z (midnight in UTC-6)', () => {
    expect(todayInCostaRica(new Date('2026-10-05T06:00:00Z'))).toBe('2026-10-05');
  });

  it('is one second before the rollover still the previous day', () => {
    expect(todayInCostaRica(new Date('2026-10-05T05:59:59Z'))).toBe('2026-10-04');
  });

  it('does not observe daylight saving time in July', () => {
    expect(todayInCostaRica(new Date('2026-07-01T05:59:00Z'))).toBe('2026-06-30');
    expect(todayInCostaRica(new Date('2026-07-01T06:00:00Z'))).toBe('2026-07-01');
  });
});

describe('parseIsoDate', () => {
  it.each(['2026-1-5', '2026/01/05', '2026-02-30', '2026-13-01', 'tomorrow'])('rejects %s and names the field', (value) => {
    const msg = messageOf(() => parseIsoDate(value, 'arrival'));
    expect(msg).toContain('arrival');
  });

  it('accepts a leap day', () => {
    expect(parseIsoDate('2024-02-29', 'arrival')).toBe(Date.UTC(2024, 1, 29));
  });

  it('rejects Feb 29 in a non-leap year', () => {
    expect(() => parseIsoDate('2026-02-29', 'arrival')).toThrow(UserFacingError);
  });

  it('rejects trailing garbage and surrounding whitespace', () => {
    expect(() => parseIsoDate('2026-01-05T00:00:00Z', 'arrival')).toThrow(UserFacingError);
    expect(() => parseIsoDate(' 2026-01-05', 'arrival')).toThrow(UserFacingError);
  });

  it('truncates very long input in the message', () => {
    const msg = messageOf(() => parseIsoDate('x'.repeat(500), 'arrival'));
    expect(msg.length).toBeLessThan(200);
  });
});

describe('date arithmetic', () => {
  it('addMonths clamps to the end of a shorter month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('addMonths adds 18 months across a year boundary', () => {
    expect(addMonths('2026-10-04', 18)).toBe('2028-04-04');
  });

  it('addMonths handles negative months and year rollover', () => {
    expect(addMonths('2026-01-15', -2)).toBe('2025-11-15');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
  });

  it('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-10-04', 0)).toBe('2026-10-04');
  });

  it('daysBetween counts calendar days and may be negative', () => {
    expect(daysBetween('2026-10-04', '2026-10-04')).toBe(0);
    expect(daysBetween('2026-10-04', '2026-10-11')).toBe(7);
    expect(daysBetween('2026-10-11', '2026-10-04')).toBe(-7);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });

  it('eachDay is inclusive of both ends', () => {
    expect([...eachDay('2026-12-30', '2027-01-02')]).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  });

  it('eachDay yields a single day when from equals to and nothing when reversed', () => {
    expect([...eachDay('2026-10-04', '2026-10-04')]).toEqual(['2026-10-04']);
    expect([...eachDay('2026-10-05', '2026-10-04')]).toEqual([]);
  });
});

describe('validateStay', () => {
  it('returns the nights count', () => {
    expect(validateStay(stay())).toEqual({ arrival: '2026-10-10', departure: '2026-10-13', guests: 2, nights: 3 });
  });

  it('rejects an arrival before today', () => {
    expect(messageOf(() => validateStay(stay({ arrival: '2026-10-03', departure: '2026-10-05' })))).toContain('in the past');
  });

  it('accepts an arrival equal to today', () => {
    expect(validateStay(stay({ arrival: TODAY, departure: '2026-10-05' })).nights).toBe(1);
  });

  it('accepts an arrival exactly 18 months out', () => {
    expect(validateStay(stay({ arrival: '2028-04-04', departure: '2028-04-06' })).nights).toBe(2);
  });

  it('rejects an arrival one day beyond 18 months', () => {
    expect(messageOf(() => validateStay(stay({ arrival: '2028-04-05', departure: '2028-04-07' })))).toContain('too far ahead');
  });

  it('rejects departure equal to arrival', () => {
    expect(() => validateStay(stay({ arrival: '2026-10-10', departure: '2026-10-10' }))).toThrow(UserFacingError);
  });

  it('rejects departure before arrival', () => {
    expect(() => validateStay(stay({ arrival: '2026-10-10', departure: '2026-10-09' }))).toThrow(UserFacingError);
  });

  it('accepts 60 nights', () => {
    expect(validateStay(stay({ arrival: TODAY, departure: addDays(TODAY, 60) })).nights).toBe(60);
  });

  it('rejects 61 nights and mentions the maximum of 60', () => {
    const msg = messageOf(() => validateStay(stay({ arrival: TODAY, departure: addDays(TODAY, 61) })));
    expect(msg).toContain('60');
  });

  it('rejects zero guests', () => {
    expect(() => validateStay(stay({ guests: 0 }))).toThrow(UserFacingError);
  });

  it('rejects more guests than maxGuests and states the allowed range', () => {
    expect(messageOf(() => validateStay(stay({ guests: 7 })))).toContain('between 1 and 6');
  });

  it('accepts guests equal to maxGuests', () => {
    expect(validateStay(stay({ guests: 6 })).guests).toBe(6);
  });

  it('rejects fractional guests', () => {
    expect(() => validateStay(stay({ guests: 1.5 }))).toThrow(UserFacingError);
  });

  it('rejects NaN and negative guests', () => {
    expect(() => validateStay(stay({ guests: Number.NaN }))).toThrow(UserFacingError);
    expect(() => validateStay(stay({ guests: -2 }))).toThrow(UserFacingError);
  });

  it('names the offending field for malformed dates', () => {
    expect(messageOf(() => validateStay(stay({ arrival: '10/10/2026' })))).toContain('arrival');
    expect(messageOf(() => validateStay(stay({ departure: 'soon' })))).toContain('departure');
  });
});

describe('validateCalendarRange', () => {
  it('returns the inclusive day count', () => {
    expect(validateCalendarRange(range({ from: '2026-10-10', to: '2026-10-10' })).days).toBe(1);
    expect(validateCalendarRange(range({ from: '2026-10-10', to: '2026-10-16' }))).toEqual({ from: '2026-10-10', to: '2026-10-16', days: 7 });
  });

  it('rejects a from before today', () => {
    expect(messageOf(() => validateCalendarRange(range({ from: '2026-10-03' })))).toContain('in the past');
  });

  it('accepts from equal to today', () => {
    expect(validateCalendarRange(range({ from: TODAY, to: TODAY })).days).toBe(1);
  });

  it('rejects to earlier than from', () => {
    expect(() => validateCalendarRange(range({ from: '2026-10-10', to: '2026-10-09' }))).toThrow(UserFacingError);
  });

  it('accepts exactly 92 days inclusive', () => {
    expect(validateCalendarRange(range({ from: TODAY, to: addDays(TODAY, 91) })).days).toBe(92);
  });

  it('rejects 93 days and mentions the 92 day limit', () => {
    const msg = messageOf(() => validateCalendarRange(range({ from: TODAY, to: addDays(TODAY, 92) })));
    expect(msg).toContain('92');
  });

  it('rejects a range ending beyond 18 months', () => {
    expect(messageOf(() => validateCalendarRange(range({ from: '2028-04-04', to: '2028-04-05' })))).toContain('too far ahead');
  });

  it('accepts a range ending exactly at the 18 month horizon', () => {
    expect(validateCalendarRange(range({ from: '2028-04-02', to: '2028-04-04' })).days).toBe(3);
  });

  it('names the offending field for malformed dates', () => {
    expect(messageOf(() => validateCalendarRange(range({ from: 'nope' })))).toContain('from');
    expect(messageOf(() => validateCalendarRange(range({ to: '2026-02-30' })))).toContain('to');
  });
});

describe('error hygiene', () => {
  const failing: (() => unknown)[] = [
    () => parseIsoDate('2026-1-5', 'arrival'),
    () => parseIsoDate('2026-02-30', 'arrival'),
    () => validateStay(stay({ arrival: '2026-10-03' })),
    () => validateStay(stay({ arrival: '2028-04-05', departure: '2028-04-07' })),
    () => validateStay(stay({ departure: '2026-10-10' })),
    () => validateStay(stay({ arrival: TODAY, departure: addDays(TODAY, 61) })),
    () => validateStay(stay({ guests: 0 })),
    () => validateStay(stay({ guests: 7 })),
    () => validateStay(stay({ guests: 1.5 })),
    () => validateCalendarRange(range({ from: '2026-10-03' })),
    () => validateCalendarRange(range({ to: '2026-10-09' })),
    () => validateCalendarRange(range({ from: TODAY, to: addDays(TODAY, 92) })),
    () => validateCalendarRange(range({ from: '2028-04-04', to: '2028-04-05' })),
  ];

  it.each(failing.map((fn, i) => [i, fn] as const))('case %i throws a UserFacingError without "Error:" or a stack', (_i, fn) => {
    let caught: unknown;
    try {
      fn();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UserFacingError);
    const message = (caught as UserFacingError).message;
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain('Error:');
    expect(message).not.toMatch(/\n\s+at /);
    expect(message).not.toMatch(/\.ts:\d+/);
  });
});
