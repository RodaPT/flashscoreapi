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
            return Array.from(matchElements).map(match => {
                // Extract team names from .event__homeParticipant and .event__awayParticipant
                const team1 = match.querySelector('.event__homeParticipant .wcl-name_jjfMf')?.innerText.trim()
                    || match.querySelector('.event__homeParticipant [alt]')?.getAttribute('alt')?.trim()
                    || '';
                const team2 = match.querySelector('.event__awayParticipant .wcl-name_jjfMf')?.innerText.trim()
                    || match.querySelector('.event__awayParticipant [alt]')?.getAttribute('alt')?.trim()
                    || '';

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

    // Remove events from calendar and eventIds that are no longer present or are in the past
    for (const [matchLink, eventId] of Object.entries(eventIds)) {
        const match = matchMap.get(matchLink);
        let shouldDelete = false;
        if (!match) {
            // Not present in new matches
            shouldDelete = true;
        } else if (match.datetime && !isNaN(new Date(match.datetime).getTime())) {
            // If match is in the past
            const matchDate = new Date(match.datetime);
            if (matchDate < now) {
                shouldDelete = true;
            }
        }
        if (shouldDelete) {
            try {
                await service.events.delete({ calendarId, eventId });
                console.log(`Deleted event (no longer present or in the past): ${eventId}`);
            } catch (error) {
                console.error(`Error deleting event: ${error}`);
            }
            delete eventIds[matchLink];
        }
    }

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
        "https://www.flashscore.pt/equipa/manchester-utd/ppjDR086/lista/",
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
