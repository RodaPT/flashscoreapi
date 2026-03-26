const { chromium } = require('playwright');
const { google } = require('googleapis');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { JWT } = require('google-auth-library');
const CONFIG = require('./config.js');

/**
 * Parse match time string (format: "DD.MM. HH:MM" or "DD.MM.YYYY HH:MM")
 */
function parseMatchDateTime(timeString, currentYear) {
    if (!timeString) return '';

    const [date, time] = timeString.split(' ');
    if (!date || !time) return '';

    const dateParts = date.split('.').filter(Boolean);
    let day, month, year;

    if (dateParts.length === 2) {
        [day, month] = dateParts;
        year = currentYear;
    } else if (dateParts.length === 3) {
        [day, month, year] = dateParts;
    }

    if (day && month && year) {
        const pad = n => n.toString().padStart(2, '0');
        return `${year}-${pad(month)}-${pad(day)}T${time}:00`;
    }

    return '';
}

/**
 * Scrape matches from provided URLs
 */
async function scrapeMatches(urls) {
    const browser = await chromium.launch(CONFIG.browser);

    try {
        const page = await browser.newPage();
        let matchInfoList = [];

        for (let url of urls) {
            console.log(`\nFetching URL: ${url}`);
            try {
                await page.goto(url, { timeout: CONFIG.browser.timeout });

                console.log('Waiting for match table to load...');
                await page.waitForSelector(CONFIG.selectors.mainTable, { 
                    visible: true, 
                    timeout: CONFIG.browser.timeout 
                });
                console.log('Match table loaded successfully!');
            } catch (error) {
                console.error(`Error loading ${url}:`, error.message);
                continue;
            }

            try {
                const matches = await page.evaluate(({ currentYear, matchSelector, homeTeamSelector, awayTeamSelector, timeSelector }) => {
                    // Try primary selector first, then fallback
                    let matchElements = document.querySelectorAll(matchSelector);
                    
                    if (matchElements.length === 0) {
                        // Try fallback selector (for pages with different HTML structure)
                        matchElements = document.querySelectorAll('[id^="g_1_"]');
                    }

                    return Array.from(matchElements).map(match => {
                        // Extract team names
                        let team1 = match.querySelector(homeTeamSelector)?.innerText.trim() || '';
                        let team2 = match.querySelector(awayTeamSelector)?.innerText.trim() || '';

                        // Fallback: parse innerText
                        if (!team1 || !team2) {
                            const text = match.innerText || '';
                            const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
                            const looksLikeDateOrTime = l => {
                                if (!l) return true;
                                if (/\b\d{1,2}:\d{2}\b/.test(l)) return true;
                                if (/\b\d{1,2}\.\d{1,2}\.?(\d{2,4})?\b/.test(l)) return true;
                                if (/^(AO|FT|HT|Postp|TBD)$/i.test(l)) return true;
                                return false;
                            };
                            const nonTimeLines = lines.filter(l => !looksLikeDateOrTime(l));
                            if (!team1 && nonTimeLines.length >= 1) team1 = nonTimeLines[0];
                            if (!team2 && nonTimeLines.length >= 2) team2 = nonTimeLines[1];
                        }

                        const matchTimeRaw = match.querySelector(timeSelector)?.innerText.trim() || '';
                        const matchIdAttr = match.getAttribute('id');
                        const matchText = match.innerText || '';

                        return {
                            team1,
                            team2,
                            matchTimeRaw,
                            matchIdAttr,
                            matchText
                        };
                    });
                }, { 
                    currentYear: new Date().getFullYear(),
                    matchSelector: CONFIG.selectors.matchRow,
                    homeTeamSelector: CONFIG.selectors.teams.home,
                    awayTeamSelector: CONFIG.selectors.teams.away,
                    timeSelector: CONFIG.selectors.time
                });

                // Debug logging if no matches found
                if (matches.length === 0) {
                    const debugInfo = await page.evaluate(() => {
                        return {
                            mainTableFound: !!document.querySelector('.container__livetable'),
                            matchRowCount: document.querySelectorAll('.event__match').length,
                            fallbackCount: document.querySelectorAll('[id^="g_1_"]').length,
                            allEventElements: document.querySelectorAll('[class*="event"]').length,
                        };
                    });
                    console.warn(`  Debug: mainTable=${debugInfo.mainTableFound}, .event__match=${debugInfo.matchRowCount}, [id^="g_1_"]=${debugInfo.fallbackCount}, total_events=${debugInfo.allEventElements}`);
                }

                // Process matches using helper functions
                const processedMatches = matches.map(m => {
                    const datetime = parseMatchDateTime(m.matchTimeRaw, new Date().getFullYear());
                    
                    let matchLink = '';
                    if (m.matchIdAttr && m.matchIdAttr.startsWith('g_1_')) {
                        const matchIdPart = m.matchIdAttr.replace('g_1_', '');
                        matchLink = `https://www.flashscore.pt/jogo/${matchIdPart}/`;
                    }

                    return {
                        matchId: m.matchIdAttr || `${m.team1}_vs_${m.team2}_${datetime}`,
                        team1: m.team1,
                        team2: m.team2,
                        datetime,
                        matchLink,
                        matchTime: m.matchTimeRaw
                    };
                });

                matchInfoList = matchInfoList.concat(processedMatches);
                console.log(`✓ Found ${processedMatches.length} matches`);
            } catch (error) {
                console.error(`Error parsing matches on ${url}:`, error.message);
                continue;
            }
        }

        return matchInfoList;
    } catch (error) {
        console.error('Fatal error during scraping:', error);
        throw error;
    } finally {
        await browser.close();
        console.log('Browser closed');
    }
}

/**
 * Load event IDs from file (async)
 */
async function loadEventIds() {
    try {
        const data = await fs.readFile(CONFIG.files.eventIds, 'utf-8');
        console.log('Loaded existing event IDs');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('No existing event IDs found, starting fresh');
            return {};
        }
        throw error;
    }
}

/**
 * Load event metadata (async)
 */
async function loadEventMeta() {
    try {
        const data = await fs.readFile(CONFIG.files.eventMeta, 'utf-8');
        console.log('Loaded event metadata');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('No event metadata found, creating new');
            return {};
        }
        console.error('Error parsing event metadata:', error.message);
        return {};
    }
}

/**
 * Save event IDs to file (async)
 */
async function saveEventIds(eventIds) {
    try {
        await fs.writeFile(CONFIG.files.eventIds, JSON.stringify(eventIds, null, 2), 'utf-8');
        console.log(`✓ Saved ${Object.keys(eventIds).length} event IDs`);
    } catch (error) {
        console.error('Error saving event IDs:', error.message);
        throw error;
    }
}

/**
 * Save event metadata (async)
 */
async function saveEventMeta(meta) {
    try {
        await fs.writeFile(CONFIG.files.eventMeta, JSON.stringify(meta, null, 2), 'utf-8');
        console.log('✓ Saved event metadata');
    } catch (error) {
        console.error('Error saving event metadata:', error.message);
        throw error;
    }
}

// Uncomment to delete all events from Google Calendar
async function deleteAllEvents(service, calendarId) {
    const events = await service.events.list({
        calendarId: calendarId,
        maxResults: 2500,
        singleEvents: true,
        orderBy: 'startTime',
    });

    for (const event of events.data.items) {
        try {
            console.log(`Deleting event: ${event.id}`);
            await service.events.delete({
                calendarId: calendarId,
                eventId: event.id,
            });
        } catch (error) {
            console.error(`Error deleting event ${event.id}:`, error.message);
        }
    }
}

/**
 * Add or update events in Google Calendar
 */
async function addEventsToCalendar(upcomingMatches) {
    let eventIds = await loadEventIds();
    const meta = await loadEventMeta();
    meta.missingCounts = meta.missingCounts || {};

    // Initialize Google Calendar service
    const auth = new JWT({
        keyFile: CONFIG.serviceAccountPath,
        scopes: ['https://www.googleapis.com/auth/calendar'],
    });

    const service = google.calendar({ version: 'v3', auth });

    // Build match map for quick lookup
    const matchMap = new Map(upcomingMatches.map(m => [m.matchLink, m]));
    const now = new Date();

    console.log('\n--- Managing existing events ---');

    // Check for missing events and manage deletion threshold
    for (const [matchLink, eventId] of Object.entries(eventIds)) {
        const match = matchMap.get(matchLink);

        // Delete if match date has passed
        if (match && match.datetime) {
            const matchDate = new Date(match.datetime);
            if (matchDate < now) {
                try {
                    await service.events.delete({ calendarId: CONFIG.calendarId, eventId });
                    console.log(`✓ Deleted past event: ${eventId}`);
                } catch (error) {
                    console.error(`Error deleting event: ${error.message}`);
                }
                delete eventIds[matchLink];
                delete meta.missingCounts[matchLink];
                continue;
            }
        }

        // Manage missing events
        if (!match) {
            meta.missingCounts[matchLink] = (meta.missingCounts[matchLink] || 0) + 1;
            console.log(`⚠ Match missing (count: ${meta.missingCounts[matchLink]}): ${matchLink}`);

            if (meta.missingCounts[matchLink] >= CONFIG.missingEventThreshold) {
                try {
                    await service.events.delete({ calendarId: CONFIG.calendarId, eventId });
                    console.log(`✓ Deleted missing event (${CONFIG.missingEventThreshold} runs): ${eventId}`);
                } catch (error) {
                    console.error(`Error deleting event: ${error.message}`);
                }
                delete eventIds[matchLink];
                delete meta.missingCounts[matchLink];
            }
        } else {
            // Reset missing count if match reappeared
            if (meta.missingCounts[matchLink]) {
                console.log(`✓ Match reappeared: ${matchLink}`);
                delete meta.missingCounts[matchLink];
            }
        }
    }

    await saveEventMeta(meta);

    console.log('\n--- Processing new/updated events ---');

    // Add or update events
    for (const match of upcomingMatches) {
        // Skip invalid datetimes
        if (!match.datetime || isNaN(new Date(match.datetime).getTime())) {
            console.warn(`⚠ Skipping invalid match: ${match.team1} vs ${match.team2} (${match.matchTime})`);
            continue;
        }

        const eventData = {
            summary: `${match.team1} vs ${match.team2}`,
            start: {
                dateTime: match.datetime,
                timeZone: CONFIG.calendar.timeZone,
            },
            end: {
                dateTime: new Date(
                    new Date(match.datetime).getTime() + CONFIG.matchDurationHours * 60 * 60 * 1000
                ).toISOString(),
                timeZone: CONFIG.calendar.timeZone,
            },
        };

        if (eventIds[match.matchLink]) {
            // Update existing event
            try {
                await service.events.update({
                    calendarId: CONFIG.calendarId,
                    eventId: eventIds[match.matchLink],
                    requestBody: eventData,
                });
                console.log(`✓ Updated: ${eventData.summary}`);
            } catch (error) {
                console.error(`Error updating event: ${error.message}`);
            }
        } else {
            // Create new event
            try {
                const result = await service.events.insert({
                    calendarId: CONFIG.calendarId,
                    requestBody: eventData,
                });
                eventIds[match.matchLink] = result.data.id;
                console.log(`✓ Created: ${eventData.summary}`);
            } catch (error) {
                console.error(`Error creating event: ${error.message}`);
            }
        }
    }

    await saveEventIds(eventIds);
    console.log(`\n✓ Sync complete. Total events: ${Object.keys(eventIds).length}`);
}

/**
 * Main function - orchestrate the entire process
 */
async function main() {
    try {
        console.log('='.repeat(60));
        console.log('Starting FlashScore Web Scraper');
        console.log('='.repeat(60));

        // Scrape matches
        console.log('\n--- Scraping FlashScore ---');
        const upcomingMatches = await scrapeMatches(CONFIG.urls);

        if (upcomingMatches.length === 0) {
            console.log('⚠ No matches found on any page');
            return;
        }

        console.log(`\n✓ Found ${upcomingMatches.length} total matches`);

        // Sync with calendar
        console.log('\n--- Syncing with Google Calendar ---');
        await addEventsToCalendar(upcomingMatches);

        console.log('\n' + '='.repeat(60));
        console.log('✓ FlashScore sync completed successfully');
        console.log('='.repeat(60));
    } catch (error) {
        console.error('\n❌ Fatal error:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Run main
main();
