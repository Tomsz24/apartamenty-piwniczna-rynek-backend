import { randomInt } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

const FORBIDDEN_CODES = new Set([
  '0000',
  '1111',
  '2222',
  '3333',
  '4444',
  '5555',
  '6666',
  '7777',
  '8888',
  '9999',
  '0123',
  '1234',
  '2345',
  '3456',
  '4567',
  '5678',
  '6789',
  '9876',
  '8765',
  '7654',
  '6543',
  '5432',
  '4321',
  '3210',
]);

export function isAllowedFourDigitCode(code: string): boolean {
  return /^\d{4}$/.test(code) && !FORBIDDEN_CODES.has(code);
}

export function generateFourDigitCode(
  draw: () => number = () => randomInt(0, 10_000),
): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = draw();
    if (!Number.isInteger(value) || value < 0 || value > 9_999) {
      throw new Error('Generator kodu zwrócił wartość spoza zakresu 0–9999');
    }
    const code = value.toString().padStart(4, '0');
    if (isAllowedFourDigitCode(code)) return code;
  }
  throw new Error('Nie udało się wylosować bezpiecznego czterocyfrowego kodu');
}

export type AccessCodeCursor = { validFrom: string; id: string };

export function encodeAccessCodeCursor(cursor: AccessCodeCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeAccessCodeCursor(value?: string): AccessCodeCursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      typeof (decoded as AccessCodeCursor).validFrom !== 'string' ||
      typeof (decoded as AccessCodeCursor).id !== 'string' ||
      Number.isNaN(new Date((decoded as AccessCodeCursor).validFrom).getTime()) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        (decoded as AccessCodeCursor).id,
      )
    ) {
      throw new Error('invalid cursor');
    }
    return decoded as AccessCodeCursor;
  } catch {
    throw new BadRequestException('Nieprawidłowy kursor historii kodów');
  }
}

type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type AccessCodeValidityPolicy = {
  startDate: string;
  endDate: string;
  checkInTime: string;
  checkOutTime: string;
  timeZone: string;
};

export function buildAccessCodeValidity(policy: AccessCodeValidityPolicy): {
  validFrom: Date;
  validUntil: Date;
} {
  const validFrom = localDateTimeToUtc(policy.startDate, policy.checkInTime, policy.timeZone);
  const validUntil = localDateTimeToUtc(
    policy.endDate,
    policy.checkOutTime,
    policy.timeZone,
  );
  if (validUntil.getTime() <= validFrom.getTime()) {
    throw new BadRequestException(
      'Domyślna godzina końca dostępu musi przypadać po początku dostępu',
    );
  }
  return { validFrom, validUntil };
}

export function formatDateInTimeZone(value: Date, timeZone: string): string {
  const parts = getZonedParts(value, timeZone);
  return `${parts.year.toString().padStart(4, '0')}-${parts.month
    .toString()
    .padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`;
}

function localDateTimeToUtc(date: string, time: string, timeZone: string): Date {
  const dateParts = parseDate(date);
  const timeParts = parseTime(time);
  assertTimeZone(timeZone);
  const expected: LocalDateTimeParts = { ...dateParts, ...timeParts };
  const localAsUtc = Date.UTC(
    expected.year,
    expected.month - 1,
    expected.day,
    expected.hour,
    expected.minute,
    expected.second,
  );

  let candidate = localAsUtc;
  for (let attempt = 0; attempt < 4; attempt++) {
    const represented = getZonedParts(new Date(candidate), timeZone);
    const representedAsUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
    );
    const next = localAsUtc - (representedAsUtc - candidate);
    if (next === candidate) break;
    candidate = next;
  }

  const result = new Date(candidate);
  const actual = getZonedParts(result, timeZone);
  const differsFromExpected = Object.keys(expected).some(
    (key) =>
      actual[key as keyof LocalDateTimeParts] !==
      expected[key as keyof LocalDateTimeParts],
  );
  if (differsFromExpected) {
    throw new BadRequestException(
      `Godzina ${date} ${time} nie istnieje w strefie ${timeZone}`,
    );
  }
  return result;
}

function parseDate(value: string): Pick<LocalDateTimeParts, 'year' | 'month' | 'day'> {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new BadRequestException('Nieprawidłowa data polityki dostępu');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new BadRequestException('Nieprawidłowa data polityki dostępu');
  }
  return { year, month, day };
}

function parseTime(
  value: string,
): Pick<LocalDateTimeParts, 'hour' | 'minute' | 'second'> {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,6})?)?$/.exec(
    value,
  );
  if (!match) throw new BadRequestException('Nieprawidłowa godzina polityki dostępu');
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
    second: Number(match[3] ?? 0),
  };
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  } catch {
    throw new BadRequestException(`Nieprawidłowa strefa czasowa: ${timeZone}`);
  }
}

function getZonedParts(value: Date, timeZone: string): LocalDateTimeParts {
  assertTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}
