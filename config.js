module.exports = {
    // Google Calendar configuration
    calendarId: '870d419d0d043e060fe24a8560fa7dbc119712122d907ad7867f8fd41d5beff2@group.calendar.google.com',
    serviceAccountPath: process.env.SERVICE_ACCOUNT_PATH || './service-account.json',
    
    // URLs to scrape
    urls: [
        'https://www.flashscore.pt/equipa/sporting-cp/tljXuHBC/lista/',
        'https://www.flashscore.pt/equipa/leiria/AceEgPi5/lista/',
        'https://www.flashscore.pt/equipa/portugal/WvJrjFVN/lista/'
    ],
    
    // Event management
    matchDurationHours: 2,
    missingEventThreshold: 3, // Delete event if missing this many runs
    
    // Playwright configuration
    browser: {
        headless: true,
        timeout: 60000
    },
    
    // Selector configuration (easy to update if site changes)
    selectors: {
        mainTable: '.container__livetable',
        matchRow: '.event__match', // Fallback to [id^="g_1_"] in code if no matches
        teams: {
            home: '.event__homeParticipant .wcl-name_jjfMf',
            away: '.event__awayParticipant .wcl-name_jjfMf',
            homeAlt: '.event__participant--home .participant__name',
            awayAlt: '.event__participant--away .participant__name'
        },
        time: '.event__time'
    },
    
    // File paths for caching
    files: {
        eventIds: './event_ids.json',
        eventMeta: './event_meta.json'
    },
    
    // Calendar settings
    calendar: {
        timeZone: 'Europe/Lisbon'
    }
};
