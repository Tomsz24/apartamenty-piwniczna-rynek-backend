const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');

const { ConfigService } = require('@nestjs/config');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const { HostexClient } = require('../dist/hostex/hostex.client');
const {
  ListHostexPropertiesQueryDto,
  ListHostexReservationsQueryDto,
} = require('../dist/hostex/hostex.dto');
const {
  sanitizeHostexProperties,
  sanitizeHostexReservations,
} = require('../dist/hostex/hostex.domain');

test('sanitizes Hostex properties and ignores unknown or sensitive-looking fields', () => {
  const page = sanitizeHostexProperties(
    {
      properties: [
        {
          id: 123,
          title: 'Apartament Rynek',
          address: 'Rynek 1',
          longitude: '20.0001',
          latitude: '49.0001',
          secret: 'do-not-return',
          channels: [
            {
              channel_type: 'booking.com',
              listing_id: 'room-rate-plan',
              currency: 'PLN',
              credentials: 'do-not-return',
            },
          ],
          groups: [{ id: 5, name: 'Piwniczna' }],
          tags: [{ id: 8, name: 'Rynek', color: '#FD587B' }],
        },
      ],
      total: 1,
    },
    0,
    20,
  );

  assert.deepEqual(page, {
    items: [
      {
        id: 123,
        title: 'Apartament Rynek',
        address: 'Rynek 1',
        longitude: '20.0001',
        latitude: '49.0001',
        channels: [
          { channelType: 'booking.com', listingId: 'room-rate-plan', currency: 'PLN' },
        ],
        groups: [{ id: 5, name: 'Piwniczna' }],
        tags: [{ id: 8, name: 'Rynek', color: '#FD587B' }],
      },
    ],
    total: 1,
    offset: 0,
    limit: 20,
  });
  assert.equal('secret' in page.items[0], false);
  assert.equal('credentials' in page.items[0].channels[0], false);
});

test('maps only the safe reservation summary required by the first read-only integration', () => {
  const page = sanitizeHostexReservations(
    {
      reservations: [
        {
          reservation_code: 'R-123',
          stay_code: 'S-123',
          property_id: 123,
          channel_id: 'BOOKING-456',
          channel_type: 'booking.com',
          listing_id: 'room-rate-plan',
          check_in_date: '2027-01-10',
          check_out_date: '2027-01-13',
          number_of_guests: 3,
          number_of_adults: 2,
          number_of_children: 1,
          number_of_infants: 0,
          number_of_pets: 0,
          status: 'accepted',
          guest_name: 'Gość testowy',
          guest_phone: '+48 000 000 000',
          guest_email: 'private@example.com',
          booked_at: '2026-08-01T12:00:00+00:00',
          created_at: '2026-08-14T12:00:00+00:00',
          cancelled_at: null,
          rates: { total_rate: { amount: 1200, currency: 'PLN' } },
        },
      ],
      total: 1,
    },
    0,
    20,
  );

  assert.equal(page.items[0].reservationCode, 'R-123');
  assert.equal(page.items[0].channelId, 'BOOKING-456');
  assert.equal(page.items[0].guestName, 'Gość testowy');
  assert.equal(page.items[0].numberOfChildren, 1);
  assert.equal('guestPhone' in page.items[0], false);
  assert.equal('guestEmail' in page.items[0], false);
  assert.equal('rates' in page.items[0], false);
});

test('validates Hostex list filters and pagination limits', async () => {
  const validProperties = plainToInstance(ListHostexPropertiesQueryDto, {
    offset: '0',
    limit: '100',
    id: '123',
  });
  const invalidProperties = plainToInstance(ListHostexPropertiesQueryDto, {
    limit: '101',
  });
  const validReservations = plainToInstance(ListHostexReservationsQueryDto, {
    propertyId: '123',
    status: 'accepted',
    startCheckInDate: '2027-01-01',
    channelType: 'booking.com',
  });
  const invalidReservations = plainToInstance(ListHostexReservationsQueryDto, {
    status: 'confirmed',
    startCheckInDate: '01-01-2027',
  });

  assert.equal((await validate(validProperties)).length, 0);
  assert.equal((await validate(invalidProperties)).length, 1);
  assert.equal((await validate(validReservations)).length, 0);
  assert.deepEqual(
    (await validate(invalidReservations)).map((error) => error.property).sort(),
    ['startCheckInDate', 'status'],
  );
});

test('keeps Hostex disabled and read-only by default', () => {
  const client = new HostexClient(
    new ConfigService({ HOSTEX_WRITES_ENABLED: 'true' }),
  );
  assert.deepEqual(client.getStatus(), {
    enabled: false,
    ready: false,
    mode: 'read_only',
    writesEnabled: false,
    accessTokenConfigured: false,
    apiBaseUrlConfigured: true,
  });
});

test('calls Hostex with its access-token header and snake_case filters', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url: new URL(String(url)), options };
    return new Response(
      JSON.stringify({
        request_id: 'RT-1',
        error_code: 200,
        error_msg: 'Done.',
        data: { reservations: [], total: 0 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };

  try {
    const client = new HostexClient(
      new ConfigService({
        HOSTEX_ENABLED: 'true',
        HOSTEX_ACCESS_TOKEN: 'read-only-token',
        HOSTEX_READ_RETRY_COUNT: '0',
      }),
    );
    const data = await client.getReservations({
      offset: 0,
      limit: 20,
      propertyId: 123,
      startCheckInDate: '2027-01-01',
      channelType: 'booking.com',
    });

    assert.deepEqual(data, { reservations: [], total: 0 });
    assert.equal(captured.url.pathname, '/v3/reservations');
    assert.equal(captured.url.searchParams.get('property_id'), '123');
    assert.equal(captured.url.searchParams.get('start_check_in_date'), '2027-01-01');
    assert.equal(captured.url.searchParams.get('channel_type'), 'booking.com');
    assert.equal(captured.options.method, 'GET');
    assert.equal(captured.options.headers['Hostex-Access-Token'], 'read-only-token');
    assert.equal(captured.options.headers['User-Agent'], 'ApartamentyPiwnicznaBackend/1.0');
  } finally {
    global.fetch = originalFetch;
  }
});

test('recognizes Hostex application errors even when HTTP status is 200', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify({
        request_id: 'RT-SUBSCRIPTION',
        error_code: 420,
        error_msg: 'Basic edition does not support this feature',
        data: {},
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );

  try {
    const client = new HostexClient(
      new ConfigService({
        HOSTEX_ENABLED: 'true',
        HOSTEX_ACCESS_TOKEN: 'read-only-token',
        HOSTEX_READ_RETRY_COUNT: '0',
      }),
    );
    await assert.rejects(
      client.getProperties({ offset: 0, limit: 20 }),
      /Plan lub stan konta Hostex nie pozwala użyć OpenAPI.*RT-SUBSCRIPTION/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('retries one transient Hostex read without duplicating any write', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    const payload =
      calls === 1
        ? { request_id: 'RT-FAIL', error_code: 503, error_msg: 'Temporary', data: {} }
        : {
            request_id: 'RT-OK',
            error_code: 0,
            error_msg: '',
            data: { properties: [], total: 0 },
          };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const client = new HostexClient(
      new ConfigService({
        HOSTEX_ENABLED: 'true',
        HOSTEX_ACCESS_TOKEN: 'read-only-token',
        HOSTEX_READ_RETRY_COUNT: '1',
        HOSTEX_RETRY_BASE_DELAY_MS: '1',
      }),
    );
    const data = await client.getProperties({ offset: 0, limit: 20 });
    assert.deepEqual(data, { properties: [], total: 0 });
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
  }
});
