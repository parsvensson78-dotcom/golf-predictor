const axios = require('axios');

/**
 * Fetch golf odds from DataGolf API
 * Returns accurate American odds from aggregated sportsbooks
 */
exports.handler = async (event, context) => {
  try {
    const body = JSON.parse(event.body);
    const { tournamentName, players } = body;

    console.log(`[ODDS] Starting DataGolf fetch for: ${tournamentName}`);
    console.log(`[ODDS] Looking for ${players.length} players`);

    // DataGolf API key from environment
    const DATAGOLF_API_KEY = process.env.DATAGOLF_API_KEY || '07b56aee1a02854e9513b06af5cd';

    // STEP 1: Load pre-tournament cached odds (from Wednesday)
    let preTournamentOdds = [];
    let preTournamentDate = null;
    
    try {
      const fs = require('fs').promises;
      const cacheFile = '/tmp/odds-cache/pre-tournament-odds.json';
      const cacheData = await fs.readFile(cacheFile, 'utf8');
      const cached = JSON.parse(cacheData);
      
      console.log(`[ODDS] Found cached pre-tournament odds for: ${cached.tournament}`);
      console.log(`[ODDS] Cached on: ${cached.fetchedAt}`);
      
      // Check if cached tournament matches current tournament
      const tournamentMatch = cached.tournament.toLowerCase().includes(tournamentName.toLowerCase().split(' ')[0]) ||
                             tournamentName.toLowerCase().includes(cached.tournament.toLowerCase().split(' ')[0]);
      
      if (tournamentMatch) {
        preTournamentOdds = cached.odds || [];
        preTournamentDate = cached.fetchedAt;
        console.log(`[ODDS] Loaded ${preTournamentOdds.length} pre-tournament odds`);
      } else {
        console.log(`[ODDS] Cached tournament doesn't match current tournament`);
      }
    } catch (cacheError) {
      console.log(`[ODDS] No pre-tournament cache available: ${cacheError.message}`);
    }

    // STEP 2: Fetch current/live odds from DataGolf API
    const tour = determineTour(tournamentName);
    const dataGolfUrl = `https://feeds.datagolf.com/betting-tools/outrights?tour=${tour}&market=win&odds_format=american&file_format=json&key=${DATAGOLF_API_KEY}`;
    
    console.log(`[ODDS] DataGolf URL: ${dataGolfUrl}`);

    let oddsData = [];

    try {
      console.log(`[ODDS] Fetching from DataGolf API...`);
      const response = await axios.get(dataGolfUrl, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Golf-Predictor-App/1.0',
          'Accept': 'application/json'
        }
      });

      console.log(`[ODDS] DataGolf response received, status: ${response.status}`);
      
      if (!response.data || !response.data.odds) {
        console.error('[ODDS] Invalid DataGolf response structure');
        throw new Error('Invalid DataGolf API response');
      }

      const rawOdds = response.data.odds;
      console.log(`[ODDS] Retrieved ${rawOdds.length} players with odds from DataGolf`);

      // Process DataGolf odds
      rawOdds.forEach(player => {
        try {
          const playerName = cleanPlayerName(player.player_name);
          
          // DEBUG: Show first 3 players to see name format AND normalization
          if (oddsData.length < 3) {
            console.log(`[DEBUG] DataGolf raw: "${player.player_name}" → cleaned: "${playerName}" → normalized: "${normalizePlayerName(playerName)}"`);
          }
          
          // Collect all available odds from different books with bookmaker names
          const bookOdds = [];
          const bookmakerMap = {
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
          
          Object.keys(bookmakerMap).forEach(book => {
            if (player[book] && player[book] !== null) {
              // DataGolf returns American odds as integers (e.g., 1200 for +1200)
              const odds = parseInt(player[book]);
              if (!isNaN(odds) && odds !== 0) {
                bookOdds.push({
                  bookmaker: bookmakerMap[book],
                  odds: odds
                });
              }
            }
          });

          if (bookOdds.length > 0) {
            // Calculate average, min, max American odds
            const oddsValues = bookOdds.map(b => b.odds);
            const avgOdds = Math.round(oddsValues.reduce((a, b) => a + b, 0) / oddsValues.length);
            
            // Max = best odds for bettor (e.g., +2000 > +1500)
            const bestOddsValue = Math.max(...oddsValues);
            const bestBookmaker = bookOdds.find(b => b.odds === bestOddsValue)?.bookmaker;
            
            // Min = worst odds for bettor
            const worstOddsValue = Math.min(...oddsValues);
            const worstBookmaker = bookOdds.find(b => b.odds === worstOddsValue)?.bookmaker;

            oddsData.push({
              player: playerName,
              odds: avgOdds,
              minOdds: bestOddsValue,
              maxOdds: worstOddsValue,
              bestBookmaker: bestBookmaker,
              worstBookmaker: worstBookmaker,
              bookmakerCount: bookOdds.length,
              americanOdds: formatAmericanOdds(avgOdds)
            });

            console.log(`[ODDS] ${playerName}: Avg ${formatAmericanOdds(avgOdds)} | Best ${formatAmericanOdds(bestOddsValue)} (${bestBookmaker}) | Worst ${formatAmericanOdds(worstOddsValue)} (${worstBookmaker}) (${bookOdds.length} books)`);
          }
        } catch (playerError) {
          console.error(`[ODDS] Error processing player ${player.player_name}:`, playerError.message);
        }
      });

      console.log(`[ODDS] Successfully processed ${oddsData.length} players with odds`);

    } catch (apiError) {
      console.error('[ODDS] DataGolf API request failed:', apiError.message);
      if (apiError.response) {
        console.error('[ODDS] API Response Status:', apiError.response.status);
        console.error('[ODDS] API Response Data:', apiError.response.data);
      }
      
      // Return empty odds but don't fail the whole request
      console.log('[ODDS] Returning empty odds data due to API failure');
    }

    // STEP 3: Return all players from DataGolf (they're the actual tournament field)
    
    console.log(`[ODDS] Returning all ${oddsData.length} players from DataGolf`);

    // Convert oddsData to match expected format
    const allPlayers = oddsData.map(player => ({
      player: player.player,
      odds: player.odds,
      americanOdds: player.americanOdds,
      minOdds: player.minOdds,
      maxOdds: player.maxOdds,
      bestBookmaker: player.bestBookmaker,
      worstBookmaker: player.worstBookmaker,
      bookmakerCount: player.bookmakerCount,
      source: 'DataGolf (Live)'
    }));
    
    console.log(`[ODDS] Final result: Returning ${allPlayers.length} players with live odds`);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        odds: allPlayers,
        scrapedCount: oddsData.length,
        matchedCount: allPlayers.length,
        source: 'DataGolf API',
        timestamp: new Date().toISOString()
      })
    };

  } catch (error) {
    console.error('[ODDS] Fatal error:', error);
    console.error('[ODDS] Stack trace:', error.stack);
    
    // Return a proper error response instead of crashing
    return {
      statusCode: 200, // Return 200 so the main function doesn't fail
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        odds: [],
        scrapedCount: 0,
        matchedCount: 0,
        source: 'DataGolf API (failed)',
        error: error.message,
        timestamp: new Date().toISOString()
      })
    };
  }
};

/**
 * Determine tour code for DataGolf API
 */
function determineTour(tournamentName) {
  const name = tournamentName.toLowerCase();
  
  // DP World Tour tournaments
  const dpWorldTournaments = [
    'dp world', 'european tour', 'dubai', 'scottish open', 'irish open',
    'spanish open', 'italian open', 'bmw pga', 'dunhill', 'alfred dunhill'
  ];
  
  for (const keyword of dpWorldTournaments) {
    if (name.includes(keyword)) {
      return 'euro';
    }
  }
  
  // LIV Golf
  if (name.includes('liv')) {
    return 'liv';
  }
  
  // Korn Ferry
  if (name.includes('korn ferry')) {
    return 'kft';
  }
  
  // Default to PGA Tour
  return 'pga';
}

/**
 * Format American odds with + sign
 */
function formatAmericanOdds(odds) {
  if (odds > 0) {
    return `+${odds}`;
  }
  return `${odds}`;
}

/**
 * Clean player name
 */
function cleanPlayerName(name) {
  return name
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '') // Remove flags
    .replace(/\([^)]*\)/g, '') // Remove parentheses content
    .replace(/,/g, '') // Remove commas (DataGolf uses "LastName, FirstName" format)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize player name for matching
 * Handles both "LastName, FirstName" and "FirstName LastName" formats
 */
function normalizePlayerName(name) {
  let normalized = name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  const parts = normalized.split(' ');
  return parts.sort().join(' ');
}
