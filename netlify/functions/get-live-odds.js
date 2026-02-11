const axios = require('axios');
const { normalizePlayerName, formatAmericanOdds } = require('./shared-utils');

/**
 * Fetch current live odds for all players from DataGolf betting-tools/outrights
 * Lightweight endpoint - just returns a name→odds map for frontend use
 * Used to overlay fresh odds on cached predictions/avoid/matchup views
 */
exports.handler = async (event, context) => {
  try {
    const tour = event.queryStringParameters?.tour || 'pga';
    const apiKey = process.env.DATAGOLF_API_KEY || '07b56aee1a02854e9513b06af5cd';
    const apiTour = tour === 'dp' ? 'euro' : tour;

    const url = `https://feeds.datagolf.com/betting-tools/outrights?tour=${apiTour}&market=win&odds_format=american&file_format=json&key=${apiKey}`;

    console.log(`[LIVE-ODDS] Fetching outrights for ${apiTour}`);
    const response = await axios.get(url, { timeout: 10000 });

    if (!response.data?.odds) {
      return createResponse(200, { odds: {}, count: 0 });
    }

    // Build a normalized name → odds object
    const oddsMap = {};
    
    for (const entry of response.data.odds) {
      const name = entry.player_name;
      if (!name) continue;

      // Collect numeric odds from all bookmaker columns
      // DataGolf returns odds as strings like "+3500" in american format
      const bookOdds = [];
      for (const [key, val] of Object.entries(entry)) {
        if (key === 'player_name' || key === 'dg_id' || key === 'dk_salary' || 
            key === 'fd_salary' || key === 'baseline_history_fit' || key === 'datagolf') continue;
        if (typeof val === 'string' && (val.startsWith('+') || val.startsWith('-'))) {
          const num = parseInt(val);
          if (!isNaN(num) && num !== 0) bookOdds.push(num);
        } else if (typeof val === 'number' && val !== 0) {
          bookOdds.push(val);
        }
      }

      if (bookOdds.length === 0) continue;

      const avg = Math.round(bookOdds.reduce((a, b) => a + b, 0) / bookOdds.length);
      
      oddsMap[name] = {
        odds: avg,
        minOdds: Math.min(...bookOdds),
        maxOdds: Math.max(...bookOdds),
        bookmakerCount: bookOdds.length,
        dgModel: entry.datagolf && typeof entry.datagolf === 'object' 
          ? parseInt(entry.datagolf.baseline_history_fit || entry.datagolf.baseline) || null
          : typeof entry.datagolf === 'string' ? parseInt(entry.datagolf) || null : null
      };
    }

    console.log(`[LIVE-ODDS] ✅ ${Object.keys(oddsMap).length} players with odds`);

    return createResponse(200, {
      odds: oddsMap,
      count: Object.keys(oddsMap).length,
      fetchedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('[LIVE-ODDS] Error:', error.message);
    return createResponse(500, { error: error.message, odds: {} });
  }
};

function createResponse(statusCode, data) {
  return {
    statusCode,
    headers: { 
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300' // Cache 5 min
    },
    body: JSON.stringify(data)
  };
}
