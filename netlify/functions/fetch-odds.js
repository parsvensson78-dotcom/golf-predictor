const axios = require('axios');

/**
 * OPTIMIZED fetch-odds.js
 * Fetches golf odds from DataGolf API with bookmaker breakdown
 */
exports.handler = async (event, context) => {
  try {
    const { tournamentName, players, tour } = JSON.parse(event.body);
    
    console.log(`[ODDS] Fetching for ${tournamentName} (${tour.toUpperCase()}, ${players.length} players)`);

    const apiKey = process.env.DATAGOLF_API_KEY || '07b56aee1a02854e9513b06af5cd';
    const apiTour = tour === 'dp' ? 'euro' : tour;
    
    // Fetch live odds from DataGolf
    const oddsData = await fetchDataGolfOdds(apiTour, apiKey);
    
    if (oddsData.length === 0) {
      console.log('[ODDS] No odds data available, returning empty response');
      return createResponse([], 'DataGolf API (no data)');
    }

    console.log(`[ODDS] Successfully processed ${oddsData.length} players with odds`);
    
    return createResponse(oddsData, 'DataGolf API');

  } catch (error) {
    console.error('[ODDS] Error:', error.message);
    return createResponse([], 'DataGolf API (failed)', error.message);
  }
};

/**
 * Fetch odds from DataGolf API
 */
async function fetchDataGolfOdds(tour, apiKey) {
  const url = `https://feeds.datagolf.com/betting-tools/outrights?tour=${tour}&market=win&odds_format=american&file_format=json&key=${apiKey}`;
  
  console.log(`[ODDS] Calling DataGolf API (tour=${tour})...`);

  try {
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Golf-Predictor-App/1.0',
        'Accept': 'application/json'
      }
    });

    if (!response.data?.odds) {
      console.error('[ODDS] Invalid DataGolf response structure');
      return [];
    }

    const rawOdds = response.data.odds;
    console.log(`[ODDS] Retrieved ${rawOdds.length} players from DataGolf`);

    return processOddsData(rawOdds);

  } catch (error) {
    console.error('[ODDS] API request failed:', error.message);
    if (error.response) {
      console.error('[ODDS] Status:', error.response.status);
    }
    return [];
  }
}

/**
 * Process raw odds data from DataGolf
 */
function processOddsData(rawOdds) {
  const processedOdds = [];

  for (const player of rawOdds) {
    try {
      const playerName = cleanPlayerName(player.player_name);
      const bookOdds = extractBookmakerOdds(player);

      if (bookOdds.length === 0) continue;

      const oddsValues = bookOdds.map(b => b.odds);
      const avgOdds = Math.round(oddsValues.reduce((a, b) => a + b, 0) / oddsValues.length);
      
      // Best odds = highest value (e.g., +2000 > +1500)
      const bestOdds = Math.max(...oddsValues);
      const bestBookmaker = bookOdds.find(b => b.odds === bestOdds)?.bookmaker;
      
      // Worst odds = lowest value
      const worstOdds = Math.min(...oddsValues);
      const worstBookmaker = bookOdds.find(b => b.odds === worstOdds)?.bookmaker;

      processedOdds.push({
        player: playerName,
        odds: avgOdds,  // American odds (integer)
        americanOdds: formatAmericanOdds(avgOdds),
        minOdds: americanToDecimal(bestOdds),  // Best odds in decimal
        maxOdds: americanToDecimal(worstOdds), // Worst odds in decimal
        bestBookmaker,
        worstBookmaker,
        bookmakerCount: bookOdds.length,
        source: 'DataGolf (Live)'
      });

    } catch (error) {
      console.error(`[ODDS] Error processing ${player.player_name}:`, error.message);
    }
  }

  return processedOdds;
}

/**
 * Extract odds from all available bookmakers
 */
function extractBookmakerOdds(player) {
  const BOOKMAKERS = {
    'draftkings': 'DraftKings',
    'fanduel': 'FanDuel',
    'betmgm': 'BetMGM',
    'pointsbet': 'PointsBet',
    'williamhill_us': 'William Hill',
    'bet365': 'Bet365',
    'pinnacle': 'Pinnacle',
    'bovada': 'Bovada',
    'betrivers': 'BetRivers',
    'caesars': 'Caesars',
    'unibet': 'Unibet'
  };

  const bookOdds = [];

  for (const [key, name] of Object.entries(BOOKMAKERS)) {
    if (player[key] && player[key] !== null) {
      const odds = parseInt(player[key]);
      if (!isNaN(odds) && odds !== 0) {
        bookOdds.push({ bookmaker: name, odds });
      }
    }
  }

  return bookOdds;
}

/**
 * Create standardized response
 */
function createResponse(oddsData, source, error = null) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      odds: oddsData,
      scrapedCount: oddsData.length,
      matchedCount: oddsData.length,
      source,
      error,
      timestamp: new Date().toISOString()
    })
  };
}

/**
 * Format American odds with + sign
 */
function formatAmericanOdds(odds) {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

/**
 * Clean player name (remove flags, parentheses, commas)
 */
function cleanPlayerName(name) {
  return name
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '') // Remove flag emojis
    .replace(/\([^)]*\)/g, '') // Remove parentheses
    .replace(/,/g, '') // Remove commas
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize player name for matching
 */
function normalizePlayerName(name) {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  return normalized.split(' ').sort().join(' ');
}

/**
 * Convert American odds to decimal odds
 */
function americanToDecimal(americanOdds) {
  if (!americanOdds || americanOdds === 0) return null;
  
  return americanOdds > 0 
    ? (americanOdds / 100) + 1 
    : (100 / Math.abs(americanOdds)) + 1;
}
