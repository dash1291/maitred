Book a table at Guerilla Diner, Bangalore

How far this has got: the booking stack is known and can be watched. No booking has ever been attempted.

## Stack

- Bookings run on AirMenus. Booking page: https://bookings.airmenus.in/guerilladiner/order
- API base: https://apis.airmenus.in/api
- Short name `guerilladiner`, outlet id 1406.
- Outlet lookup: GET /restaurant/details/bookings/?rest_short_name=guerilladiner
- Day config: GET /reservations/config/1406/
- Seats left: GET /reservations/slot_group/remaining/paxs/?group_title=<title>&booking_dt=<yyyy-mm-ddTHH:mm:00>&outlet_id=1406

## Verified on 2026-11-21

- The day config lists every weekday with `is_open: false`. The page says "Reservations open every Tuesday at 8pm".
- `days_ahead` is 5, `skip_dates` is empty.
- Each day has one group of bench seats with hourly times from 17:00 to 22:00, 1 to 6 people per booking, INR 500 per person redeemable against the bill. The group title differs by day ("Bench Seats", "Bench seat", "Bench seats"), so take it from the config.
- The seats-left endpoint returns `{}` for Guerilla while bookings are closed.
- On another AirMenus venue that was open (Tokyo Diner, outlet 1372) the same endpoint returned seats left per time for the whole group, for example `{"19:00":2,"19:30":4,"total_pax_left":14}`, and `{}` for a day with nothing to offer.

## Not verified

- What the booking page and the endpoints show for Guerilla once bookings open. Nobody has observed an open window yet.
- The booking request itself. Earlier research reported POST /reservations/booking/ with a one-time code, reCAPTCHA Enterprise and Razorpay payment. None of that has been run.

## Watch rule

This is the older kind of watch: its rule fetches the API itself. It was started by hand and is still running. A new watch must walk the booking page in the browser, and that path has not been worked out for Guerilla, because the page shows nothing bookable while reservations are closed. The first open window is the chance to record it.

Params: `{ "outletId": 1406, "pax": 2, "dates": [], "times": [] }` (empty dates or times mean any). Host: `apis.airmenus.in`. Timezone: `Asia/Kolkata`.

The rule reports a time when its day is open and inside the booking window, the party size fits, and, where the seats-left endpoint gives numbers, enough seats are left. It makes one request per probe while everything is closed.

```js
const api = "https://apis.airmenus.in/api";
const want = input.params;
const cfg = await tools.get(`${api}/reservations/config/${want.outletId}/`);
const s = cfg.setting;
const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const out = [];
for (let i = 0; i <= s.days_ahead; i++) {
  const d = new Date(input.today + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + i);
  const date = d.toISOString().slice(0, 10);
  if (want.dates.length && !want.dates.includes(date)) continue;
  if ((s.skip_dates || []).includes(date)) continue;
  const day = s[names[d.getUTCDay()]];
  if (!day || !day.is_open) continue;
  for (const g of day.slot_groups || []) {
    const times = (g.available_times || []).filter(
      (t) => (!want.times.length || want.times.includes(t.time)) && want.pax >= t.min_pax && want.pax <= t.max_pax,
    );
    if (!times.length) continue;
    const q = `group_title=${encodeURIComponent(g.title)}&booking_dt=${date}T${times[0].time}:00&outlet_id=${want.outletId}`;
    const left = await tools.get(`${api}/reservations/slot_group/remaining/paxs/?${q}`);
    const known = Object.keys(left).length > 0;
    for (const t of times) {
      if (known && !((left[t.time] || 0) >= want.pax)) continue;
      out.push({ date, time: t.time, group: g.title, seatsLeft: known ? left[t.time] : "unknown" });
    }
  }
}
return out;
```
