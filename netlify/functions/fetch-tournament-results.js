const axios = require('axios');

/**
 * Fetch tournament results from DataGolf API
 * FIXES:
 * - Better tournament name matching (not just first word)
 * - Uses historical-raw-data endpoint for completed tournaments
 * - Handles event_completed as boolean/string/number
 * - field-updates only returns CURRENT tournament, so we use historical data instead
 */
exports.handler = async (event, context) => {
  try {
    const { tournamentName, tour, eventId } = JSON.parse(event.body || '{}');

    if (!tournamentName) {
      return createErrorResponse('Tournament name required', 400);
    }

    console.log(`[RESULTS] Fetching results for: "${tournamentName}" (tour: ${tour}, eventId: ${eventId})`);

    const apiKey = process.env.DATAGOLF_API_KEY || '07b56aee1a02854e9513b06af5cd';
    const apiTour = tour === 'dp' ? 'euro' : (tour || 'pga');

    // Step 1: Find the tournament in the schedule
    const tournamentInfo = await findTournamentInSchedule(apiTour, tournamentName, eventId, apiKey);
    
    if (!tournamentInfo) {
      console.log(`[RESULTS] Tournament "${tournamentName}" not found in schedule`);
      return createSuccessResponse({
        status: 'not_found',
        message: `Tournament "${tournamentName}" not found in schedule`,
        results: []
      });
    }

    console.log(`[RESULTS] Found: "${tournamentInfo.event_name}" (completed: ${tournamentInfo.event_completed}, winner: ${tournamentInfo.winner || 'N/A'})`);

    // Step 2: Check if tournament is completed
    const winner = tournamentInfo.winner;
    const hasRealWinner = winner && winner !== 'TBD' && winner !== 'tbd' && winner !== '';
    
    const isCompleted = tournamentInfo.event_completed === true || 
                        tournamentInfo.event_completed === 'yes' || 
                        tournamentInfo.event_completed === 1 ||
                        hasRealWinner;

    if (!isCompleted) {
      console.log('[RESULTS] Tournament not yet completed');
      return createSuccessResponse({
        status: 'not_completed',
        message: 'Tournament results not available yet',
        results: []
      });
    }

    // Step 3: Fetch detailed results
    let results = [];

    // Try historical raw data endpoint (works for completed events)
    results = await fetchHistoricalResults(apiTour, tournamentInfo, apiKey);

    // Last fallback: return just the winner from schedule
    if (results.length === 0 && hasRealWinner) {
      console.log('[RESULTS] Using winner-only fallback');
      results = [{
        player: tournamentInfo.winner,
        position: 1,
        score: 'N/A',
        toPar: tournamentInfo.winning_score ? 
          `${tournamentInfo.winning_score > 0 ? '+' : ''}${tournamentInfo.winning_score}` : 'N/A'
      }];
    }

    console.log(`[RESULTS] ✅ Returning ${results.length} results for "${tournamentInfo.event_name}"`);

    return createSuccessResponse({
      status: results.length > 0 ? 'completed' : 'not_completed',
      tournamentName: tournamentInfo.event_name,
      results,
      fetchedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('[RESULTS] Error:', error.message);
    return createErrorResponse(error.message);
  }
};

/**
 * Find tournament in DataGolf schedule with improved name matching
 */
async function findTournamentInSchedule(tour, tournamentName, eventId, apiKey) {
  const url = `https://feeds.datagolf.com/get-schedule?tour=${tour}&file_format=json&key=${apiKey}`;
  
  try {
    const response = await axios.get(url, { timeout: 15000 });
    
    if (!response.data?.schedule) return null;

    const tournaments = Array.isArray(response.data.schedule) 
      ? response.data.schedule 
      : Object.values(response.data.schedule);

    // Try exact eventId match first
    if (eventId) {
      const idMatch = tournaments.find(t => t.event_id === eventId);
      if (idMatch) return idMatch;
    }

    const searchName = tournamentName.toLowerCase().trim();
    
    // 1. Exact name match
    let match = tournaments.find(t => 
      t.event_name?.toLowerCase().trim() === searchName
    );
    if (match) return match;
    
    // 2. One name contains the other
    match = tournaments.find(t => {
      const dgName = t.event_name?.toLowerCase().trim() || '';
      return dgName.includes(searchName) || searchName.includes(dgName);
    });
    if (match) return match;
    
    // 3. Significant word overlap (at least 2 matching words > 2 chars)
    const searchWords = searchName.split(/\s+/).filter(w => w.length > 2);
    match = tournaments.find(t => {
      const dgWords = (t.event_name?.toLowerCase() || '').split(/\s+/);
      const matchCount = searchWords.filter(sw => 
        dgWords.some(dw => dw.includes(sw) || sw.includes(dw))
      ).length;
      return matchCount >= 2;
    });
    if (match) return match;

    // 4. Key word match (skip common short words)
    const skipWords = ['the', 'wm', 'at', 'and', 'of', 'at&t', 'att'];
    const keyWords = searchWords.filter(w => !skipWords.includes(w));
    if (keyWords.length > 0) {
      match = tournaments.find(t => {
        const dgName = t.event_name?.toLowerCase() || '';
        return keyWords.some(w => dgName.includes(w));
      });
      if (match) return match;
    }

    console.log(`[RESULTS] No match for "${tournamentName}". Schedule: ${tournaments.slice(0, 10).map(t => t.event_name).join(', ')}`);
    return null;

  } catch (error) {
    console.error('[RESULTS] Schedule fetch failed:', error.message);
    return null;
  }
}

/**
 * Fetch historical results - uses Scratch Plus endpoints
 * Primary: historical-event-data/events (finish positions, earnings)
 * Fallback: historical-raw-data/rounds (round-level scoring)
 */
async function fetchHistoricalResults(tour, tournamentInfo, apiKey) {
  // Try event-level data first (Scratch Plus - best source for finish positions)
  const eventResults = await fetchEventFinishes(tour, tournamentInfo, apiKey);
  if (eventResults.length > 0) return eventResults;
  
  // Fallback to round-level data
  const roundResults = await fetchFromRounds(tour, tournamentInfo, apiKey);
  if (roundResults.length > 0) return roundResults;
  
  return [];
}

/**
 * PRIMARY: Use historical-event-data/events endpoint (Scratch Plus)
 * Returns event-level finishes with position, earnings, points
 */
async function fetchEventFinishes(tour, tournamentInfo, apiKey) {
  try {
    const year = new Date().getFullYear();
    
    // First get event list to find the correct event_id for this endpoint
    // (event IDs may differ between raw-data and event-data endpoints)
    const eventListUrl = `https://feeds.datagolf.com/historical-event-data/event-list?tour=${tour}&file_format=json&key=${apiKey}`;
    
    console.log(`[RESULTS] Fetching event list from historical-event-data...`);
    const eventListResponse = await axios.get(eventListUrl, { timeout: 10000 });
    
    let eventId = tournamentInfo.event_id;
    
    // Try to find matching event in the event-data event list
    if (eventListResponse.data) {
      const events = Array.isArray(eventListResponse.data) ? eventListResponse.data : (eventListResponse.data.events || []);
      const match = events.find(e => {
        if (e.event_id === tournamentInfo.event_id) return true;
        const eName = (e.event_name || '').toLowerCase();
        const tName = (tournamentInfo.event_name || '').toLowerCase();
        return eName.includes(tName) || tName.includes(eName);
      });
      if (match) {
        eventId = match.event_id || match.calendar_event_id || eventId;
        console.log(`[RESULTS] Matched event: ${match.event_name} (id: ${eventId})`);
      }
    }
    
    const url = `https://feeds.datagolf.com/historical-event-data/events?tour=${tour}&event_id=${eventId}&year=${year}&file_format=json&key=${apiKey}`;
    
    console.log(`[RESULTS] Fetching event finishes: event_id=${eventId}, year=${year}`);
    const response = await axios.get(url, { timeout: 15000 });
    
    if (!response.data) return [];
    
    // DEBUG: Log the actual response structure to understand format
    const dataType = Array.isArray(response.data) ? 'array' : typeof response.data;
    const dataKeys = typeof response.data === 'object' && !Array.isArray(response.data) ? Object.keys(response.data) : [];
    const dataLength = Array.isArray(response.data) ? response.data.length : 'N/A';
    console.log(`[RESULTS] Response type: ${dataType}, keys: [${dataKeys.join(', ')}], length: ${dataLength}`);
    
    // Log first item to see field names
    const firstItem = Array.isArray(response.data) ? response.data[0] : 
                      (response.data.players?.[0] || response.data.results?.[0] || response.data[dataKeys[0]]?.[0]);
    if (firstItem) {
      console.log(`[RESULTS] First item keys: [${Object.keys(firstItem).join(', ')}]`);
      console.log(`[RESULTS] First item sample: ${JSON.stringify(firstItem).substring(0, 300)}`);
    }
    
    // Handle response format - DataGolf returns players in event_stats field
    let players = [];
    if (Array.isArray(response.data)) {
      players = response.data;
    } else if (typeof response.data === 'object') {
      // DataGolf uses 'event_stats' for historical-event-data/events
      players = response.data.event_stats || response.data.players || response.data.results || 
                response.data.field || response.data.leaderboard || response.data.data || [];
    }
    
    if (players.length === 0) {
      console.log(`[RESULTS] No players found in response`);
      return [];
    }
    
    console.log(`[RESULTS] Got ${players.length} players from event-data endpoint`);
    
    // Log first player's keys to understand field names
    if (players[0]) {
      console.log(`[RESULTS] Player fields: [${Object.keys(players[0]).join(', ')}]`);
    }
    
    // Map to our standard format
    const results = players
      .map(p => ({
        player: p.player_name || p.player || '',
        position: p.fin_text || p.finish_position || p.position || 'N/A',
        score: p.total_score || 'N/A',
        toPar: p.total_to_par != null ? `${p.total_to_par > 0 ? '+' : ''}${p.total_to_par}` : 'N/A',
        earnings: p.earnings || p.money || null
      }))
      .filter(p => p.player)
      .sort((a, b) => {
        const posA = parsePosition(a.position);
        const posB = parsePosition(b.position);
        return posA - posB;
      });
    
    console.log(`[RESULTS] ✅ Event finishes: ${results.length} players`);
    return results;
    
  } catch (error) {
    console.log(`[RESULTS] Event-data endpoint failed (${error.response?.status || error.message}), trying rounds...`);
    return [];
  }
}

/**
 * FALLBACK: Use historical-raw-data/rounds endpoint (Scratch Plus)
 * Aggregates round-level scoring into final positions
 */
async function fetchFromRounds(tour, tournamentInfo, apiKey) {
  try {
    const year = new Date().getFullYear();
    const url = `https://feeds.datagolf.com/historical-raw-data/rounds?tour=${tour}&event_id=${tournamentInfo.event_id}&year=${year}&file_format=json&key=${apiKey}`;
    
    console.log(`[RESULTS] Fetching round data: event_id=${tournamentInfo.event_id}, year=${year}`);

    const response = await axios.get(url, { timeout: 15000 });
    
    if (!response.data) return [];

    // DEBUG: Log response structure
    const dataType = Array.isArray(response.data) ? 'array' : typeof response.data;
    const dataKeys = typeof response.data === 'object' && !Array.isArray(response.data) ? Object.keys(response.data) : [];
    const dataLength = Array.isArray(response.data) ? response.data.length : 'N/A';
    console.log(`[RESULTS] Rounds response type: ${dataType}, keys: [${dataKeys.join(', ')}], length: ${dataLength}`);

    let rounds = [];
    if (Array.isArray(response.data)) {
      rounds = response.data;
    } else if (typeof response.data === 'object') {
      // DataGolf uses 'scores' for historical-raw-data/rounds
      rounds = response.data.scores || response.data.rounds || response.data.scorecards || [];
    }
    
    if (rounds.length === 0) {
      console.log(`[RESULTS] No rounds found`);
      // Log first item to debug
      if (rounds.length === 0 && response.data.scores === undefined) {
        console.log(`[RESULTS] Note: 'scores' field not found in response`);
      }
      return [];
    }
    
    // Log first round's keys
    if (rounds[0]) {
      console.log(`[RESULTS] Round fields: [${Object.keys(rounds[0]).join(', ')}]`);
    }

    console.log(`[RESULTS] Got ${rounds.length} round records`);

    const maxRound = Math.max(...rounds.map(r => r.round_num || r.round || 0));
    
    // Group by player
    const playerScores = {};
    
    for (const round of rounds) {
      const name = round.player_name || round.player;
      if (!name) continue;
      
      if (!playerScores[name]) {
        playerScores[name] = { player: name, rounds: 0, toPar: 0, fin_text: null };
      }
      
      playerScores[name].rounds++;
      playerScores[name].toPar += (round.score_to_par || 0);
      if (round.fin_text) playerScores[name].fin_text = round.fin_text;
    }

    const madeCut = Object.values(playerScores)
      .filter(p => p.rounds >= maxRound)
      .sort((a, b) => a.toPar - b.toPar)
      .map((p, index) => ({
        player: p.player,
        position: p.fin_text || String(index + 1),
        score: 'N/A',
        toPar: `${p.toPar > 0 ? '+' : ''}${p.toPar}`
      }));

    const missedCut = Object.values(playerScores)
      .filter(p => p.rounds < maxRound)
      .map(p => ({
        player: p.player,
        position: 'MC',
        score: 'N/A',
        toPar: `${p.toPar > 0 ? '+' : ''}${p.toPar}`
      }));

    console.log(`[RESULTS] Rounds data: ${madeCut.length} made cut, ${missedCut.length} MC`);
    return [...madeCut, ...missedCut];

  } catch (error) {
    console.log(`[RESULTS] Rounds endpoint failed: ${error.response?.status || error.message}`);
    return [];
  }
}

function parsePosition(pos) {
  if (!pos) return 999;
  if (typeof pos === 'number') return pos;
  if (pos === 'MC' || pos === 'WD' || pos === 'DQ' || pos === 'N/A') return 999;
  const num = parseInt(String(pos).replace(/[^0-9]/g, ''));
  return isNaN(num) ? 999 : num;
}

function createSuccessResponse(data) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  };
}

function createErrorResponse(message, statusCode = 500) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Failed to fetch tournament results', message })
  };
}
