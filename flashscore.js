const { chromium } = require('playwright');
const { google } = require('googleapis');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
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
 * Build a stable key for event tracking when match link is missing
 */
function buildEventKey(match) {
    if (match.matchLink) return match.matchLink;

    const rawKey = [
        match.sourceUrl || '',
        match.matchId || '',
        match.team1 || '',
        match.team2 || '',
        match.datetime || '',
        match.matchTime || ''
    ].join('|');

    const digest = crypto.createHash('sha1').update(rawKey).digest('hex');
    return `fallback:${digest}`;
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

                // Some pages render rows after the main container is visible.
                try {
                    await page.waitForFunction(() => {
                        return document.querySelectorAll('.event__match, [class*="event__match"], [id^="g_"]').length > 0;
                    }, { timeout: 15000 });
                } catch (_) {
                    // Continue with parsing and rely on fallback extraction/debug info.
                }

                console.log('Match table loaded successfully!');
            } catch (error) {
                console.error(`Error loading ${url}:`, error.message);
                continue;
            }

            try {
                const matches = await page.evaluate(({ currentYear, matchSelector, homeTeamSelector, awayTeamSelector, homeTeamAltSelector, awayTeamAltSelector, timeSelector, sourceUrl }) => {
                    // Use multiple selectors because Flashscore frequently changes class names.
                    const rowSelectors = [
                        matchSelector,
                        '[class*="event__match"]',
                        '[id^="g_"]'
                    ];

                    const uniqueRows = new Map();
                    for (const selector of rowSelectors) {
                        const elements = document.querySelectorAll(selector);
                        for (const el of elements) {
                            const key = el.getAttribute('id') || el.innerText?.slice(0, 120) || `${selector}_${uniqueRows.size}`;
                            if (!uniqueRows.has(key)) {
                                uniqueRows.set(key, el);
                            }
                        }
                    }

                    const team1Selectors = [
                        homeTeamSelector,
                        homeTeamAltSelector,
                        '.event__participant--home .participant__name',
                        '.event__homeParticipant [class*="participant"]'
                    ];
                    const team2Selectors = [
                        awayTeamSelector,
                        awayTeamAltSelector,
                        '.event__participant--away .participant__name',
                        '.event__awayParticipant [class*="participant"]'
                    ];
                    const timeSelectors = [
                        timeSelector,
                        '[class*="event__time"]'
                    ];

                    const pickText = (root, selectors) => {
                        for (const selector of selectors) {
                            if (!selector) continue;
                            const text = root.querySelector(selector)?.innerText?.trim();
                            if (text) return text;
                        }
                        return '';
                    };

                    return Array.from(uniqueRows.values()).map(match => {
                        // Extract team names
                        let team1 = pickText(match, team1Selectors);
                        let team2 = pickText(match, team2Selectors);

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

                        const matchTimeRaw = pickText(match, timeSelectors);
                        const matchIdAttr = match.getAttribute('id');
                        const matchText = match.innerText || '';

                        return {
                            team1,
                            team2,
                            matchTimeRaw,
                            matchIdAttr,
                            matchText,
                            sourceUrl
                        };
                    });
                }, { 
                    currentYear: new Date().getFullYear(),
                    matchSelector: CONFIG.selectors.matchRow,
                    homeTeamSelector: CONFIG.selectors.teams.home,
                    awayTeamSelector: CONFIG.selectors.teams.away,
                    homeTeamAltSelector: CONFIG.selectors.teams.homeAlt,
                    awayTeamAltSelector: CONFIG.selectors.teams.awayAlt,
                    timeSelector: CONFIG.selectors.time,
                    sourceUrl: url
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
                    if (m.matchIdAttr && m.matchIdAttr.startsWith('g_')) {
                        const parts = m.matchIdAttr.split('_');
                        const matchIdPart = parts.length >= 3 ? parts.slice(2).join('_') : '';
                        if (matchIdPart) {
                            matchLink = `https://www.flashscore.pt/jogo/${matchIdPart}/`;
                        }
                    }

                    // Fallback: extract match id from text when present
                    if (!matchLink) {
                        const idFromText = (m.matchText || '').match(/\bg_\d+_([A-Za-z0-9]+)\b/);
                        if (idFromText?.[1]) {
                            matchLink = `https://www.flashscore.pt/jogo/${idFromText[1]}/`;
                        }
                    }

                    const matchId = m.matchIdAttr || `${m.team1}_vs_${m.team2}_${datetime}`;
                    const eventKey = buildEventKey({
                        matchLink,
                        sourceUrl: m.sourceUrl,
                        matchId,
                        team1: m.team1,
                        team2: m.team2,
                        datetime,
                        matchTime: m.matchTimeRaw
                    });

                    return {
                        matchId,
                        team1: m.team1,
                        team2: m.team2,
                        datetime,
                        matchLink,
                        matchTime: m.matchTimeRaw,
                        sourceUrl: m.sourceUrl,
                        eventKey
                    };
                });

                const filteredMatches = processedMatches.filter(m => m.team1 && m.team2);

                matchInfoList = matchInfoList.concat(filteredMatches);
                console.log(`✓ Found ${filteredMatches.length} matches`);
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
    const matchMap = new Map(upcomingMatches.map(m => [m.eventKey || buildEventKey(m), m]));
    const now = new Date();

    console.log('\n--- Managing existing events ---');

    // Check for missing events and manage deletion threshold
    for (const [eventKey, eventId] of Object.entries(eventIds)) {
        const match = matchMap.get(eventKey);

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
                delete eventIds[eventKey];
                delete meta.missingCounts[eventKey];
                continue;
            }
        }

        // Manage missing events
        if (!match) {
            meta.missingCounts[eventKey] = (meta.missingCounts[eventKey] || 0) + 1;
            console.log(`⚠ Match missing (count: ${meta.missingCounts[eventKey]}): ${eventKey}`);

            if (meta.missingCounts[eventKey] >= CONFIG.missingEventThreshold) {
                try {
                    await service.events.delete({ calendarId: CONFIG.calendarId, eventId });
                    console.log(`✓ Deleted missing event (${CONFIG.missingEventThreshold} runs): ${eventId}`);
                } catch (error) {
                    console.error(`Error deleting event: ${error.message}`);
                }
                delete eventIds[eventKey];
                delete meta.missingCounts[eventKey];
            }
        } else {
            // Reset missing count if match reappeared
            if (meta.missingCounts[eventKey]) {
                console.log(`✓ Match reappeared: ${eventKey}`);
                delete meta.missingCounts[eventKey];
            }
        }
    }

    await saveEventMeta(meta);

    console.log('\n--- Processing new/updated events ---');

    // Add or update events
    for (const match of upcomingMatches) {
        const eventKey = match.eventKey || buildEventKey(match);

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

        if (eventIds[eventKey]) {
            // Update existing event
            try {
                await service.events.update({
                    calendarId: CONFIG.calendarId,
                    eventId: eventIds[eventKey],
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
                eventIds[eventKey] = result.data.id;
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
