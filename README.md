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

Edit `config.js` to customize:
- **urls**: Which Flashscore team pages to scrape
- **calendarId**: Your Google Calendar ID
- **selectors**: CSS selectors (if website HTML changes)
- **matchDurationHours**: How long to show events (default: 2 hours)
- **missingEventThreshold**: Delete events after N consecutive missing runs (default: 3)

Example:
```javascript
urls: [
    'https://www.flashscore.pt/equipa/sporting-cp/tljXuHBC/lista/',
    'https://www.flashscore.pt/equipa/leiria/AceEgPi5/lista/',
],
calendarId: 'your-calendar-id@group.calendar.google.com',
matchDurationHours: 2,
```

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
| `config.js` | **Centralized configuration** (URLs, calendar ID, selectors, thresholds) |
| `.env.example` | Template for environment variables (copy to `.env` for local use) |
| `event_ids.json` | Stores mapping of match link → Google Calendar event ID |
| `event_meta.json` | Tracks missing counts to avoid deleting on temporary scrape failures |
| `service-account.json` | Google service account credentials (keep private, auto-ignored) |

---

## 🔄 Recent Improvements (March 2026)

The script has been refactored for better reliability and maintainability:

### Configuration Management
- ✅ All hardcoded values moved to `config.js`
- ✅ Easy to update URLs, calendar ID, selectors without touching code
- ✅ Selector configuration separated for quick updates if HTML changes

### Error Handling & Robustness
- ✅ Browser guaranteed to close via try-finally (no hung processes)
- ✅ Per-URL error handling - one failure doesn't stop entire process
- ✅ Fallback selectors for inconsistent HTML across different team pages
- ✅ Debug logging to identify selector issues

### Performance & Reliability
- ✅ Migrated from blocking to async file I/O (`fs.writeFileSync` → `fs.promises`)
- ✅ Non-blocking operations improve performance
- ✅ Better error messages with context

### Code Quality
- ✅ Cleaner, modular code structure
- ✅ JSDoc comments for all functions
- ✅ Better logging with emoji indicators (✓ ⚠ ❌)
- ✅ Separated concerns (scraping, parsing, calendar sync)

---

## 🛡️ Security / Privacy Notes

- `service-account.json` contains private keys and must never be published.
- `event_ids.json` and `event_meta.json` only store IDs and counts, but are ignored from git anyway.

---

## ✅ Troubleshooting

### No matches found from some teams
- The script automatically tries fallback selectors if the primary fails.
- If still no matches:
  - Check console output for debug logs (shows selector match counts)
  - Flashscore may have changed their HTML structure
  - Update the selectors in `config.js` if needed

### Matches stop appearing
- The site HTML structure may have changed.
- Run the script manually and check the debug output.
- Inspect the page with browser DevTools to find new CSS selectors.
- Update `config.js` selectors section.

### Auth errors
- Ensure the service account is shared on the calendar with **make changes** access.
- Ensure `service-account.json` is valid and in the project root.
- Check that the calendar ID in `config.js` matches your actual calendar ID.
