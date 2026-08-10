const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateDateRange(startDate: string, endDate: string): string | null {
  if (!isValidIsoDate(startDate) || !isValidIsoDate(endDate)) {
    return 'Daty muszą mieć poprawny format YYYY-MM-DD';
  }

  if (endDate <= startDate) {
    return 'Data wyjazdu musi być późniejsza niż data przyjazdu';
  }

  return null;
}

export function rangesOverlap(
  firstStart: string,
  firstEnd: string,
  secondStart: string,
  secondEnd: string,
): boolean {
  return firstStart < secondEnd && firstEnd > secondStart;
}

export function selectUniqueDateMatch<T extends { startDate: string; endDate: string }>(
  candidates: T[],
  startDate: string,
  endDate: string,
): T | null {
  const exactMatches = candidates.filter(
    (candidate) => candidate.startDate === startDate && candidate.endDate === endDate,
  );

  return exactMatches.length === 1 ? exactMatches[0] : null;
}
