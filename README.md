# Flashscore → Google Calendar Sync

This script scrapes match schedules from Flashscore and creates/updates Google Calendar events for upcoming matches.

It is designed to:
- scrape match data for configured teams (team pages on Flashscore)
- track existing calendar events via `event_ids.json`
- update existing events when the match time changes
- delete events when the match is removed or has passed (with a small safety delay)

---

## 📦 Requirements

- Node.js (latest LTS recommended)
- npm (or yarn)
- A Google Cloud project with the Google Calendar API enabled
- A Google Calendar you can edit (the script uses a service account)
- (Optional) A Raspberry Pi or similar always-on device is great for running this as a scheduled task

---

## 🔧 Setup

### 1) Install dependencies

From the project root:

```bash
npm install
```

### 2) Create a Google service account (Calendar API)

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create or select a project.
3. Enable the **Google Calendar API** for the project.
4. In **APIs & Services → Credentials**, create a **Service Account**.
5. Create and download a **JSON key** for the service account.
6. Save it in this repo as `service-account.json`.

> 🔒 Do **not** commit this file. It is already ignored by `.gitignore`.

### 3) Share a calendar with the service account

1. In Google Calendar, open the calendar you want to use.
2. Go to **Settings and sharing** → **Share with specific people**.
3. Add the service account email (found in `service-account.json`) and give **Make changes to events** permission.

### 4) Configure the script

- The calendar ID is hard-coded in `flashscore.js` (line with `calendarId = ...`).
- If you want a different calendar, replace that ID with yours.

### 5) Run the script

```bash
node flashscore.js
```

If you want to schedule it, add a cron job like this (every 4 hours):

```cron
0 */4 * * * cd /path/to/flashscoreapi && /usr/bin/node flashscore.js >> /path/to/flashscoreapi/cron.log 2>&1
```

---

## 🧠 What the script does

### Scrapes match data
- Visits a list of Flashscore team schedule pages.
- Finds match rows and extracts:
  - Team names (home/away)
  - Match time (when available)
  - A match-specific link (used as a unique ID)

### Creates/updates Google Calendar events
- Uses `event_ids.json` to track which matches already have events.
- If the match exists, it updates the event.
- If it's new, it creates an event.

### Deletes stale events (safely)
- When a match is no longer found, it tracks missing runs in `event_meta.json`.
- Only after a configurable number of consecutive misses (default: 3 runs) does it delete the calendar event.
- Past events are deleted immediately.

---

## 🧩 Files you should know

| File | Purpose |
|------|---------|
| `flashscore.js` | Main scraper + calendar sync script |
| `event_ids.json` | Stores mapping of match link → Google Calendar event ID |
| `event_meta.json` | Tracks missing counts to avoid deleting on temporary scrape failures |
| `service-account.json` | Google service account credentials (keep private) |

---

## 🛡️ Security / Privacy Notes

- `service-account.json` contains private keys and must never be published.
- `event_ids.json` and `event_meta.json` only store IDs and counts, but are ignored from git anyway.

---

## ✅ Troubleshooting

- If matches stop appearing:
  - The site HTML structure may have changed (re-run the script and inspect logs).
  - Matches without times won’t create calendar events until a time appears.

- If the script fails with auth errors:
  - Ensure the service account is shared on the calendar with edit access.
  - Ensure `service-account.json` is valid and in the project root.
