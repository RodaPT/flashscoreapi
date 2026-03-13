const { chromium } = require('playwright');  // Use Playwright's Chromium browser
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { JWT } = require('google-auth-library');

// Function to scrape match details
async function scrapeMatches(urls) {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    let matchInfoList = [];

    for (let url of urls) {
        console.log(`Fetching URL: ${url}`);
        await page.goto(url);

        // Wait for the main match table wrapper to load (ensures the page is ready)
        try {
            console.log('Waiting for main match table wrapper to load...');
            await page.waitForSelector('.container__livetable', { visible: true, timeout: 60000 });
            console.log('Main match table wrapper loaded successfully!');
        } catch (error) {
            console.error(`Error waiting for main match table wrapper on ${url}:`, error);
            continue;
        }

        // Use .event__match as the match row selector and extract team names from the correct structure
        const matches = await page.evaluate(() => {
            const matchElements = document.querySelectorAll('.event__match');
            const now = new Date();
            const currentYear = now.getFullYear();
            return Array.from(matchElements).map((match, idx) => {
                // Extract team names from .event__homeParticipant and .event__awayParticipant
                // Try several selectors and fallbacks to extract team names (site HTML can change)
                let team1 = match.querySelector('.event__homeParticipant .wcl-name_jjfMf')?.innerText.trim()
                    || match.querySelector('.event__homeParticipant [alt]')?.getAttribute('alt')?.trim()
                    || '';
                let team2 = match.querySelector('.event__awayParticipant .wcl-name_jjfMf')?.innerText.trim()
                    || match.querySelector('.event__awayParticipant [alt]')?.getAttribute('alt')?.trim()
                    || '';

                // Common alternative selectors
                if (!team1) {
                    team1 = match.querySelector('.event__participant--home .participant__name')?.innerText.trim()
                        || match.querySelector('.team--home .name')?.innerText.trim()
                        || '';
                }
                if (!team2) {
                    team2 = match.querySelector('.event__participant--away .participant__name')?.innerText.trim()
                        || match.querySelector('.team--away .name')?.innerText.trim()
                        || '';
                }

                // Final fallback: parse visible text lines and pick first two non-time lines
                if (!team1 || !team2) {
                    const text = match.innerText || '';
                    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
                    // filter out lines that look like times or dates (e.g., 16:00, 18:30, 12.08., 12.08.2025, or combined '12.08. 18:00')
                    const looksLikeDateOrTime = l => {
                        if (!l) return true;
                        // plain time
                        if (/\b\d{1,2}:\d{2}\b/.test(l)) return true;
                        // plain date like 12.08. or 12.08.2025
                        if (/\b\d{1,2}\.\d{1,2}\.?(\d{2,4})?\b/.test(l)) return true;
                        // combined date + time on same line (e.g., '18.10. 20:15')
                        if (/\b\d{1,2}\.\d{1,2}\.?(\d{2,4})?\b.*\b\d{1,2}:\d{2}\b/.test(l)) return true;
                        // status tokens
                        if (/^(AO|FT|HT|Postp|TBD)$/i.test(l)) return true;
                        return false;
                    };
                    const nonTimeLines = lines.filter(l => !looksLikeDateOrTime(l));
                    if (!team1 && nonTimeLines.length >= 1) team1 = nonTimeLines[0];
                    if (!team2 && nonTimeLines.length >= 2) team2 = nonTimeLines[1];
                    // As an extra try, some sites show "Team1 - Team2" on one line
                    if ((!team1 || !team2) && nonTimeLines.length === 1) {
                        const line = nonTimeLines[0];
                        if (line.includes('-')) {
                            const parts = line.split('-').map(p => p.trim());
                            if (!team1) team1 = parts[0] || team1;
                            if (!team2 && parts[1]) team2 = parts[1];
                        } else if (line.toLowerCase().includes(' vs ' ) || line.toLowerCase().includes(' v ')) {
                            const parts = line.split(/\s+v(?:s)?\s+/i).map(p => p.trim());
                            if (!team1) team1 = parts[0] || team1;
                            if (!team2 && parts[1]) team2 = parts[1];
                        }
                    }
                }

                // Extract match time from .event__time
                const matchTimeRaw = match.querySelector('.event__time')?.innerText.trim() || '';
                // Format: DD.MM. HH:MM or DD.MM.YYYY HH:MM
                let datetime = '';
                if (matchTimeRaw) {
                    const [date, time] = matchTimeRaw.split(' ');
                    if (date && time) {
                        const dateParts = date.split('.').filter(Boolean);
                        let day, month, year;
                        if (dateParts.length === 2) {
                            // Format: DD.MM.
                            [day, month] = dateParts;
                            year = currentYear;
                        } else if (dateParts.length === 3) {
                            // Format: DD.MM.YYYY
                            [day, month, year] = dateParts;
                        }
                        if (day && month && year) {
                            // Pad day and month if needed
                            const pad = n => n.toString().padStart(2, '0');
                            datetime = `${year}-${pad(month)}-${pad(day)}T${time}:00`;
                        }
                    }
                }

                // Extract match ID and construct match link
                const matchIdAttr = match.getAttribute('id');
                let matchId = matchIdAttr || `${team1}_vs_${team2}_${datetime}`;
                let matchLink = '';
                if (matchIdAttr && matchIdAttr.startsWith('g_1_')) {
                    const matchIdPart = matchIdAttr.replace('g_1_', '');
                    matchLink = `https://www.flashscore.pt/jogo/${matchIdPart}/`;
                }

                return {
                    matchId,
                    team1,
                    team2,
                    datetime,
                    matchLink,
                    matchTime: matchTimeRaw,
                };
            });
        });

        matchInfoList = matchInfoList.concat(matches);
        console.log(`Found ${matches.length} matches in this URL.`);
    }

    await browser.close();
    console.log('Browser closed');
    return matchInfoList;
}

// Function to load existing event IDs from file
function loadEventIds() {
    const filePath = path.join(__dirname, 'event_ids.json');
    if (fs.existsSync(filePath)) {
        console.log('Loading existing event IDs...');
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    console.log('No existing event IDs found, creating a new file.');
    return {};
}

// Function to load event metadata (missing counts etc.)
function loadEventMeta() {
    const filePath = path.join(__dirname, 'event_meta.json');
    if (fs.existsSync(filePath)) {
        console.log('Loading event metadata...');
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (e) {
            console.error('Error parsing event_meta.json, resetting metadata.', e);
            return {};
        }
    }
    console.log('No event metadata found, creating a new file.');
    return {};
}

// Function to save event metadata
function saveEventMeta(meta) {
    const filePath = path.join(__dirname, 'event_meta.json');
    console.log('Saving event metadata to file...');
    fs.writeFileSync(filePath, JSON.stringify(meta, null, 2), 'utf-8');
    console.log('Event metadata saved successfully.');
}

// Function to save event IDs to file
function saveEventIds(eventIds) {
    const filePath = path.join(__dirname, 'event_ids.json');
    console.log('Saving event IDs to file...');
    fs.writeFileSync(filePath, JSON.stringify(eventIds, null, 2), 'utf-8');
    console.log('Event IDs saved successfully.');
}

// Uncomment to delete all events
// Function to delete all events from Google Calendar
async function deleteAllEvents(service, calendarId) {
    const events = await service.events.list({
        calendarId: calendarId,
        maxResults: 2500,  // Adjust if you expect more than 2500 events
        singleEvents: true,
        orderBy: 'startTime',
    });

    for (const event of events.data.items) {
        try {
            console.log(`Deleting event with ID: ${event.id}`);
            await service.events.delete({
                calendarId: calendarId,
                eventId: event.id,
            });
            console.log(`Deleted event: ${event.id}`);
        } catch (error) {
            console.error(`Error deleting event: ${error}`);
        }
    }
}

// Function to add events to Google Calendar
async function addEventsToCalendar(upcomingMatches) {
    let eventIds = loadEventIds();
    const calendarId = '870d419d0d043e060fe24a8560fa7dbc119712122d907ad7867f8fd41d5beff2@group.calendar.google.com';

    // Initialize Google API client with service account credentials
    const auth = new JWT({
        keyFile: 'service-account.json',  // Path to your service account credentials
        scopes: ['https://www.googleapis.com/auth/calendar'],
    });

    const service = google.calendar({ version: 'v3', auth });

    // Build a map of matchLink to match for quick lookup
    const matchMap = new Map(upcomingMatches.map(m => [m.matchLink, m]));
    const now = new Date();

    // Load metadata and initialize missingCounts if needed
    const meta = loadEventMeta();
    meta.missingCounts = meta.missingCounts || {};
    const MISSING_THRESHOLD = 3; // number of consecutive runs a match must be missing before deletion

    // Update missingCounts for each tracked event and delete only when threshold reached
    for (const [matchLink, eventId] of Object.entries(eventIds)) {
        const match = matchMap.get(matchLink);

        // If we have a match and it has a datetime in the past, delete immediately
        if (match && match.datetime && !isNaN(new Date(match.datetime).getTime())) {
            const matchDate = new Date(match.datetime);
            if (matchDate < now) {
                try {
                    await service.events.delete({ calendarId, eventId });
                    console.log(`Deleted event (match in the past): ${eventId}`);
                } catch (error) {
                    console.error(`Error deleting event: ${error}`);
                }
                delete eventIds[matchLink];
                delete meta.missingCounts[matchLink];
                continue;
            }
        }

        if (!match) {
            // Increment missing count
            meta.missingCounts[matchLink] = (meta.missingCounts[matchLink] || 0) + 1;
            console.log(`Match ${matchLink} missing this run (count=${meta.missingCounts[matchLink]})`);
            if (meta.missingCounts[matchLink] >= MISSING_THRESHOLD) {
                // delete the event
                try {
                    await service.events.delete({ calendarId, eventId });
                    console.log(`Deleted event (missing ${MISSING_THRESHOLD} runs): ${eventId}`);
                } catch (error) {
                    console.error(`Error deleting event: ${error}`);
                }
                delete eventIds[matchLink];
                delete meta.missingCounts[matchLink];
            }
        } else {
            // match is present, reset missing count
            if (meta.missingCounts[matchLink]) {
                console.log(`Match ${matchLink} reappeared; resetting missing count.`);
                delete meta.missingCounts[matchLink];
            }
        }
    }

    // Save metadata after deletion phase
    saveEventMeta(meta);

    // Add or update events
    for (const match of upcomingMatches) {
        console.log(`Processing match: ${match.team1} vs ${match.team2} at ${match.datetime}`);
        console.log(`Match Link: ${match.matchLink}`);

        // Skip if datetime is invalid or empty
        if (!match.datetime || isNaN(new Date(match.datetime).getTime())) {
            console.warn(`Skipping match with invalid datetime: ${match.team1} vs ${match.team2} (${match.matchTime})`);
            continue;
        }

        const event = {
            summary: `${match.team1} vs ${match.team2}`,
            start: {
                dateTime: match.datetime,
                timeZone: 'Europe/Lisbon',
            },
            end: {
                dateTime: new Date(new Date(match.datetime).getTime() + 2 * 60 * 60 * 1000).toISOString(), // Assuming 2-hour duration
                timeZone: 'Europe/Lisbon',
            },
        };

        if (eventIds[match.matchLink]) {
            // Update existing event
            try {
                await service.events.update({
                    calendarId,
                    eventId: eventIds[match.matchLink],
                    requestBody: event,
                });
                console.log(`Updated event: ${eventIds[match.matchLink]}`);
            } catch (error) {
                console.error(`Error updating event: ${error}`);
            }
        } else {
            // Create new event
            try {
                const eventResult = await service.events.insert({
                    calendarId: calendarId,
                    requestBody: event,
                });
                eventIds[match.matchLink] = eventResult.data.id;
                console.log(`Created event: ${eventResult.data.id}`);
            } catch (error) {
                console.error(`Error creating event: ${error}`);
            }
        }
    }

    // Save the event IDs to prevent duplicates in future runs
    saveEventIds(eventIds);
    console.log(`Updated event_ids.json with ${Object.keys(eventIds).length} events.`);
}

// Main function to run the script
async function main() {
    const urls = [
        "https://www.flashscore.pt/equipa/sporting-cp/tljXuHBC/lista/",
        "https://www.flashscore.pt/equipa/leiria/AceEgPi5/lista/",
        "https://www.flashscore.pt/equipa/portugal/WvJrjFVN/lista/"
    ];

    console.log('Starting the scraping process...');
    const upcomingMatches = await scrapeMatches(urls);

    if (upcomingMatches.length === 0) {
        console.log('No upcoming matches found.');
        return;
    }

    console.log(`Found ${upcomingMatches.length} upcoming matches.`);

    // Add matches to Google Calendar
    await addEventsToCalendar(upcomingMatches);
}

main().catch(console.error);
