const axios = require('axios');

/**
 * Fetch tournament information and field from DataGolf API
 * This ensures the field matches exactly with players who have betting odds
 */
exports.handler = async (event, context) => {
  try {
    const tour = event.queryStringParameters?.tour || 'pga';
    
    console.log(`[TOURNAMENT] Fetching ${tour.toUpperCase()} tour tournament from DataGolf`);

    // DataGolf API key
    const DATAGOLF_API_KEY = process.env.DATAGOLF_API_KEY || '07b56aee1a02854e9513b06af5cd';

    if (tour === 'pga') {
      return await fetchDataGolfTournament('pga', DATAGOLF_API_KEY);
    } else if (tour === 'dp') {
      return await fetchDataGolfTournament('euro', DATAGOLF_API_KEY);
    } else {
      throw new Error('Invalid tour specified');
    }

  } catch (error) {
    console.error('[TOURNAMENT] Error:', error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to fetch tournament',
        message: error.message
      })
    };
  }
};

/**
 * Fetch tournament data from DataGolf
 */
async function fetchDataGolfTournament(tour, apiKey) {
  try {
    console.log(`[TOURNAMENT] Fetching from DataGolf API for tour: ${tour}`);
    
    // STEP 1: Get current tournament schedule
    // According to DataGolf docs: https://datagolf.com/api-access
    // Endpoint: get-schedule
    // Returns: { schedule: [ { event_id, event_name, date, end_date, course_name, ... } ] }
    const scheduleUrl = `https://feeds.datagolf.com/get-schedule?tour=${tour}&file_format=json&key=${apiKey}`;
    
    console.log(`[TOURNAMENT] Fetching schedule...`);
    const scheduleResponse = await axios.get(scheduleUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Golf-Predictor-App/1.0',
        'Accept': 'application/json'
      }
    });

    if (!scheduleResponse.data || !scheduleResponse.data.schedule) {
      throw new Error('Invalid schedule response from DataGolf');
    }

    // Find current or upcoming tournament
    const now = new Date();
    console.log(`[TOURNAMENT] Current date/time: ${now.toISOString()}`);
    
    const currentTournament = findCurrentTournament(scheduleResponse.data.schedule, now);
    
    if (!currentTournament) {
      console.error('[TOURNAMENT] No current tournament found in schedule');
      throw new Error('No current tournament found');
    }

    console.log(`[TOURNAMENT] Selected: ${currentTournament.event_name}`);
    console.log(`[TOURNAMENT] Tournament dates: ${currentTournament.date || currentTournament.start_date} to ${currentTournament.end_date || 'N/A'}`);

    // STEP 2: Get the field from betting odds endpoint
    // This ensures we only get players with actual betting odds
    const oddsUrl = `https://feeds.datagolf.com/betting-tools/outrights?tour=${tour}&market=win&odds_format=american&file_format=json&key=${apiKey}`;
    
    console.log(`[TOURNAMENT] Fetching field from betting odds...`);
    const oddsResponse = await axios.get(oddsUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Golf-Predictor-App/1.0',
        'Accept': 'application/json'
      }
    });

    if (!oddsResponse.data || !oddsResponse.data.odds) {
      throw new Error('Invalid odds response from DataGolf');
    }

    // Build field from players with odds
    const field = oddsResponse.data.odds.map((player, index) => ({
      name: player.player_name,
      rank: index + 1,
      dg_id: player.dg_id || null
    }));

    console.log(`[TOURNAMENT] Field size: ${field.length} players with betting odds`);

    // STEP 3: Build complete tournament data
    const tournamentData = {
      name: currentTournament.event_name,
      course: currentTournament.course_name || getCourseForTournament(currentTournament.event_name),
      location: formatLocation(currentTournament),
      dates: formatDates(currentTournament),
      tour: tour === 'euro' ? 'dp' : tour,
      fieldSize: field.length,
      field: field,
      event_id: currentTournament.event_id || null,
      calendar_year: currentTournament.calendar_year || new Date().getFullYear()
    };

    console.log(`[TOURNAMENT] ${tournamentData.tour.toUpperCase()}: ${tournamentData.name}`);
    console.log(`[TOURNAMENT] Course: ${tournamentData.course}`);
    console.log(`[TOURNAMENT] Field: ${tournamentData.fieldSize} players`);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600' // Cache for 1 hour
      },
      body: JSON.stringify(tournamentData)
    };

  } catch (error) {
    console.error('[TOURNAMENT] DataGolf fetch failed:', error.message);
    if (error.response) {
      console.error('[TOURNAMENT] API Response Status:', error.response.status);
      console.error('[TOURNAMENT] API Response Data:', JSON.stringify(error.response.data));
    }
    
    // Fallback to hardcoded tournament if API fails
    console.log('[TOURNAMENT] Using fallback hardcoded tournament');
    const fallback = getHardcodedFallback(tour);
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(fallback)
    };
  }
}

/**
 * Find current or upcoming tournament from schedule
 * Improved logic to handle DataGolf's schedule format
 */
function findCurrentTournament(schedule, now) {
  // Convert schedule to array if needed
  const tournaments = Array.isArray(schedule) ? schedule : Object.values(schedule);
  
  console.log(`[TOURNAMENT] Analyzing ${tournaments.length} tournaments`);
  
  // DEBUG: Log first tournament to see date format
  if (tournaments.length > 0) {
    console.log(`[TOURNAMENT] Sample tournament:`, JSON.stringify(tournaments[0], null, 2));
  }
  
  // Parse dates more robustly - DataGolf might use various formats
  const parseDate = (dateStr) => {
    if (!dateStr) return null;
    
    try {
      // Try direct parsing first
      let parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
      
      // Try YYYY-MM-DD format
      if (typeof dateStr === 'string' && dateStr.includes('-')) {
        const parts = dateStr.split('-');
        if (parts.length === 3) {
          parsed = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
          if (!isNaN(parsed.getTime())) {
            return parsed;
          }
        }
      }
      
      return null;
    } catch (e) {
      console.error(`[TOURNAMENT] Error parsing date "${dateStr}":`, e.message);
      return null;
    }
  };
  
  // Filter and parse tournaments with valid dates
  const validTournaments = tournaments.map(t => {
    const startDate = parseDate(t.date || t.start_date);
    const endDate = parseDate(t.end_date) || (startDate ? new Date(startDate.getTime() + 4 * 24 * 60 * 60 * 1000) : null);
    
    return {
      ...t,
      _startDate: startDate,
      _endDate: endDate
    };
  }).filter(t => t._startDate !== null);
  
  console.log(`[TOURNAMENT] ${validTournaments.length} tournaments with valid dates`);
  
  if (validTournaments.length === 0) {
    console.error('[TOURNAMENT] No tournaments with valid dates found');
    return null;
  }
  
  // Sort by start date
  const sorted = validTournaments.sort((a, b) => {
    return a._startDate - b._startDate;
  });
  
  // Strategy 1: Find tournament happening NOW (started but not ended)
  for (const tournament of sorted) {
    if (tournament._startDate <= now && tournament._endDate >= now) {
      console.log(`[TOURNAMENT] Found IN PROGRESS: ${tournament.event_name}`);
      console.log(`[TOURNAMENT] Start: ${tournament._startDate.toISOString()}, End: ${tournament._endDate.toISOString()}`);
      return tournament;
    }
  }

  // Strategy 2: Find next upcoming tournament (within next 14 days)
  const fourteenDaysFromNow = new Date(now);
  fourteenDaysFromNow.setDate(fourteenDaysFromNow.getDate() + 14);
  
  for (const tournament of sorted) {
    // Tournament starts in the future but within 14 days
    if (tournament._startDate > now && tournament._startDate <= fourteenDaysFromNow) {
      console.log(`[TOURNAMENT] Found UPCOMING (within 14 days): ${tournament.event_name}`);
      console.log(`[TOURNAMENT] Starts: ${tournament._startDate.toISOString()}`);
      return tournament;
    }
  }

  // Strategy 3: Find tournament that ended recently (within last 7 days)
  // This is for post-tournament but pre-next-tournament period
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  
  for (let i = sorted.length - 1; i >= 0; i--) {
    const tournament = sorted[i];
    if (tournament._endDate >= sevenDaysAgo && tournament._endDate < now) {
      console.log(`[TOURNAMENT] Found RECENTLY ENDED: ${tournament.event_name}`);
      console.log(`[TOURNAMENT] Ended: ${tournament._endDate.toISOString()}`);
      return tournament;
    }
  }

  // Strategy 4: Just get the next tournament in the future
  const nextTournament = sorted.find(t => t._startDate > now);
  
  if (nextTournament) {
    console.log(`[TOURNAMENT] Found NEXT FUTURE: ${nextTournament.event_name}`);
    console.log(`[TOURNAMENT] Starts: ${nextTournament._startDate.toISOString()}`);
    return nextTournament;
  }

  // Strategy 5: Fallback - return last tournament in sorted list (most recent)
  const lastTournament = sorted[sorted.length - 1];
  console.log(`[TOURNAMENT] Using FALLBACK (most recent): ${lastTournament?.event_name || 'None'}`);
  if (lastTournament) {
    console.log(`[TOURNAMENT] Dates: ${lastTournament._startDate.toISOString()} - ${lastTournament._endDate.toISOString()}`);
  }
  return lastTournament;
}

/**
 * Format tournament location
 */
function formatLocation(tournament) {
  if (tournament.location) {
    return tournament.location;
  }
  
  const parts = [];
  if (tournament.city) parts.push(tournament.city);
  if (tournament.country && tournament.country !== 'USA') {
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
    const startDate = new Date(tournament.date || tournament.start_date || tournament._startDate);
    const endDate = tournament._endDate || (tournament.end_date ? new Date(tournament.end_date) : null);
    
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
 * Get course name for tournament (fallback if not in API response)
 */
function getCourseForTournament(tournamentName) {
  const name = tournamentName.toLowerCase();
  
  const courseMap = {
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
    'pga championship': 'Various',
    'us open': 'Various',
    'open championship': 'Various',
    'the open': 'Various',
    'memorial': 'Muirfield Village Golf Club',
    'arnold palmer': 'Bay Hill Club & Lodge',
    'heritage': 'Harbour Town Golf Links',
    'travelers': 'TPC River Highlands',
    'scottish open': 'Various'
  };

  for (const [key, course] of Object.entries(courseMap)) {
    if (name.includes(key)) {
      return course;
    }
  }

  return 'Course TBD';
}

/**
 * Hardcoded fallback if DataGolf API fails
 * Updated for late January 2026
 */
function getHardcodedFallback(tour) {
  const now = new Date();
  const month = now.getMonth(); // 0 = January
  const day = now.getDate();

  if (tour === 'pga') {
    // January 29 - February 1, 2026: Farmers Insurance Open
    // This is the current tournament as of Jan 27
    return {
      name: 'Farmers Insurance Open',
      course: 'Torrey Pines (South Course)',
      location: 'San Diego, California',
      dates: 'Jan 29 - Feb 1, 2026',
      tour: 'pga',
      fieldSize: 156,
      field: generateBasicField(156),
      fallback: true
    };
  } else if (tour === 'euro') {
    return {
      name: 'Ras Al Khaimah Championship',
      course: 'Al Hamra Golf Club',
      location: 'Ras Al Khaimah, UAE',
      dates: 'Jan 30 - Feb 2, 2026',
      tour: 'dp',
      fieldSize: 132,
      field: generateBasicField(132),
      fallback: true
    };
  }

  // Default fallback
  return {
    name: 'Farmers Insurance Open',
    course: 'Torrey Pines (South Course)',
    location: 'San Diego, California',
    dates: 'Jan 29 - Feb 1, 2026',
    tour: 'pga',
    fieldSize: 156,
    field: generateBasicField(156),
    fallback: true
  };
}

/**
 * Generate basic field for fallback
 */
function generateBasicField(count) {
  const topPlayers = [
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

  const field = [];
  
  for (let i = 0; i < Math.min(topPlayers.length, count); i++) {
    field.push({
      name: topPlayers[i],
      rank: i + 1
    });
  }

  for (let i = topPlayers.length; i < count; i++) {
    field.push({
      name: `Player ${i + 1}`,
      rank: i + 1
    });
  }

  return field;
}
