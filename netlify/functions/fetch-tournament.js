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
    console.log(`[TOURNAMENT] Tournament dates: ${currentTournament.start_date || currentTournament.date} to ${currentTournament.end_date || 'N/A'}`);

    // STEP 2: Get the field from betting odds endpoint
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
      course: currentTournament.course_name || currentTournament.course || getCourseForTournament(currentTournament.event_name),
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
        'Cache-Control': 'public, max-age=3600'
      },
      body: JSON.stringify(tournamentData)
    };

  } catch (error) {
    console.error('[TOURNAMENT] DataGolf fetch failed:', error.message);
    if (error.response) {
      console.error('[TOURNAMENT] API Response Status:', error.response.status);
      console.error('[TOURNAMENT] API Response Data:', JSON.stringify(error.response.data));
    }
    
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
 */
function findCurrentTournament(schedule, now) {
  const tournaments = Array.isArray(schedule) ? schedule : Object.values(schedule);
  
  console.log(`[TOURNAMENT] Analyzing ${tournaments.length} tournaments`);
  
  if (tournaments.length > 0) {
    console.log(`[TOURNAMENT] Sample tournament:`, JSON.stringify(tournaments[0], null, 2));
  }
  
  const parseDate = (dateStr) => {
    if (!dateStr) return null;
    
    try {
      let parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
      
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
  
  const validTournaments = tournaments.map(t => {
    const startDate = parseDate(t.date || t.start_date);
    // DataGolf doesn't provide end_date, so calculate it (tournaments are typically 4 days Thu-Sun)
    const endDate = startDate ? new Date(startDate.getTime() + 3 * 24 * 60 * 60 * 1000) : null;
    
    return {
      ...t,
      _startDate: startDate,
      _endDate: endDate,
      // Add calculated end_date to the object so it can be used later
      end_date: endDate ? endDate.toISOString().split('T')[0] : null
    };
  }).filter(t => t._startDate !== null);
  
  console.log(`[TOURNAMENT] ${validTournaments.length} tournaments with valid dates`);
  
  if (validTournaments.length === 0) {
    console.error('[TOURNAMENT] No tournaments with valid dates found');
    return null;
  }
  
  const sorted = validTournaments.sort((a, b) => a._startDate - b._startDate);
  
  // Strategy 1: Find tournament happening NOW
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
    if (tournament._startDate > now && tournament._startDate <= fourteenDaysFromNow) {
      console.log(`[TOURNAMENT] Found UPCOMING (within 14 days): ${tournament.event_name}`);
      console.log(`[TOURNAMENT] Starts: ${tournament._startDate.toISOString()}, Ends: ${tournament._endDate.toISOString()}`);
      return tournament;
    }
  }

  // Strategy 3: Find tournament that ended recently (within last 7 days)
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
    console.log(`[TOURNAMENT] Starts: ${nextTournament._startDate.toISOString()}, Ends: ${nextTournament._endDate.toISOString()}`);
    return nextTournament;
  }

  // Strategy 5: Fallback
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
    const endDate = tournament.end_date ? new Date(tournament.end_date) : (tournament._endDate || null);
    
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
 * Get course name for tournament
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
 */
function getHardcodedFallback(tour) {
  if (tour === 'pga') {
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
