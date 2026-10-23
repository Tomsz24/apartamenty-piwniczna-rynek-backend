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
  ListHostexConversationsQueryDto,
} = require('../dist/hostex/hostex.dto');
const {
  sanitizeHostexProperties,
  sanitizeHostexReservations,
  sanitizeHostexConversations,
  sanitizeHostexConversation,
} = require('../dist/hostex/hostex.domain');

test('sanitizes conversation list with stay context and drops unknown fields', () => {
  const page = sanitizeHostexConversations({ conversations: [{
    id: 'conv-1', channel_type: 'booking.com', last_message_at: '2026-10-20T10:00:00Z',
    guest: { name: 'Anna Kowalska', property_title: 'Widok na rynek', check_in_date: '2026-11-02', check_out_date: '2026-11-05' },
    last_message: { content: 'Dziękujemy', private_token: 'drop' }, unread_count: 2, api_secret: 'drop',
  }], total: 1 }, 0, 50);
  assert.deepEqual(page.items[0], {
    id: 'conv-1', channelType: 'booking.com', lastMessageAt: '2026-10-20T10:00:00Z',
    guestName: 'Anna Kowalska', propertyTitle: 'Widok na rynek', checkInDate: '2026-11-02',
    checkOutDate: '2026-11-05', reservationCode: null, lastMessage: 'Dziękujemy', unreadCount: 2,
  });
  assert.equal(page.total, 1);
});

test('sanitizes conversation history, direction and attachments', () => {
  const result = sanitizeHostexConversation({ conversation: {
    id: 'conv-2', guest_name: 'Gość', messages: [
      { id: 'm1', sender: 'guest', content: 'Dzień dobry', created_at: '2026-10-20T10:00:00Z' },
      { id: 'm2', sender_role: 'host', sender: { id: 'operator-1' }, content: 'Witamy', attachments: [{ url: 'https://example.test/map.jpg', token: 'drop' }] },
      { id: 'm3', sender_role: 'guest', content: 'Dziękuję' },
    ], raw: 'drop',
  } }, 'conv-2');
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[0].isOutgoing, false);
  assert.equal(result.messages[1].isOutgoing, true);
  assert.deepEqual(result.messages[1].attachments, ['https://example.test/map.jpg']);
  assert.equal(result.messages[2].isOutgoing, false);
  assert.equal('raw' in result, false);
});

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
          conversation_id: 'CONVERSATION-789',
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
          payment: { status: 'partially_received', amount_received: 300, currency: 'PLN' },
        },
      ],
      total: 1,
    },
    0,
    20,
  );

  assert.equal(page.items[0].reservationCode, 'R-123');
  assert.equal(page.items[0].channelId, 'BOOKING-456');
  assert.equal(page.items[0].conversationId, 'CONVERSATION-789');
  assert.equal(page.items[0].guestName, 'Gość testowy');
  assert.equal(page.items[0].numberOfChildren, 1);
  assert.equal(page.items[0].guestPhone, '+48 000 000 000');
  assert.equal(page.items[0].guestEmail, 'private@example.com');
  assert.equal(page.items[0].totalRateAmount, 1200);
  assert.equal(page.items[0].amountReceived, 300);
  assert.equal(page.items[0].currency, 'PLN');
  assert.equal(page.items[0].paymentStatus, 'partially_received');
  assert.equal('rates' in page.items[0], false);
});

test('sanitizes optional Hostex financial details without retaining the raw payment payload', () => {
  const page = sanitizeHostexReservations(
    {
      reservations: [{
        reservation_code: 'R-124',
        stay_code: 'S-124',
        property_id: 123,
        channel_type: 'hostex_direct',
        check_in_date: '2027-01-10',
        check_out_date: '2027-01-13',
        status: 'accepted',
        booked_at: '2026-08-01T12:00:00+00:00',
        created_at: '2026-08-14T12:00:00+00:00',
        rates: { total_rate: { amount: 'bad', currency: 'PLN' } },
        payment: { status: 'received', amount_received: -20, card_token: 'private-secret' },
      }],
    },
    0,
    20,
  );

  assert.equal(page.items[0].totalRateAmount, null);
  assert.equal(page.items[0].amountReceived, null);
  assert.equal(page.items[0].paymentStatus, 'received');
  assert.equal('card_token' in page.items[0], false);
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

  const validConversations = plainToInstance(ListHostexConversationsQueryDto, { offset: '10', limit: '100' });
  const invalidConversations = plainToInstance(ListHostexConversationsQueryDto, { offset: '-1', limit: '101' });
  assert.equal((await validate(validConversations)).length, 0);
  assert.deepEqual((await validate(invalidConversations)).map((error) => error.property).sort(), ['limit', 'offset']);
});

test('keeps Hostex disabled and read-only by default', () => {
  const client = new HostexClient(
    new ConfigService({ HOSTEX_WRITES_ENABLED: 'false' }),
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

test('refuses to send Hostex messages when writes are disabled', async () => {
  const client = new HostexClient(new ConfigService({
    HOSTEX_ENABLED: 'true',
    HOSTEX_WRITES_ENABLED: 'false',
    HOSTEX_ACCESS_TOKEN: 'read-only-token',
  }));
  await assert.rejects(client.sendMessage('conversation-1', 'Test'), /HOSTEX_WRITES_ENABLED=true/i);
});

test('writes Hostex manual reservations once with the app idempotency channel id', async () => {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url: new URL(String(url)), options };
    return new Response(JSON.stringify({ error_code: 200, error_msg: 'Done.', data: { reservation: {} } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const client = new HostexClient(new ConfigService({
      HOSTEX_ENABLED: 'true',
      HOSTEX_WRITES_ENABLED: 'true',
      HOSTEX_ACCESS_TOKEN: 'writable-token',
      HOSTEX_READ_RETRY_COUNT: '2',
    }));
    await client.createDirectReservation({
      property_id: 12761007,
      custom_channel_id: 5840,
      check_in_date: '2027-05-10',
      check_out_date: '2027-05-12',
      number_of_guests: 3,
      guest_name: 'Jan Kowalski',
      currency: 'PLN',
      rate_amount: 1200,
      commission_amount: 0,
      received_amount: 300,
      income_method_id: 197,
      channel_id: '1234567890abcdef1234567890abcdef',
    });

    assert.equal(captured.url.pathname, '/v3/reservations');
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.headers['Hostex-Access-Token'], 'writable-token');
    assert.deepEqual(JSON.parse(captured.options.body), {
      property_id: 12761007,
      custom_channel_id: 5840,
      check_in_date: '2027-05-10',
      check_out_date: '2027-05-12',
      number_of_guests: 3,
      guest_name: 'Jan Kowalski',
      currency: 'PLN',
      rate_amount: 1200,
      commission_amount: 0,
      received_amount: 300,
      income_method_id: 197,
      channel_id: '1234567890abcdef1234567890abcdef',
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('keeps all Hostex reservation writes disabled unless explicitly enabled', async () => {
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; throw new Error('unexpected network call'); };
  try {
    const client = new HostexClient(new ConfigService({
      HOSTEX_ENABLED: 'true',
      HOSTEX_WRITES_ENABLED: 'false',
      HOSTEX_ACCESS_TOKEN: 'read-only-token',
    }));
    await assert.rejects(client.createDirectReservation({
      property_id: 12761007,
      custom_channel_id: 5840,
      check_in_date: '2027-05-10',
      check_out_date: '2027-05-12',
      number_of_guests: 2,
      guest_name: 'Gość',
      currency: 'PLN',
      rate_amount: 1000,
      commission_amount: 0,
      received_amount: 0,
      income_method_id: 197,
      channel_id: '1234567890abcdef1234567890abcdef',
    }), /HOSTEX_WRITES_ENABLED=true/i);
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
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

test('calls Hostex statistics read endpoints with documented filters', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: new URL(String(url)), options });
    return new Response(JSON.stringify({ error_code: 200, data: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const client = new HostexClient(new ConfigService({
      HOSTEX_ENABLED: 'true',
      HOSTEX_ACCESS_TOKEN: 'read-only-token',
      HOSTEX_READ_RETRY_COUNT: '0',
    }));
    await client.getTransactions({ startDate: '2026-10-01', endDate: '2026-10-31', propertyId: 123, offset: 0, limit: 100 });
    await client.getAvailabilities({ propertyIds: [123, 456], startDate: '2026-10-01', endDate: '2026-10-31' });
    await client.getReviews({ propertyId: 123, startCheckOutDate: '2026-10-01', endCheckOutDate: '2026-10-31', offset: 0, limit: 100 });
    await client.getTasks({ startDate: '2026-10-01', endDate: '2026-10-31', propertyId: 123, offset: 0, limit: 100 });

    assert.deepEqual(requests.map(({ url }) => url.pathname), [
      '/v3/transactions', '/v3/availabilities', '/v3/reviews', '/v3/tasks',
    ]);
    assert.equal(requests[0].url.searchParams.get('property_id'), '123');
    assert.equal(requests[0].url.searchParams.get('start_date'), '2026-10-01');
    assert.equal(requests[1].url.searchParams.get('property_ids'), '123,456');
    assert.equal(requests[2].url.searchParams.get('start_check_out_date'), '2026-10-01');
    assert.equal(requests[3].url.searchParams.get('end_date'), '2026-10-31');
    assert.equal(requests.every(({ options }) => options.method === 'GET' && options.headers['Hostex-Access-Token'] === 'read-only-token'), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('loads Hostex conversations and conversation history from their read endpoints', async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url: new URL(url), options });
    const data = requests.length === 1
      ? { conversations: [], total: 0 }
      : { conversation: { id: 'conv-1', messages: [] } };
    return new Response(JSON.stringify({ error_code: 0, data }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const client = new HostexClient(new ConfigService({ HOSTEX_ENABLED: 'true', HOSTEX_ACCESS_TOKEN: 'token' }));
    assert.deepEqual(await client.getConversations(100, 50), { conversations: [], total: 0 });
    assert.deepEqual(await client.getConversation('conv 1'), { conversation: { id: 'conv-1', messages: [] } });
    assert.equal(requests[0].url.pathname, '/v3/conversations');
    assert.equal(requests[0].url.searchParams.get('offset'), '100');
    assert.equal(requests[0].url.searchParams.get('limit'), '50');
    assert.equal(requests[1].url.pathname, '/v3/conversations/conv%201');
    assert.equal(requests.every(({ options }) => options.method === 'GET'), true);
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

test('shows Hostex image messages (fullback_url) as attachments without the placeholder text', () => {
  const { sanitizeHostexConversation } = require('../dist/hostex/hostex.domain');
  const result = sanitizeHostexConversation({
    conversation: {
      id: 'c1',
      messages: [{
        id: 'm1', sender_role: 'host', display_type: 'FileAttachment', content: '[Image]',
        attachment: { origin_attachment_id: 'a1', type: 'image', fullback_url: 'https://oss.example.test/map.jpeg/xlarge' },
        created_at: '2026-10-23T08:00:16+00:00',
      }],
    },
  }, 'c1');
  assert.deepEqual(result.messages[0].attachments, ['https://oss.example.test/map.jpeg/xlarge']);
  assert.equal(result.messages[0].text, '');
  assert.equal(result.messages[0].isOutgoing, true);
});

test('returns the chat history oldest first even though Hostex sends newest first', () => {
  const { sanitizeHostexConversation } = require('../dist/hostex/hostex.domain');
  const result = sanitizeHostexConversation({ conversation: { id: 'c1', messages: [
    { id: 'new', sender_role: 'host', content: 'C', created_at: '2026-10-23T08:00:16+00:00' },
    { id: 'mid', sender_role: 'host', content: 'B', created_at: '2026-10-23T08:00:01+00:00' },
    { id: 'old', sender_role: 'guest', content: 'A', created_at: '2026-10-21T12:11:16+00:00' },
  ] } }, 'c1');
  assert.deepEqual(result.messages.map((message) => message.id), ['old', 'mid', 'new']);
});
