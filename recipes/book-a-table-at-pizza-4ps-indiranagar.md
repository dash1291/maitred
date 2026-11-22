Book a table at Pizza 4P's Indiranagar, Bangalore

How far this has got: the booking page can be walked in the browser and watched for a date to open. No booking has been completed by the assistant.

## The page

- Bookings run on TableCheck. The link takes the date and party size:
  https://www.tablecheck.com/en/pizza-4ps-in-indiranagar/reserve?date=2026-11-30&party_size=2
- It first shows a policy notice. Click "Confirm and continue".
- Then a form with the guests, the date, "Select a time" and "Find availability". Clicking "Select a time" lists the times as buttons, 11:00 AM to 9:30 PM in 15-minute steps.

## The venue's rules, from its own notice (read 2026-11-22)

- Reservations are taken up to one week ahead only.
- A new date opens daily at 10:00 AM, for the same weekday of the following week.
- A booking is held for 30 minutes past its time. Changes and cancellations need 24 hours' notice by phone or Instagram.
- The booking should be in the name of the person dining; they may check identity on arrival, and say bookings through unauthorized third parties may not be honored.

## Verified on 2026-11-22

- Sunday 29 Nov opened at 10:00 AM and was sold out by about 11:05 AM. Dates go within the hour.
- When the date in the link has nothing free, the page quietly switches to another date and lists that date's times. For 29 Nov and 30 Nov it showed "Thu Dec 31" with every time enabled. The times on screen are then not for the date asked for.
- When the date in the link does have tables, the form shows that date ("Sun Nov 29").
- One visit in three was slow to open the list of times; reading the page a second time worked.
- The date button opens a calendar whose days are named with the weekday, such as "Monday 30" and "Tuesday 1". Days that cannot be picked are disabled. The month arrows have no name. The link with the date in it avoids the calendar altogether.
- Because of the date switch, opening the link for a sold-out or unreleased date looks as if the link were ignored. It is not: the same link showed "Sun Nov 29" while 29 Nov still had tables.

## Watch that works

Steps:

1. open https://www.tablecheck.com/en/pizza-4ps-in-indiranagar/reserve?date={date}&party_size={pax}
2. click "Confirm and continue"
3. click "Select a time"

Rule: fail if no time buttons are listed; return nothing unless a control shows the wanted date in the page's own form ("Mon Nov 30"); otherwise return the enabled time buttons.

```js
const page = input.page;
const d = new Date(input.params.date + "T12:00:00Z");
const label = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getUTCDay()] + " " +
  ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()] + " " + d.getUTCDate();
const times = page.controls.filter((c) => c.kind === "button" && /^\d{1,2}:\d{2} [AP]M$/.test(c.name));
if (times.length === 0) throw new Error("the list of times did not open");
if (!page.controls.some((c) => c.name === label)) return [];
return times.filter((c) => !c.disabled).map((c) => ({ date: input.params.date, time: c.name }));
```

Params: `{ "date": "2026-11-30", "pax": 2 }`. Proof used on 2026-11-22: `{ "date": "2026-12-31", "pax": 2 }`, the date the page itself was offering. Check which date the page offers before reusing that proof.

## Not verified

- How the list of times looks for a date that is only partly booked: whether taken times are disabled or still clickable.
- The booking form. The person has seen it: after choosing a time the table is held for about five minutes while first name, last name, email and phone are entered, or a Facebook or Google account is used.
- Whether a deposit or payment is asked for.

## What did not work

- Calling TableCheck's endpoints directly. A guessed `availability_v5/grid` request answered "no data" for every date, including dates with tables, and a watch built on it missed the 22 Nov opening.
