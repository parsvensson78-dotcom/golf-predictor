const axios = require('axios');

/**
 * OPTIMIZED fetch-tournament.js
 * Fetches current tournament info and field from DataGolf API
 */
exports.handler = async (event, context) => {
  try {
    const tour = event.queryStringParameters?.tour || 'pga';
    console.log(`[TOURNAMENT] Fetching ${tour.toUpperCase()} tour tournament`);

    const apiKey = process.env.DATAGOLF_API_KEY || '07b56aee1a02854e9513b06af5cd';
    const apiTour = tour === 'dp' ? 'euro' : tour;
    
    return await fetchDataGolfTournament(apiTour, apiKey);

  } catch (error) {
    console.error('[TOURNAMENT] Error:', error.message);
    return createErrorResponse(error.message);
  }
};

/**
 * Fetch tournament data from DataGolf
 */
async function fetchDataGolfTournament(tour, apiKey) {
  try {
    console.log(`[TOURNAMENT] Fetching DataGolf data for tour: ${tour}`);
    
    // Fetch schedule and field in parallel
    const [schedule, field] = await Promise.all([
      fetchSchedule(tour, apiKey),
      fetchField(tour, apiKey)
    ]);

    const currentTournament = findCurrentTournament(schedule);
    
    if (!currentTournament) {
      console.log('[TOURNAMENT] No current tournament found, using fallback');
      return createSuccessResponse(getFallbackTournament(tour));
    }

    const tournamentData = buildTournamentData(currentTournament, field, tour);
    
    console.log(`[TOURNAMENT] ✅ ${tournamentData.name} (${tournamentData.fieldSize} players)`);
    
    return createSuccessResponse(tournamentData);

  } catch (error) {
    console.error('[TOURNAMENT] DataGolf fetch failed:', error.message);
    console.log('[TOURNAMENT] Using fallback data');
    return createSuccessResponse(getFallbackTournament(tour));
  }
}

/**
 * Fetch tournament schedule from DataGolf
 */
async function fetchSchedule(tour, apiKey) {
  const url = `https://feeds.datagolf.com/get-schedule?tour=${tour}&file_format=json&key=${apiKey}`;
  
  console.log(`[TOURNAMENT] Fetching schedule...`);
  
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Golf-Predictor-App/1.0',
      'Accept': 'application/json'
    }
  });

  if (!response.data?.schedule) {
    throw new Error('Invalid schedule response from DataGolf');
  }

  return Array.isArray(response.data.schedule) 
    ? response.data.schedule 
    : Object.values(response.data.schedule);
}

/**
 * Fetch field from betting odds endpoint
 */
async function fetchField(tour, apiKey) {
  const url = `https://feeds.datagolf.com/betting-tools/outrights?tour=${tour}&market=win&odds_format=american&file_format=json&key=${apiKey}`;
  
  console.log(`[TOURNAMENT] Fetching field...`);
  
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Golf-Predictor-App/1.0',
      'Accept': 'application/json'
    }
  });

  if (!response.data?.odds) {
    throw new Error('Invalid odds response from DataGolf');
  }

  return response.data.odds.map((player, index) => ({
    name: player.player_name,
    rank: index + 1,
    dg_id: player.dg_id || null
  }));
}

/**
 * Find current or upcoming tournament from schedule
 */
function findCurrentTournament(tournaments) {
  const now = new Date();
  console.log(`[TOURNAMENT] Analyzing ${tournaments.length} tournaments (${now.toISOString()})`);
  
  // Parse and enrich tournaments with dates
  const enrichedTournaments = tournaments
    .map(t => enrichTournamentWithDates(t))
    .filter(t => t.startDate)
    .sort((a, b) => a.startDate - b.startDate);

  if (enrichedTournaments.length === 0) {
    console.error('[TOURNAMENT] No tournaments with valid dates');
    return null;
  }

  // Strategy 1: Find tournament in progress (now between start and end dates)
  const inProgress = enrichedTournaments.find(t => 
    t.startDate <= now && t.endDate >= now
  );
  
  if (inProgress) {
    console.log(`[TOURNAMENT] ✅ IN PROGRESS: ${inProgress.event_name}`);
    return inProgress;
  }

  // Strategy 2: Find upcoming tournament (within next 14 days)
  const fourteenDaysLater = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  const upcoming = enrichedTournaments.find(t => 
    t.startDate > now && t.startDate <= fourteenDaysLater
  );
  
  if (upcoming) {
    console.log(`[TOURNAMENT] ✅ UPCOMING: ${upcoming.event_name} (${upcoming.start_date})`);
    return upcoming;
  }

  // Strategy 3: Find recently ended tournament (within last 7 days)
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const recentlyEnded = enrichedTournaments
    .reverse()
    .find(t => t.endDate >= sevenDaysAgo && t.endDate < now);
  
  if (recentlyEnded) {
    console.log(`[TOURNAMENT] ✅ RECENTLY ENDED: ${recentlyEnded.event_name}`);
    return recentlyEnded;
  }

  // Strategy 4: Next future tournament
  const nextFuture = enrichedTournaments.find(t => t.startDate > now);
  
  if (nextFuture) {
    console.log(`[TOURNAMENT] ✅ NEXT FUTURE: ${nextFuture.event_name}`);
    return nextFuture;
  }

  // Strategy 5: Fallback to most recent
  const mostRecent = enrichedTournaments[enrichedTournaments.length - 1];
  console.log(`[TOURNAMENT] ⚠️ FALLBACK: ${mostRecent.event_name}`);
  return mostRecent;
}

/**
 * Enrich tournament with parsed dates
 */
function enrichTournamentWithDates(tournament) {
  const startDate = parseDate(tournament.date || tournament.start_date);
  
  // Calculate end date (tournaments are typically 4 days: Thu-Sun)
  const endDate = startDate 
    ? new Date(startDate.getTime() + 3 * 24 * 60 * 60 * 1000) 
    : null;

  return {
    ...tournament,
    startDate,
    endDate,
    end_date: endDate ? endDate.toISOString().split('T')[0] : null
  };
}

/**
 * Parse date string safely
 */
function parseDate(dateStr) {
  if (!dateStr) return null;
  
  try {
    const parsed = new Date(dateStr);
    return isNaN(parsed.getTime()) ? null : parsed;
  } catch (error) {
    console.error(`[TOURNAMENT] Error parsing date "${dateStr}"`);
    return null;
  }
}

/**
 * Build complete tournament data object
 */
function buildTournamentData(tournament, field, apiTour) {
  return {
    name: tournament.event_name,
    course: tournament.course_name || tournament.course || getCourseForTournament(tournament.event_name),
    location: formatLocation(tournament),
    dates: formatDates(tournament),
    tour: apiTour === 'euro' ? 'dp' : apiTour,
    fieldSize: field.length,
    field,
    event_id: tournament.event_id || null,
    calendar_year: tournament.calendar_year || new Date().getFullYear()
  };
}

/**
 * Format tournament location
 */
function formatLocation(tournament) {
  if (tournament.location) return tournament.location;
  
  const parts = [];
  if (tournament.city) parts.push(tournament.city);
  
  if (tournament.country !== 'USA' && tournament.country) {
    parts.push(tournament.country);
  } else if (tournament.state) {
    parts.push(tournament.state);
  }
  
  return parts.length > 0 ? parts.join(', ') : 'Location TBD';
}

/**
 * Format tournament dates
 */
function formatDates(tournament) {
  try {
    const startDate = tournament.startDate || new Date(tournament.date || tournament.start_date);
    const endDate = tournament.endDate || (tournament.end_date ? new Date(tournament.end_date) : null);
    
    const options = { month: 'short', day: 'numeric' };
    const start = startDate.toLocaleDateString('en-US', options);
    
    if (endDate) {
      const end = endDate.toLocaleDateString('en-US', options);
      return `${start} - ${end}, ${startDate.getFullYear()}`;
    }
    
    return `${start}, ${startDate.getFullYear()}`;
  } catch (error) {
    return 'Dates TBD';
  }
}

/**
 * Get course name for tournament (fallback mapping)
 */
function getCourseForTournament(tournamentName) {
  const name = tournamentName.toLowerCase();
  
  const COURSE_MAP = {
    'pebble beach': 'Pebble Beach Golf Links, Spyglass Hill, Monterey Peninsula',
    'farmers': 'Torrey Pines (South Course)',
    'torrey pines': 'Torrey Pines (South Course)',
    'waste management': 'TPC Scottsdale (Stadium Course)',
    'phoenix': 'TPC Scottsdale (Stadium Course)',
    'genesis': 'Riviera Country Club',
    'american express': 'La Quinta Country Club, PGA West',
    'sony': 'Waialae Country Club',
    'players': 'TPC Sawgrass (Stadium Course)',
    'masters': 'Augusta National Golf Club',
    'memorial': 'Muirfield Village Golf Club',
    'arnold palmer': 'Bay Hill Club & Lodge',
    'heritage': 'Harbour Town Golf Links',
    'travelers': 'TPC River Highlands'
  };

  for (const [key, course] of Object.entries(COURSE_MAP)) {
    if (name.includes(key)) return course;
  }

  return 'Course TBD';
}

/**
 * Get fallback tournament data
 */
function getFallbackTournament(tour) {
  const FALLBACKS = {
    'pga': {
      name: 'Farmers Insurance Open',
      course: 'Torrey Pines (South Course)',
      location: 'San Diego, California',
      dates: 'Jan 29 - Feb 1, 2026',
      tour: 'pga',
      fieldSize: 156,
      field: generateBasicField(156)
    },
    'euro': {
      name: 'Ras Al Khaimah Championship',
      course: 'Al Hamra Golf Club',
      location: 'Ras Al Khaimah, UAE',
      dates: 'Jan 30 - Feb 2, 2026',
      tour: 'dp',
      fieldSize: 132,
      field: generateBasicField(132)
    }
  };

  return { ...FALLBACKS[tour] || FALLBACKS['pga'], fallback: true };
}

/**
 * Generate basic field for fallback
 */
function generateBasicField(count) {
  const TOP_PLAYERS = [
    'Scottie Scheffler', 'Rory McIlroy', 'Xander Schauffele', 
    'Ludvig Aberg', 'Collin Morikawa', 'Patrick Cantlay',
    'Viktor Hovland', 'Wyndham Clark', 'Tommy Fleetwood',
    'Hideki Matsuyama', 'Max Homa', 'Tony Finau',
    'Cameron Young', 'Sam Burns', 'Jordan Spieth',
    'Justin Thomas', 'Jason Day', 'Si Woo Kim',
    'Sahith Theegala', 'Russell Henley', 'Tom Kim',
    'Corey Conners', 'Adam Scott', 'Sungjae Im',
    'Brian Harman', 'Sepp Straka', 'Akshay Bhatia'
  ];

  return Array.from({ length: count }, (_, i) => ({
    name: TOP_PLAYERS[i] || `Player ${i + 1}`,
    rank: i + 1
  }));
}

/**
 * Create success response
 */
function createSuccessResponse(data) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600'
    },
    body: JSON.stringify(data)
  };
}

/**
 * Create error response
 */
function createErrorResponse(message) {
  return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      error: 'Failed to fetch tournament',
      message
    })
  };
}
