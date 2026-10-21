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

export type RangeCoverage = 'none' | 'exact_single' | 'covered' | 'partial';

export function classifyRangeCoverage<T extends { startDate: string; endDate: string }>(
  candidates: T[],
  startDate: string,
  endDate: string,
): RangeCoverage {
  const overlaps = candidates
    .filter((candidate) =>
      rangesOverlap(candidate.startDate, candidate.endDate, startDate, endDate),
    )
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.endDate.localeCompare(b.endDate));

  if (overlaps.length === 0) return 'none';

  if (
    overlaps.length === 1 &&
    overlaps[0].startDate === startDate &&
    overlaps[0].endDate === endDate
  ) {
    return 'exact_single';
  }

  let coveredUntil: string | null = null;
  for (const range of overlaps) {
    if (coveredUntil === null) {
      if (range.startDate > startDate) return 'partial';
      coveredUntil = range.endDate;
    } else if (range.startDate <= coveredUntil) {
      if (range.endDate > coveredUntil) coveredUntil = range.endDate;
    } else {
      return 'partial';
    }

    if (coveredUntil >= endDate) return 'covered';
  }

  return 'partial';
}
