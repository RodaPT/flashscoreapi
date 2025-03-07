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

        // Wait for the match data to load
        try {
            console.log('Waiting for match data to load...');
            await page.waitForSelector('.event__match', { visible: true, timeout: 60000 }); // Waiting for match data to appear
            console.log('Match data loaded successfully!');
        } catch (error) {
            console.error(`Error waiting for selector on ${url}:`, error);
            continue;
        }

        const matches = await page.evaluate(() => {
            console.log('Evaluating page content...');
            const matchElements = document.querySelectorAll('.event__match');
            console.log(`Found ${matchElements.length} match elements on the page.`);
            return Array.from(matchElements).map(match => {
                // Extract match ID from the ID attribute of the div
                const matchId = match.id;

                // Extract team names
                const team1 = match.querySelector('.event__homeParticipant .wcl-name_3y6f5')?.innerText.trim() || '';
                const team2 = match.querySelector('.event__awayParticipant .wcl-name_3y6f5')?.innerText.trim() || '';

                // Extract match time (from the .event__time class)
                const matchTime = match.querySelector('.event__time')?.innerText.trim() || '';
                
                // Parse the datetime manually
                const [date, time] = matchTime.split(' ');  // Split date and time
                const [day, month] = date.split('.');  // Split day and month

                // Get the current year to construct the full date
                const currentYear = new Date().getFullYear();
                const matchDate = new Date(`${currentYear}-${month}-${day}T${time}:00`);

                const matchLink = match.querySelector('.eventRowLink')?.href || ''; // Extract match link

                console.log(`Scraping match: ${matchId}, ${team1} vs ${team2}, Date: ${matchTime}, Time: ${matchDate.toISOString()}`);

                return {
                    matchId,
                    team1,
                    team2,
                    datetime: matchDate.toISOString(),
                    matchLink,
                    matchTime,  // Adding the match time as well
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
    const eventIds = loadEventIds();
    const calendarId = '870d419d0d043e060fe24a8560fa7dbc119712122d907ad7867f8fd41d5beff2@group.calendar.google.com';

    // Initialize Google API client with service account credentials
    const auth = new JWT({
        keyFile: 'service-account.json',  // Path to your service account credentials
        scopes: ['https://www.googleapis.com/auth/calendar'],
    });

    const service = google.calendar({ version: 'v3', auth });

    // Uncomment to delete all events
    // Delete all existing events
    console.log('Deleting all existing events...');
    await deleteAllEvents(service, calendarId);

    // Add new events
    for (const match of upcomingMatches) {
        console.log(`Processing match: ${match.team1} vs ${match.team2} at ${match.datetime}`);
        console.log(`Match Link: ${match.matchLink}`);

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
