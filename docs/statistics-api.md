# Statistics API

`GET /api/statistics/summary` returns the statistics dashboard for apartments mapped to Hostex. It uses the same Supabase administrator authentication as the other mobile API endpoints.

## Query parameters

- `from` and `to`: optional ISO calendar dates (`YYYY-MM-DD`). Supply both or neither. The period includes `from` and excludes `to`, so a calendar month is `?from=2026-10-01&to=2026-11-01`.
- If omitted, the endpoint uses the current month in `Europe/Warsaw`.
- `apartmentId`: optional UUID to restrict the response to one mapped apartment.
- The period may be at most 366 days.

## Response

The response is grouped for direct use by the iOS Statistics tab:

- `summary`: reservation/arrival/departure counts, guests, guest-nights, length of stay, booking lead time, occupancy, booked value for arrivals, and estimated room revenue / average daily rate by currency.
- `finances`: paid and outstanding Hostex income and expenses, plus paid net cash flow, separated by currency. `complete` and `unavailableApartments` indicate if Hostex transaction data could not be loaded for a property.
- `byApartment`: the summary metrics and transaction totals for each apartment.
- `byChannel`: confirmed stay counts, arrivals, estimated room revenue for nights in the selected period, and full booking value for stays arriving in that period, grouped by source.
- `byDate`: daily arrivals, departures, guests in house, estimated room revenue, paid income and costs, plus occupied/sellable apartment counts and occupancy percentage. This is suitable for charts.
- `incomeCategories` and `expenseCategories`: transaction totals grouped by Hostex item name, currency, and payment status.
- `reviews`: review count and average/minimum/maximum score per channel. Scores stay separated because channels can use different rating scales. `complete` and `unavailableApartments` identify read failures.
- `tasks`: task counts by status/type and non-cancelled task fees. `complete` and `unavailableApartments` identify read failures.
- `dataQuality`: notes on whether availability was complete and how room revenue is estimated.

All monetary totals are keyed by currency; clients should not combine different currencies. Hostex reservations expose the total stay rate, not a guaranteed actual daily split. The endpoint allocates that amount evenly across nights for period revenue and ADR estimates. For booked-value totals it counts the full rate of reservations arriving in the selected period. Actual received income and expenses come from Hostex's transaction ledger, if those entries are maintained there.

Occupancy uses Hostex daily availability to exclude nights blocked for reasons other than a confirmed reservation. If Hostex does not return full availability for the requested dates, `dataQuality.availabilityComplete` is false and the calculation uses all calendar nights as sellable capacity. Hostex availability history is limited to the previous year, so older periods may use this fallback.

## Hostex sources

The endpoint combines Hostex reservations, availability, transactions, reviews, and task data. Optional sources degrade independently: a transaction API failure marks financial data incomplete; missing availability, reviews, or tasks does not prevent the other statistics from loading. Review queries are split into windows under 180 days, as required by Hostex.

- [Reservations](https://api-doc.hostex.io/reference/query-reservations)
- [Availability](https://api-doc.hostex.io/reference/query-availabilities)
- [Income and expenses](https://api-doc.hostex.io/reference/query-transactions)
- [Reviews](https://api-doc.hostex.io/reference/query-reviews)
- [Tasks](https://api-doc.hostex.io/reference/query-tasks)

The endpoint makes live Hostex reads and is intended for opening the Statistics tab and explicit refresh, rather than frequent polling.
