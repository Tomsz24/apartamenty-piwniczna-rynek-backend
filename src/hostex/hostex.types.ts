export const HOSTEX_RESERVATION_STATUSES = [
  'wait_accept',
  'wait_pay',
  'accepted',
  'cancelled',
  'denied',
  'timeout',
] as const;

export type HostexReservationStatus = (typeof HOSTEX_RESERVATION_STATUSES)[number];

export const HOSTEX_RESERVATION_ORDER_FIELDS = [
  'booked_at',
  'check_in_date',
  'check_out_date',
  'cancelled_at',
  'created_at',
] as const;

export type HostexReservationOrderField =
  (typeof HOSTEX_RESERVATION_ORDER_FIELDS)[number];

export const HOSTEX_CHANNEL_TYPES = [
  'airbnb',
  'booking.com',
  'agoda',
  'expedia',
  'vrbo',
  'trip.com',
  'booking_site',
  'tujia_intl',
  'hostex_direct',
  'tujia',
  'xiaozhu',
  'meituan_bnb',
  'meituan_hotel',
  'muniao',
  'fliggy',
  'zhukeyun',
  'tiktok',
  'xiaohongshu',
  'ctrip',
  'houfy',
] as const;

export type HostexChannelType = (typeof HOSTEX_CHANNEL_TYPES)[number];

export type HostexIntegrationStatus = {
  enabled: boolean;
  ready: boolean;
  mode: 'read_only';
  writesEnabled: false;
  accessTokenConfigured: boolean;
  apiBaseUrlConfigured: boolean;
};

export type HostexChannelSummary = {
  channelType: string;
  listingId: string;
  currency: string | null;
};

export type HostexNamedReference = {
  id: number;
  name: string;
};

export type HostexTagSummary = HostexNamedReference & {
  color: string | null;
};

export type HostexPropertySummary = {
  id: number;
  title: string;
  address: string | null;
  longitude: string | null;
  latitude: string | null;
  channels: HostexChannelSummary[];
  groups: HostexNamedReference[];
  tags: HostexTagSummary[];
};

export type HostexReservationSummary = {
  reservationCode: string;
  stayCode: string;
  channelId: string | null;
  propertyId: number;
  channelType: string;
  listingId: string | null;
  checkInDate: string;
  checkOutDate: string;
  numberOfGuests: number | null;
  numberOfAdults: number | null;
  numberOfChildren: number | null;
  numberOfInfants: number | null;
  numberOfPets: number | null;
  status: string;
  guestName: string | null;
  cancelledAt: string | null;
  bookedAt: string;
  createdAt: string;
};

export type HostexPage<T> = {
  items: T[];
  total: number;
  offset: number;
  limit: number;
};

export type HostexPropertiesQuery = {
  offset: number;
  limit: number;
  id?: number;
  groupId?: number;
  tagId?: number;
};

export type HostexReservationsQuery = {
  offset: number;
  limit: number;
  reservationCode?: string;
  channelId?: string;
  propertyId?: number;
  status?: HostexReservationStatus;
  startCheckInDate?: string;
  endCheckInDate?: string;
  startCheckOutDate?: string;
  endCheckOutDate?: string;
  orderBy?: HostexReservationOrderField;
  channelType?: HostexChannelType;
};
