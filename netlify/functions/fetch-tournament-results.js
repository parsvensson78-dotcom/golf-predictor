const axios = require('axios');

/**
 * Fetch tournament results from DataGolf API
 * Returns final leaderboard with player positions and scores
 */
exports.handler = async (event, context) => {
  try {
    const { tournamentName, tour, eventId } = JSON.parse(event.body || '{}');

    if (!tournamentName) {
      return createErrorResponse('Tournament name required', 400);
    }

    console.log(`[RESULTS] Fetching results for: ${tournamentName}`);

    const apiKey = process.env.DATAGOLF_API_KEY || '07b56aee1a02854e9513b06af5cd';
    const apiTour = tour === 'dp' ? 'euro' : (tour || 'pga');

    // Fetch completed tournament results
    const results = await fetchTournamentResults(apiTour, tournamentName, eventId, apiKey);

    if (!results || results.length === 0) {
      console.log('[RESULTS] No results found - tournament may not be completed yet');
      return createSuccessResponse({
        status: 'not_completed',
        message: 'Tournament results not available yet',
        results: []
      });
    }

    console.log(`[RESULTS] ✅ Found ${results.length} players in final standings`);

    return createSuccessResponse({
      status: 'completed',
      tournamentName,
      results,
      fetchedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('[RESULTS] Error:', error.message);
    return createErrorResponse(error.message);
  }
};

/**
 * Fetch tournament results from DataGolf API
 */
async function fetchTournamentResults(tour, tournamentName, eventId, apiKey) {
  // DataGolf endpoint for completed tournaments
  const url = `https://feeds.datagolf.com/get-schedule?tour=${tour}&file_format=json&key=${apiKey}`;

  console.log(`[RESULTS] Fetching schedule to find completed tournament...`);

  try {
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

    const tournaments = Array.isArray(response.data.schedule) 
      ? response.data.schedule 
      : Object.values(response.data.schedule);

    // Find the tournament by name or eventId
    const tournament = tournaments.find(t => {
      const nameMatch = t.event_name?.toLowerCase().includes(tournamentName.toLowerCase().split(' ')[0]);
      const idMatch = eventId && t.event_id === eventId;
      return nameMatch || idMatch;
    });

    if (!tournament) {
      console.log(`[RESULTS] Tournament "${tournamentName}" not found in schedule`);
      return [];
    }

    console.log(`[RESULTS] Found tournament: ${tournament.event_name} (status: ${tournament.event_completed ? 'completed' : 'in progress'})`);

    // Check if tournament is completed
    if (!tournament.event_completed && tournament.event_completed !== 'yes') {
      console.log(`[RESULTS] Tournament not yet completed`);
      return [];
    }

    // If we have a winner, fetch detailed leaderboard
    if (tournament.winner) {
      console.log(`[RESULTS] Winner: ${tournament.winner}`);
      
      // Try to fetch detailed leaderboard from field-updates endpoint
      const leaderboard = await fetchDetailedLeaderboard(tour, tournament.event_id, apiKey);
      
      if (leaderboard.length > 0) {
        return leaderboard;
      }
    }

    // Fallback: return basic winner info
    return tournament.winner ? [{
      player: tournament.winner,
      position: 1,
      score: tournament.winning_score || 'N/A',
      toPar: tournament.winning_score ? `${tournament.winning_score > 0 ? '+' : ''}${tournament.winning_score}` : 'N/A'
    }] : [];

  } catch (error) {
    console.error('[RESULTS] Failed to fetch results:', error.message);
    return [];
  }
}

/**
 * Fetch detailed leaderboard from field-updates endpoint
 */
async function fetchDetailedLeaderboard(tour, eventId, apiKey) {
  try {
    const url = `https://feeds.datagolf.com/field-updates?tour=${tour}&file_format=json&key=${apiKey}`;
    
    console.log(`[RESULTS] Fetching detailed leaderboard...`);

    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Golf-Predictor-App/1.0',
        'Accept': 'application/json'
      }
    });

    if (!response.data?.field) {
      return [];
    }

    // Process field data into leaderboard
    const leaderboard = response.data.field
      .filter(player => player.player_name)
      .map(player => ({
        player: player.player_name,
        position: player.position || player.finish_position || 'N/A',
        score: player.total_score || 'N/A',
        toPar: player.total_to_par ? `${player.total_to_par > 0 ? '+' : ''}${player.total_to_par}` : 'N/A',
        earnings: player.earnings || null
      }))
      .filter(p => p.position !== 'N/A')
      .sort((a, b) => {
        // Handle ties (e.g., "T5")
        const posA = typeof a.position === 'string' ? parseInt(a.position.replace(/[^0-9]/g, '')) : a.position;
        const posB = typeof b.position === 'string' ? parseInt(b.position.replace(/[^0-9]/g, '')) : b.position;
        return posA - posB;
      });

    console.log(`[RESULTS] Processed ${leaderboard.length} players from leaderboard`);
    
    return leaderboard;

  } catch (error) {
    console.error('[RESULTS] Failed to fetch detailed leaderboard:', error.message);
    return [];
  }
}

/**
 * Create success response
 */
function createSuccessResponse(data) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  };
}

/**
 * Create error response
 */
function createErrorResponse(message, statusCode = 500) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      error: 'Failed to fetch tournament results',
      message 
    })
  };
}
