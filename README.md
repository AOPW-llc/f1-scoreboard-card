# F1 Scoreboard Card

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)
[![Validate](https://github.com/AOPW-llc/f1-scoreboard-card/actions/workflows/validate.yml/badge.svg)](https://github.com/AOPW-llc/f1-scoreboard-card/actions/workflows/validate.yml)

A Home Assistant dashboard card for Formula 1. It shows one Grand Prix weekend
at a time, with a tab for every session: practice, sprint qualifying, the
sprint, qualifying and the race. The championship standings sit next to it.
The arrows (or a swipe) move through the season.

No integration, sensor or API key is needed. The card reads ESPN's public
scoreboard, session and standings feeds straight from the browser.

## Features

- **One Grand Prix per screen.** The header names the race and the round
  (`Mexico City GP · Round 19 of 23`), with the circuit, the weekend's dates and
  what's next (`Next: Qualifying · Sat 5:00 PM`) or what's live. Cancelled
  rounds are marked and not counted.
- **Opens on the right weekend.** The one that's on or finished in the last
  day and a half, otherwise the next one. **Current GP** brings you back.
- **Session tabs** with each session's day and start time in your time zone. The
  card picks the live session, otherwise the latest one with results.
- **Practice:** best lap, gap to the fastest driver, laps.
- **Qualifying and sprint qualifying:** Q1, Q2 and Q3 times with each driver's
  best in bold, the gap to pole, and lines where the knockouts fell.
- **Race and sprint:**
  - Position, places gained or lost from the grid (▲ / ▼), car number in the
    team's color, driver and team.
  - Race time for the winner, gap or laps down for everyone else, DNF / DSQ /
    DNS for drivers who didn't finish, and the fastest lap (**FL**).
  - Laps, pit stops and points once it's final.
- **Before the race,** the starting grid from qualifying.
- **Winner, pole sitter or fastest driver** at the top of each session.
- **Championship:** a **Drivers | Constructors** toggle. Drivers show their
  team color, points and gap to the leader. Constructors show their drivers.
  The card remembers which tab you picked.
- **Driver page.** Tap any driver for:
  - Headshot, car number, team, nationality, age and championship position.
  - Season totals: points, wins, podiums, points finishes, races started from
    P1, fastest laps, best finish, average grid and finish, starts and DNFs.
  - Every Grand Prix this season with grid, finish and points. Tap one to open
    that race.
- **Favorite driver.** Highlighted in every table, with a one-line summary
  for each session.
- **Fold sections.** Tap the **Results** or **Championship** heading to hide
  it. The browser remembers your choice.
- **Picks up where you left off.** Leave the dashboard and come back, and the
  card returns to the weekend, session and driver page you were on, for the
  rest of the day in that tab.
- **Live updates.** Refreshes every 30 seconds during a session (times and
  gaps once a minute) and every 5 minutes otherwise.

## Installation

### HACS (recommended)

1. In HACS, open the menu (⋮) → **Custom repositories**.
2. Add `https://github.com/AOPW-llc/f1-scoreboard-card` with category
   **Dashboard**.
3. Search for **F1 Scoreboard Card**, download it, and reload your browser.

### Manual

1. Download `f1-scoreboard-card.js` from the
   [latest release](https://github.com/AOPW-llc/f1-scoreboard-card/releases/latest).
2. Copy it to `/config/www/f1-scoreboard-card.js`.
3. Go to **Settings → Dashboards → ⋮ → Resources** and add
   `/local/f1-scoreboard-card.js` as a **JavaScript module**.

## Configuration

Add the card from the dashboard card picker (search "F1"). Everything can be
set in the visual editor. The card works best wide, for example in a
**Panel** view; below about 720px the standings move under the results.

```yaml
type: custom:f1-scoreboard-card
driver: HAM
show_standings: true
refresh_interval: 30
```

| Option | Default | Description |
|---|---|---|
| `driver` | none | Favorite driver, by name as ESPN writes it (`Lewis Hamilton`, `L. Hamilton`), three-letter code (`HAM`) or car number (`44`). |
| `show_standings` | `true` | Show the drivers' and constructors' championships. |
| `refresh_interval` | `30` | Seconds between refreshes during a session (10–300). |

## Notes

- Times are shown in your browser's time zone.
- The season schedule and every session's order come from one request, reloaded
  every half hour (and more often for the weekend that's on). Times and gaps
  are one request per driver, so during a session they update at most once a
  minute. A driver page makes two requests per race they've run, and is kept
  for 10 minutes.
- Qualifying and practice gaps are worked out from the lap times.
- A driver's points per Grand Prix on their page include the sprint.
- Results stay open to change for a few hours after a session (penalties), so
  the card keeps checking until then.
- ESPN's feeds are public but undocumented, and can change without notice.

## Disclaimer

This is an unofficial, fan-made card. It is not affiliated with, endorsed by or
sponsored by Formula 1, the FIA, any team or driver, or ESPN. F1, FORMULA 1 and
related marks are trademarks of Formula One Licensing B.V. Names and marks are
trademarks of their respective owners.

## License

[MIT](LICENSE)
