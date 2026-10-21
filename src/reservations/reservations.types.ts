export const RESERVATION_ORIGINS = ['manual', 'booking_email', 'booking_ical', 'hostex'] as const;
export type ReservationOrigin = (typeof RESERVATION_ORIGINS)[number];

export const RESERVATION_STATUSES = [
  'confirmed',
  'tentative',
  'blocked',
  'cancelled',
  'needs_review',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export interface ReservationDto {
  id: string;
  apartmentId: string;
  apartmentName?: string;
  origin: ReservationOrigin;
  status: ReservationStatus;
  startDate: string;
  endDate: string;
  guestName: string | null;
  guestCount: number | null;
  adults: number | null;
  children: number | null;
  infants: number | null;
  pets: number | null;
  childAges: number[] | null;
  guestPhone: string | null;
  guestEmail: string | null;
  totalRateAmount: number | null;
  amountReceived: number | null;
  currency: string | null;
  paymentStatus: string | null;
  channelType: string | null;
  conversationId: string | null;
  arrivalMessageSentAt: string | null;
  note: string | null;
  externalId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface OrphanedReservationNoteDto {
  id: string;
  apartmentId: string;
  apartmentName: string;
  sourceSystem: string;
  externalId: string;
  note: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ReservationActor {
  id: string;
  email: string;
}
