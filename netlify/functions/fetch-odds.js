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
      // DataGolf returns: { player_name, draftkings, fanduel, bet365, etc. }
      rawOdds.forEach(player => {
        try {
          const playerName = cleanPlayerName(player.player_name);
          
          // DEBUG: Show first 3 players to see name format
          if (oddsData.length < 3) {
            console.log(`[DEBUG] DataGolf raw: "${player.player_name}" → cleaned: "${playerName}"`);
          }
          
          // Collect all available odds from different books
          const bookOdds = [];
          const bookmakers = [
            'draftkings', 'fanduel', 'betmgm', 'pointsbet', 'williamhill_us',
            'bet365', 'pinnacle', 'bovada', 'betrivers', 'caesars', 'unibet'
          ];
          
          bookmakers.forEach(book => {
            if (player[book] && player[book] !== null) {
              // DataGolf returns American odds as integers (e.g., 1200 for +1200)
              const odds = parseInt(player[book]);
              if (!isNaN(odds) && odds !== 0) {
                bookOdds.push(odds);
              }
            }
          });

          if (bookOdds.length > 0) {
            // Calculate average, min, max American odds
            const avgOdds = Math.round(bookOdds.reduce((a, b) => a + b, 0) / bookOdds.length);
            const minOdds = Math.max(...bookOdds); // Max = best odds for bettor (e.g., +2000 > +1500)
            const maxOdds = Math.min(...bookOdds); // Min = worst odds for bettor

            oddsData.push({
              player: playerName,
              odds: avgOdds,
              minOdds: minOdds,
              maxOdds: maxOdds,
              bookmakerCount: bookOdds.length,
              americanOdds: formatAmericanOdds(avgOdds)
            });

            console.log(`[ODDS] ${playerName}: Avg ${formatAmericanOdds(avgOdds)} | Best ${formatAmericanOdds(minOdds)} | Worst ${formatAmericanOdds(maxOdds)} (${bookOdds.length} books)`);
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

    // STEP 3: Match players from request with both live and pre-tournament odds
    
    // DEBUG: Show first 3 requested players
    console.log(`[DEBUG] First 3 requested players:`);
    players.slice(0, 3).forEach(p => {
      console.log(`[DEBUG] Requested: "${p}" → normalized: "${normalizePlayerName(p)}"`);
    });
    
    const matchedOdds = players.map(requestedPlayer => {
      // Find live odds match
      let liveMatch = oddsData.find(o => 
        normalizePlayerName(o.player) === normalizePlayerName(requestedPlayer)
      );

      // DEBUG: Log failed matches for first 5 players
      if (!liveMatch && matchedOdds.length < 5) {
        console.log(`[DEBUG] NO MATCH for "${requestedPlayer}" (normalized: "${normalizePlayerName(requestedPlayer)}")`);
        // Show what we're comparing against
        const similar = oddsData.find(o => {
          const normalized = normalizePlayerName(o.player);
          const requested = normalizePlayerName(requestedPlayer);
          return normalized.includes(requested.split(' ')[0]) || requested.includes(normalized.split(' ')[0]);
        });
        if (similar) {
          console.log(`[DEBUG] Closest match would be: "${similar.player}" (normalized: "${normalizePlayerName(similar.player)}")`);
        }
      }

      if (!liveMatch) {
        liveMatch = oddsData.find(o => {
          const normalized = normalizePlayerName(o.player);
          const requested = normalizePlayerName(requestedPlayer);
          return normalized.includes(requested) || requested.includes(normalized);
        });
      }

      // Find pre-tournament odds match
      let preMatch = preTournamentOdds.find(o =>
        normalizePlayerName(o.player) === normalizePlayerName(requestedPlayer)
      );

      if (!preMatch) {
        preMatch = preTournamentOdds.find(o => {
          const normalized = normalizePlayerName(o.player);
          const requested = normalizePlayerName(requestedPlayer);
          return normalized.includes(requested) || requested.includes(normalized);
        });
      }

      // Build response object
      const result = {
        player: requestedPlayer,
        odds: liveMatch?.odds || null,
        americanOdds: liveMatch?.americanOdds || null,
        minOdds: liveMatch?.minOdds || null,
        maxOdds: liveMatch?.maxOdds || null,
        bookmakerCount: liveMatch?.bookmakerCount || 0,
        source: liveMatch ? 'DataGolf (Live)' : 'Not found'
      };

      // Add pre-tournament data if available
      if (preMatch) {
        result.preTournamentOdds = preMatch.odds;
        result.preTournamentDate = preTournamentDate;
        
        // Calculate movement if both odds available
        if (liveMatch && preMatch) {
          const diff = liveMatch.odds - preMatch.odds;
          result.oddsMovement = diff;
          
          // For American odds, movement interpretation:
          // Positive odds getting MORE positive = lengthening (less favored)
          // Positive odds getting LESS positive = shortening (more favored)
          if (diff > 50) {
            result.movementDirection = 'lengthened'; // Less popular
            result.movementEmoji = '📈';
          } else if (diff < -50) {
            result.movementDirection = 'shortened'; // More popular
            result.movementEmoji = '📉';
          } else {
            result.movementDirection = 'stable';
            result.movementEmoji = '➡️';
          }
          
          // Calculate percentage change
          if (preMatch.odds > 0 && liveMatch.odds > 0) {
            result.movementPercentage = Math.round((diff / preMatch.odds) * 100);
          }
        }
      }

      return result;
    });

    const foundCount = matchedOdds.filter(o => o.odds !== null).length;
    const withPreOdds = matchedOdds.filter(o => o.preTournamentOdds).length;
    
    console.log(`[ODDS] Final result: Matched ${foundCount}/${players.length} live odds`);
    console.log(`[ODDS] Pre-tournament odds available for ${withPreOdds} players`);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        odds: matchedOdds,
        scrapedCount: oddsData.length,
        matchedCount: foundCount,
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
