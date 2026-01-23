const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Fetch golf odds from Oddschecker with improved error handling
 * Scrapes multiple bookmakers and calculates average odds
 */
exports.handler = async (event, context) => {
  try {
    const body = JSON.parse(event.body);
    const { tournamentName, players } = body;

    console.log(`[ODDS] Starting fetch for: ${tournamentName}`);
    console.log(`[ODDS] Looking for ${players.length} players`);

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

    // STEP 2: Fetch current/live odds from Oddschecker
    const oddsCheckerUrl = getOddsCheckerUrl(tournamentName);
    console.log(`[ODDS] Oddschecker URL: ${oddsCheckerUrl}`);

    let oddsData = [];

    try {
      // Fetch the Oddschecker page
      console.log(`[ODDS] Fetching page...`);
      const response = await axios.get(oddsCheckerUrl, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1'
        }
      });

      console.log(`[ODDS] Page fetched successfully, status: ${response.status}`);
      console.log(`[ODDS] Content length: ${response.data.length} bytes`);

      const $ = cheerio.load(response.data);

      // Try multiple selectors for player rows
      const selectors = [
        '.diff-row',
        '.eventTableRow',
        'tr.diff-row',
        'tbody tr',
        '.t1 tr'
      ];

      let rowsFound = 0;
      for (const selector of selectors) {
        const rows = $(selector);
        if (rows.length > 0) {
          console.log(`[ODDS] Found ${rows.length} rows using selector: ${selector}`);
          rowsFound = rows.length;
          
          rows.each((index, element) => {
            try {
              const $row = $(element);
              
              // Try multiple selectors for player name
              let playerName = $row.find('.bet-name').first().text().trim() ||
                              $row.find('a.popup').first().text().trim() ||
                              $row.find('td').first().text().trim() ||
                              $row.find('.sel').first().text().trim();
              
              playerName = cleanPlayerName(playerName);
              
              if (!playerName || playerName.length < 3) return;

              // Get all odds cells
              const bookmakerOdds = [];
              
              $row.find('td').each((i, cell) => {
                const $cell = $(cell);
                const oddsText = $cell.text().trim();
                const decimalOdds = parseOdds(oddsText);
                
                if (decimalOdds && decimalOdds > 1) {
                  bookmakerOdds.push(decimalOdds);
                }
              });

              if (bookmakerOdds.length > 0) {
                const avgOdds = bookmakerOdds.reduce((a, b) => a + b, 0) / bookmakerOdds.length;
                const minOdds = Math.min(...bookmakerOdds);
                const maxOdds = Math.max(...bookmakerOdds);

                oddsData.push({
                  player: playerName,
                  odds: Math.round(avgOdds * 10) / 10,
                  minOdds: Math.round(minOdds * 10) / 10,
                  maxOdds: Math.round(maxOdds * 10) / 10,
                  bookmakerCount: bookmakerOdds.length
                });

                console.log(`[ODDS] ${playerName}: ${avgOdds.toFixed(1)}/1 avg (${bookmakerOdds.length} books)`);
              }
            } catch (rowError) {
              console.error('[ODDS] Error parsing row:', rowError.message);
            }
          });

          if (oddsData.length > 0) break; // Stop if we found data
        }
      }

      console.log(`[ODDS] Successfully parsed ${oddsData.length} players from ${rowsFound} rows`);

    } catch (scrapeError) {
      console.error('[ODDS] Scraping failed:', scrapeError.message);
      console.error('[ODDS] Error details:', scrapeError);
      
      // Return empty odds but don't fail the whole request
      console.log('[ODDS] Returning empty odds data due to scraping failure');
    }

    // Match players from request with both live and pre-tournament odds
    const matchedOdds = players.map(requestedPlayer => {
      // Find live odds match
      let liveMatch = oddsData.find(o => 
        normalizePlayerName(o.player) === normalizePlayerName(requestedPlayer)
      );

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
        minOdds: liveMatch?.minOdds || null,
        maxOdds: liveMatch?.maxOdds || null,
        bookmakerCount: liveMatch?.bookmakerCount || 0,
        source: liveMatch ? 'Oddschecker (Live)' : 'Not found'
      };

      // Add pre-tournament data if available
      if (preMatch) {
        result.preTournamentOdds = preMatch.odds;
        result.preTournamentDate = preTournamentDate;
        
        // Calculate movement if both odds available
        if (liveMatch && preMatch) {
          const diff = liveMatch.odds - preMatch.odds;
          result.oddsMovement = Math.round(diff * 10) / 10;
          
          if (diff < -0.5) {
            result.movementDirection = 'shortened'; // More popular
            result.movementEmoji = '📉';
          } else if (diff > 0.5) {
            result.movementDirection = 'lengthened'; // Less popular
            result.movementEmoji = '📈';
          } else {
            result.movementDirection = 'stable';
            result.movementEmoji = '➡️';
          }
          
          result.movementPercentage = Math.round((diff / preMatch.odds) * 100);
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
        source: 'Oddschecker',
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
        source: 'Oddschecker (failed)',
        error: error.message,
        timestamp: new Date().toISOString()
      })
    };
  }
};

/**
 * Determine Oddschecker URL based on tournament name
 */
function getOddsCheckerUrl(tournamentName) {
  const name = tournamentName.toLowerCase();

  // Comprehensive tournament URL mappings
  const urlMappings = {
    // Majors
    'masters': 'https://www.oddschecker.com/golf/us-masters/winner',
    'us open': 'https://www.oddschecker.com/golf/us-open/winner',
    'open championship': 'https://www.oddschecker.com/golf/the-open/winner',
    'british open': 'https://www.oddschecker.com/golf/the-open/winner',
    'pga championship': 'https://www.oddschecker.com/golf/uspga-championship/winner',
    
    // Signature Events
    'players championship': 'https://www.oddschecker.com/golf/the-players-championship/winner',
    'ryder cup': 'https://www.oddschecker.com/golf/ryder-cup/winner',
    
    // PGA Tour Regular Season
    'american express': 'https://www.oddschecker.com/golf/the-american-express/winner',
    'farmers insurance': 'https://www.oddschecker.com/golf/farmers-insurance-open/winner',
    'torrey pines': 'https://www.oddschecker.com/golf/farmers-insurance-open/winner',
    'waste management': 'https://www.oddschecker.com/golf/waste-management-phoenix-open/winner',
    'phoenix open': 'https://www.oddschecker.com/golf/waste-management-phoenix-open/winner',
    'pebble beach': 'https://www.oddschecker.com/golf/at-t-pebble-beach-pro-am/winner',
    'genesis': 'https://www.oddschecker.com/golf/genesis-invitational/winner',
    'riviera': 'https://www.oddschecker.com/golf/genesis-invitational/winner',
    'arnold palmer': 'https://www.oddschecker.com/golf/arnold-palmer-invitational/winner',
    'bay hill': 'https://www.oddschecker.com/golf/arnold-palmer-invitational/winner',
    'heritage': 'https://www.oddschecker.com/golf/rbc-heritage/winner',
    'memorial': 'https://www.oddschecker.com/golf/the-memorial-tournament/winner',
    'travelers': 'https://www.oddschecker.com/golf/travelers-championship/winner',
    'scottish open': 'https://www.oddschecker.com/golf/scottish-open/winner'
  };

  // Check for matching tournament
  for (const [key, url] of Object.entries(urlMappings)) {
    if (name.includes(key)) {
      console.log(`[ODDS] Matched tournament key: ${key}`);
      return url;
    }
  }

  // Fallback: construct URL from tournament name
  const slug = tournamentName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
  
  const fallbackUrl = `https://www.oddschecker.com/golf/${slug}/winner`;
  console.log(`[ODDS] Using fallback URL: ${fallbackUrl}`);
  return fallbackUrl;
}

/**
 * Parse odds from various formats
 */
function parseOdds(oddsText) {
  if (!oddsText || oddsText === '' || oddsText === '-' || oddsText === 'SP') return null;

  // Clean the text
  const cleaned = oddsText.replace(/[^\d/.]/g, '');

  // Handle fractional odds (e.g., "5/1", "9/2")
  if (cleaned.includes('/')) {
    const parts = cleaned.split('/');
    const numerator = parseFloat(parts[0]);
    const denominator = parseFloat(parts[1]);
    
    if (numerator && denominator && denominator > 0) {
      return numerator / denominator + 1; // Convert to decimal
    }
  }

  // Handle decimal odds (e.g., "6.0", "3.5")
  const decimal = parseFloat(cleaned);
  if (!isNaN(decimal) && decimal > 1) {
    return decimal;
  }

  return null;
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
 */
function normalizePlayerName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
