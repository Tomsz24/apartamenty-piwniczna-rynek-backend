export type StatisticsApartment = {
  id: string;
  name: string;
  hostexPropertyId: number;
};

export type StatisticsStay = {
  reservationCode: string;
  apartmentId: string;
  channelType: string;
  status: string;
  checkInDate: string;
  checkOutDate: string;
  bookedAt: string;
  cancelledAt: string | null;
  guestCount: number;
  adults: number;
  children: number;
  infants: number;
  pets: number;
  amount: number | null;
  currency: string | null;
};

export type StatisticsTransaction = {
  id: string;
  direction: 'income' | 'expense';
  amount: number;
  currency: string;
  status: string;
  actionAt: string | null;
  itemName: string | null;
  paymentMethodName: string | null;
  propertyId: number | null;
};

export type StatisticsAvailability = {
  availableByDate: Record<string, boolean>;
};

export type StatisticsReview = {
  score: number;
  channelType?: string;
};

export type StatisticsTask = {
  type: string;
  status: string;
  fee: number | null;
  currency: string | null;
};

export function buildStatistics(input: {
  from: string;
  to: string;
  apartments: StatisticsApartment[];
  stays: StatisticsStay[];
  transactions: StatisticsTransaction[];
  transactionsComplete: boolean;
  unavailableTransactionApartments: string[];
  availabilityByProperty: Record<number, StatisticsAvailability>;
  availabilityComplete: boolean;
  reviews: StatisticsReview[];
  reviewsComplete: boolean;
  unavailableReviewApartments: string[];
  tasks: StatisticsTask[];
  tasksComplete: boolean;
  unavailableTaskApartments: string[];
}) {
  const days = listDays(input.from, input.to);
  const confirmed = input.stays.filter((stay) => stay.status === 'accepted');
  const pending = input.stays.filter((stay) => ['wait_accept', 'wait_pay'].includes(stay.status));
  const cancelled = input.stays.filter((stay) => stay.status === 'cancelled');
  const arrivals = confirmed.filter((stay) => inRange(stay.checkInDate, input.from, input.to));
  const departures = confirmed.filter((stay) => inRange(stay.checkOutDate, input.from, input.to));

  const apartmentRows = input.apartments.map((apartment) => {
    const stays = confirmed.filter((stay) => stay.apartmentId === apartment.id);
    const occupiedDates = new Set<string>();
    for (const stay of stays) {
      for (const date of nightsInRange(stay.checkInDate, stay.checkOutDate, input.from, input.to)) {
        occupiedDates.add(date);
      }
    }
    const availability = input.availabilityByProperty[apartment.hostexPropertyId]?.availableByDate ?? {};
    let blockedNights = 0;
    let sellableNights = 0;
    for (const date of days) {
      const available = availability[date];
      if (available === false && !occupiedDates.has(date)) blockedNights += 1;
      else sellableNights += 1;
    }
    const bookedInPeriod = arrivals.filter((stay) => stay.apartmentId === apartment.id);
    const revenue = calculateStayRevenue(stays, input.from, input.to, apartment.id);
    const propertyTransactions = input.transactions.filter((transaction) => transaction.propertyId === apartment.hostexPropertyId);
    const paidIncome = sumTransactionMoney(propertyTransactions, 'income', 'paid');
    const paidExpenses = sumTransactionMoney(propertyTransactions, 'expense', 'paid');
    return {
      apartmentId: apartment.id,
      name: apartment.name,
      reservationCount: stays.filter((stay) => overlaps(stay.checkInDate, stay.checkOutDate, input.from, input.to)).length,
      arrivals: bookedInPeriod.length,
      departures: departures.filter((stay) => stay.apartmentId === apartment.id).length,
      occupiedNights: occupiedDates.size,
      blockedNights,
      sellableNights,
      occupancyPercent: percent(occupiedDates.size, sellableNights),
      bookingValueForArrivals: sumMoney(bookedInPeriod),
      estimatedRoomRevenue: revenue,
      paidIncome,
      outstandingIncome: sumTransactionMoney(propertyTransactions, 'income', 'outstanding'),
      paidExpenses,
      netPaidCashflow: subtractMoney(paidIncome, paidExpenses),
    };
  });

  const occupiedNights = apartmentRows.reduce((total, row) => total + row.occupiedNights, 0);
  const blockedNights = apartmentRows.reduce((total, row) => total + row.blockedNights, 0);
  const sellableNights = apartmentRows.reduce((total, row) => total + row.sellableNights, 0);
  const bookingValueForArrivals = sumMoney(arrivals);
  const estimatedRoomRevenue = calculateStayRevenue(confirmed, input.from, input.to);
  const currencyTotals = sumByCurrency(input.transactions, (transaction) => transaction.amount, (transaction) => transaction.direction === 'income' && transaction.status === 'paid');
  const outstandingIncome = sumByCurrency(input.transactions, (transaction) => transaction.amount, (transaction) => transaction.direction === 'income' && transaction.status === 'outstanding');
  const paidExpenses = sumByCurrency(input.transactions, (transaction) => transaction.amount, (transaction) => transaction.direction === 'expense' && transaction.status === 'paid');
  const outstandingExpenses = sumByCurrency(input.transactions, (transaction) => transaction.amount, (transaction) => transaction.direction === 'expense' && transaction.status === 'outstanding');
  const byDate = days.map((date) => {
    const dayStays = confirmed.filter((stay) => stay.checkInDate === date);
    const nightGuests = confirmed
      .filter((stay) => stay.checkInDate <= date && stay.checkOutDate > date)
      .reduce((total, stay) => total + stay.guestCount, 0);
    const dayTransactions = input.transactions.filter((transaction) => transaction.actionAt?.slice(0, 10) === date);
    const dateRevenue = calculateStayRevenue(confirmed, date, nextDate(date));
    let occupiedApartments = 0;
    let sellableApartments = 0;
    for (const apartment of input.apartments) {
      const occupied = confirmed.some((stay) => stay.apartmentId === apartment.id && stay.checkInDate <= date && stay.checkOutDate > date);
      const availability = input.availabilityByProperty[apartment.hostexPropertyId]?.availableByDate[date];
      if (occupied) {
        occupiedApartments += 1;
        sellableApartments += 1;
      } else if (availability !== false) {
        sellableApartments += 1;
      }
    }
    return {
      date,
      arrivals: dayStays.length,
      departures: departures.filter((stay) => stay.checkOutDate === date).length,
      guestsStaying: nightGuests,
      occupiedApartments,
      sellableApartments,
      occupancyPercent: percent(occupiedApartments, sellableApartments),
      estimatedRoomRevenue: dateRevenue,
      paidIncome: sumTransactionMoney(dayTransactions, 'income', 'paid'),
      paidExpenses: sumTransactionMoney(dayTransactions, 'expense', 'paid'),
    };
  });

  const channelStays = new Map<string, StatisticsStay[]>();
  for (const stay of confirmed.filter((item) => overlaps(item.checkInDate, item.checkOutDate, input.from, input.to))) {
    const key = stay.channelType || 'unknown';
    const rows = channelStays.get(key) ?? [];
    rows.push(stay);
    channelStays.set(key, rows);
  }

  const incomeCategories = aggregateTransactions(input.transactions, 'income');
  const expenseCategories = aggregateTransactions(input.transactions, 'expense');
  const averageStayNights = average(arrivals.map((stay) => dayDifference(stay.checkOutDate, stay.checkInDate)));
  const averageLeadTimeDays = average(arrivals.map((stay) => Math.max(0, dayDifference(stay.checkInDate, stay.bookedAt.slice(0, 10)))));
  const estimatedRevenueByCurrency = calculateStayRevenue(confirmed, input.from, input.to);
  const ratedNightsByCurrency = calculateRatedNights(confirmed, input.from, input.to);
  const averageDailyRateByCurrency = Object.fromEntries(
    Object.entries(estimatedRevenueByCurrency).map(([currency, amount]) => [
      currency,
      ratedNightsByCurrency[currency] ? round(amount / ratedNightsByCurrency[currency]) : null,
    ]),
  );
  const reviewsByChannel = new Map<string, number[]>();
  for (const review of input.reviews) {
    const channel = review.channelType || 'unknown';
    const scores = reviewsByChannel.get(channel) ?? [];
    scores.push(review.score);
    reviewsByChannel.set(channel, scores);
  }

  return {
    period: { from: input.from, to: input.to, toExclusive: true, timeZone: 'Europe/Warsaw' },
    summary: {
      reservations: confirmed.filter((stay) => overlaps(stay.checkInDate, stay.checkOutDate, input.from, input.to)).length,
      arrivals: arrivals.length,
      departures: departures.length,
      pendingReservations: pending.filter((stay) => overlaps(stay.checkInDate, stay.checkOutDate, input.from, input.to)).length,
      cancellations: cancelled.filter((stay) => stay.cancelledAt && inRange(stay.cancelledAt.slice(0, 10), input.from, input.to)).length,
      occupiedNights,
      blockedNights,
      sellableNights,
      occupancyPercent: percent(occupiedNights, sellableNights),
      guestsArriving: arrivals.reduce((total, stay) => total + stay.guestCount, 0),
      adultsArriving: arrivals.reduce((total, stay) => total + stay.adults, 0),
      childrenArriving: arrivals.reduce((total, stay) => total + stay.children, 0),
      infantsArriving: arrivals.reduce((total, stay) => total + stay.infants, 0),
      petsArriving: arrivals.reduce((total, stay) => total + stay.pets, 0),
      guestNights: confirmed.reduce((total, stay) => total + nightsInRange(stay.checkInDate, stay.checkOutDate, input.from, input.to).length * stay.guestCount, 0),
      averageStayNights,
      averageLeadTimeDays,
      averageDailyRateByCurrency,
      bookingValueForArrivals,
      estimatedRoomRevenue: estimatedRevenueByCurrency,
    },
    finances: {
      paidIncome: currencyTotals,
      outstandingIncome,
      paidExpenses,
      outstandingExpenses,
      netPaidCashflow: subtractMoney(currencyTotals, paidExpenses),
      dataSource: 'hostex_transactions',
      complete: input.transactionsComplete,
      unavailableApartments: input.unavailableTransactionApartments,
    },
    byApartment: apartmentRows,
    byChannel: [...channelStays.entries()].map(([channelType, stays]) => ({
      channelType,
      reservations: stays.length,
      arrivals: stays.filter((stay) => inRange(stay.checkInDate, input.from, input.to)).length,
      estimatedRoomRevenue: calculateStayRevenue(stays, input.from, input.to),
      bookingValueForArrivals: sumMoney(stays.filter((stay) => inRange(stay.checkInDate, input.from, input.to))),
    })),
    byDate,
    incomeCategories,
    expenseCategories,
    reviews: {
      count: input.reviews.length,
      complete: input.reviewsComplete,
      unavailableApartments: input.unavailableReviewApartments,
      byChannel: [...reviewsByChannel.entries()].map(([channelType, scores]) => ({
        channelType,
        count: scores.length,
        averageScore: average(scores),
        minScore: Math.min(...scores),
        maxScore: Math.max(...scores),
      })),
      scoreScale: 'rating scale per channel; channel values are not combined',
    },
    tasks: {
      count: input.tasks.length,
      complete: input.tasksComplete,
      unavailableApartments: input.unavailableTaskApartments,
      completed: input.tasks.filter((task) => task.status === 'completed').length,
      pending: input.tasks.filter((task) => task.status === 'pending').length,
      inProgress: input.tasks.filter((task) => task.status === 'in_progress').length,
      cancelled: input.tasks.filter((task) => task.status === 'cancelled').length,
      cleaning: input.tasks.filter((task) => task.type === 'cleaning').length,
      fees: sumByCurrency(input.tasks, (task) => task.fee ?? 0, (task) => task.status !== 'cancelled', (task) => task.currency),
    },
    dataQuality: {
      availabilityComplete: input.availabilityComplete,
      occupancyBasis: input.availabilityComplete ? 'hostex_sellable_nights_excluding_blocked_dates' : 'calendar_nights_without_hostex_availability_history',
      estimatedRoomRevenueUsesEvenNightAllocation: true,
      transactionStatusesAreSeparated: true,
    },
  };
}

function calculateStayRevenue(stays: StatisticsStay[], from: string, to: string, apartmentId?: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const stay of stays) {
    if (apartmentId && stay.apartmentId !== apartmentId) continue;
    if (stay.amount === null || !stay.currency) continue;
    const totalNights = dayDifference(stay.checkOutDate, stay.checkInDate);
    if (totalNights <= 0) continue;
    const includedNights = nightsInRange(stay.checkInDate, stay.checkOutDate, from, to).length;
    if (includedNights === 0) continue;
    result[stay.currency] = (result[stay.currency] ?? 0) + stay.amount * includedNights / totalNights;
  }
  return roundMoney(result);
}

function calculateRatedNights(stays: StatisticsStay[], from: string, to: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const stay of stays) {
    if (!stay.currency || stay.amount === null) continue;
    result[stay.currency] = (result[stay.currency] ?? 0) + nightsInRange(stay.checkInDate, stay.checkOutDate, from, to).length;
  }
  return result;
}

function sumMoney(stays: StatisticsStay[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const stay of stays) {
    if (stay.amount === null || !stay.currency) continue;
    result[stay.currency] = (result[stay.currency] ?? 0) + stay.amount;
  }
  return roundMoney(result);
}

function sumByCurrency<T>(items: T[], amount: (item: T) => number, include: (item: T) => boolean, currency: (item: T) => string | null = (item) => (item as StatisticsTransaction).currency): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) {
    if (!include(item)) continue;
    const code = currency(item);
    if (!code) continue;
    result[code] = (result[code] ?? 0) + amount(item);
  }
  return roundMoney(result);
}

function sumTransactionMoney(items: StatisticsTransaction[], direction: 'income' | 'expense', status: string): Record<string, number> {
  return sumByCurrency(items, (item) => item.amount, (item) => item.direction === direction && item.status === status);
}

function aggregateTransactions(items: StatisticsTransaction[], direction: 'income' | 'expense') {
  const groups = new Map<string, { currency: string; itemName: string; count: number; paid: number; outstanding: number }>();
  for (const item of items.filter((entry) => entry.direction === direction)) {
    const itemName = item.itemName || 'Pozostałe';
    const key = `${item.currency}\0${itemName}`;
    const group = groups.get(key) ?? { currency: item.currency, itemName, count: 0, paid: 0, outstanding: 0 };
    group.count += 1;
    if (item.status === 'paid') group.paid += item.amount;
    if (item.status === 'outstanding') group.outstanding += item.amount;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({ ...group, paid: round(group.paid), outstanding: round(group.outstanding) }));
}

function listDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let date = from; date < to; date = nextDate(date)) days.push(date);
  return days;
}

function nightsInRange(checkIn: string, checkOut: string, from: string, to: string): string[] {
  const start = checkIn > from ? checkIn : from;
  const end = checkOut < to ? checkOut : to;
  return start < end ? listDays(start, end) : [];
}

function overlaps(start: string, end: string, from: string, to: string): boolean {
  return start < to && end > from;
}

function inRange(date: string, from: string, to: string): boolean {
  return date >= from && date < to;
}

function nextDate(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function dayDifference(later: string, earlier: string): number {
  return Math.round((Date.parse(`${later}T00:00:00.000Z`) - Date.parse(`${earlier}T00:00:00.000Z`)) / 86_400_000);
}

function percent(numerator: number, denominator: number): number {
  return denominator > 0 ? round(numerator * 100 / denominator) : 0;
}

function average(values: number[]): number | null {
  return values.length > 0 ? round(values.reduce((total, value) => total + value, 0) / values.length) : null;
}

function roundMoney(value: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).map(([currency, amount]) => [currency, round(amount)]));
}

function subtractMoney(left: Record<string, number>, right: Record<string, number>): Record<string, number> {
  const currencies = new Set([...Object.keys(left), ...Object.keys(right)]);
  return roundMoney(Object.fromEntries([...currencies].map((currency) => [currency, (left[currency] ?? 0) - (right[currency] ?? 0)])));
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
