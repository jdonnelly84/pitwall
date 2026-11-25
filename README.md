# Pit Wall

An F1 race-weekend app for Grandad's Huawei P30 Pro. It is a web app: installed from a link, it gets its own icon, opens full-screen and runs entirely on the phone. No computer needs to be on.

**What's in it**

- **Home**: this weekend's race with a countdown to the next session, every session time in the phone's own time zone, the track forecast, his favourite drivers, the last race's podium, the top of the championship and the latest news. During a session a red **LIVE** card appears at the top.
- **Schedule**: the whole season with each race's winner. Tap a race for the weekend schedule, the circuit map, last year's winner and results for every session: Practice 1–3, Sprint Qualifying, Sprint, Qualifying and the Race. Race results include positions gained, the fastest lap, tyre strategy, track conditions and race-control messages.
- **Live**: the running order and lap count during any session, refreshing every 10 seconds.
- **Standings**: drivers and teams. Tap a driver for their season race by race, or a team for both drivers' results.
- **News**: F1 stories from ESPN. They open in the browser.
- **Settings** (gear icon): text size (Large by default, Extra large available), light or dark look, and **My drivers** (star a driver to highlight them everywhere and show them on Home).

## Putting it on Grandad's phone

**The app's address: https://jdonnelly84.github.io/pitwall/** (GitHub Pages, free; code at https://github.com/jdonnelly84/pitwall)

1. On his phone, open **Chrome** and go to that address.
2. Tap the **⋮** menu (top right), then **Install app** (or **Add to Home screen**), then **Install**.
3. The red Pit Wall icon appears on his home screen. From then on he just taps it.

If he uses the Huawei **Browser** instead of Chrome, open the address there, tap the **⋮** menu → **Add to** → **Home screen**.

Text too small? Tap the gear icon → **Text size → Extra large**.

## Where the data comes from (all free, straight from the phone)

| What | Source |
|---|---|
| Calendar, session times, results, qualifying, sprints, standings | [Jolpica F1 API](https://github.com/jolpica/jolpica-f1) (the successor to Ergast) |
| Live running order and lap count, news | ESPN's public F1 feed |
| Practice times, tyre strategy, race control, track weather, driver photos and team colours | [OpenF1](https://openf1.org) |
| Circuit maps | MultiViewer |
| Weekend weather forecast | Open-Meteo |

**About "live" data.** Formula 1's own live-timing feed now needs a login, and OpenF1's real-time feed needs a paid account. So during a session Pit Wall shows ESPN's live running order and lap count, free and refreshing every 10 seconds. Full detail (lap times, gaps, tyres, pit stops, race control) appears on the race page about 30 minutes after each session ends, when OpenF1 releases it for free. The official result follows from Jolpica shortly after.

**Smoothness.** Everything the app loads is kept on the phone. Screens open instantly from the saved copy, refresh quietly in the background and only redraw when something changed. Requests to each service go out one at a time so the free services never block it. If the phone has no signal, the app shows its saved information and says so at the top.

## Changing the app

- `index.html`, `app.css`, `app.js`: the whole app (plain HTML, CSS and JavaScript, no build step). `sw.js` keeps it on the phone so it opens offline. `manifest.webmanifest` + `icons/` make it installable.
- Preview on this computer: `python serve.py`, then open http://localhost:8080 (narrow the window to phone width). The app keeps itself on the device, so after an edit reload twice, or use `python serve.py 8091` for a clean start.
- Test the live screen any time by replaying a past session: open `http://localhost:8080/?at=2026-11-22T05:05:00Z&demo=live#/live` (`at` sets the clock; `demo=live` treats that session as running).
- Publish a change: double-click `publish.bat`. Grandad's phone picks up the new version the next time he opens the app (it may take two launches).

Unofficial fan app, not associated with Formula 1, the FIA or any team.
