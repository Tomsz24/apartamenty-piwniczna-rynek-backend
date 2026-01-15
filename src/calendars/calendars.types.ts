export interface BookingDto {
  id: string;
  startDate: string;
  endDate: string;
  source: 'manual' | 'external';
  note?: string;
}

export interface ApartmentCalendarDto {
  apartmentId: string;
  apartmentName: string;
  bookings: BookingDto[];
}

export interface CalendarsResponseDto {
  gory: ApartmentCalendarDto;
  rynek: ApartmentCalendarDto;
}

export interface CreateBookingDto {
  apartmentId: string;
  startDate: string;
  endDate: string;
  note?: string;
  createdBy?: string;
}

export interface UpdateBookingDto {
  startDate?: string;
  endDate?: string;
  note?: string;
}
