const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Fetch golf odds from Oddschecker
 * Scrapes multiple bookmakers and calculates average odds
 */
exports.handler = async (event, context) => {
  try {
    const body = JSON.parse(event.body);
    const { tournamentName, players } = body;

    console.log(`Fetching Oddschecker odds for: ${tournamentName}`);
    console.log(`Looking for ${players.length} players`);

    // Determine Oddschecker URL based on tournament
    const oddsCheckerUrl = getOddsCheckerUrl(tournamentName);
    console.log(`Oddschecker URL: ${oddsCheckerUrl}`);

    // Fetch the Oddschecker page
    const response = await axios.get(oddsCheckerUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://www.oddschecker.com/golf'
      }
    });

    const $ = cheerio.load(response.data);
    const oddsData = [];

    // Parse the Oddschecker table
    // Oddschecker structure: table with player names and odds from multiple bookmakers
    $('.diff-row, .eventTableRow').each((index, element) => {
      try {
        const $row = $(element);
        
        // Get player name
        let playerName = $row.find('.bet-name, a.popup').first().text().trim();
        
        // Clean up player name (remove extra spaces, flags, etc.)
        playerName = cleanPlayerName(playerName);
        
        if (!playerName) return;

        // Get all odds from different bookmakers in this row
        const bookmakerOdds = [];
        
        $row.find('.bc, td[data-bk]').each((i, oddsCell) => {
          const $cell = $(oddsCell);
          const oddsText = $cell.text().trim();
          
          // Parse fractional or decimal odds
          const decimalOdds = parseOdds(oddsText);
          
          if (decimalOdds && decimalOdds > 1) {
            bookmakerOdds.push(decimalOdds);
          }
        });

        if (bookmakerOdds.length > 0) {
          // Calculate average odds
          const avgOdds = bookmakerOdds.reduce((a, b) => a + b, 0) / bookmakerOdds.length;
          
          // Find min and max for reference
          const minOdds = Math.min(...bookmakerOdds);
          const maxOdds = Math.max(...bookmakerOdds);

          oddsData.push({
            player: playerName,
            odds: Math.round(avgOdds * 10) / 10, // Average odds rounded to 1 decimal
            minOdds: Math.round(minOdds * 10) / 10,
            maxOdds: Math.round(maxOdds * 10) / 10,
            bookmakerCount: bookmakerOdds.length,
            rawOdds: bookmakerOdds
          });

          console.log(`${playerName}: Avg ${avgOdds.toFixed(1)} (from ${bookmakerOdds.length} bookmakers, range: ${minOdds}-${maxOdds})`);
        }
      } catch (rowError) {
        console.error('Error parsing row:', rowError.message);
      }
    });

    console.log(`Successfully scraped ${oddsData.length} players from Oddschecker`);

    // Match players from the request with scraped odds
    const matchedOdds = players.map(requestedPlayer => {
      // Try to find exact match
      let match = oddsData.find(o => 
        normalizePlayerName(o.player) === normalizePlayerName(requestedPlayer)
      );

      // If no exact match, try partial match
      if (!match) {
        match = oddsData.find(o => {
          const normalized = normalizePlayerName(o.player);
          const requested = normalizePlayerName(requestedPlayer);
          return normalized.includes(requested) || requested.includes(normalized);
        });
      }

      if (match) {
        return {
          player: requestedPlayer,
          odds: match.odds,
          minOdds: match.minOdds,
          maxOdds: match.maxOdds,
          bookmakerCount: match.bookmakerCount,
          source: 'Oddschecker'
        };
      } else {
        console.log(`No odds found for: ${requestedPlayer}`);
        return {
          player: requestedPlayer,
          odds: null,
          source: 'Not found'
        };
      }
    });

    // Count successful matches
    const foundCount = matchedOdds.filter(o => o.odds !== null).length;
    console.log(`Matched ${foundCount}/${players.length} players with odds`);

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
    console.error('Oddschecker fetch error:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to fetch odds from Oddschecker',
        message: error.message,
        odds: [] // Return empty array so app doesn't break
      })
    };
  }
};

/**
 * Determine Oddschecker URL based on tournament name
 */
function getOddsCheckerUrl(tournamentName) {
  const name = tournamentName.toLowerCase();

  // Map tournament names to Oddschecker URLs
  const urlMappings = {
    'masters': 'https://www.oddschecker.com/golf/us-masters/winner',
    'us open': 'https://www.oddschecker.com/golf/us-open/winner',
    'open championship': 'https://www.oddschecker.com/golf/the-open/winner',
    'pga championship': 'https://www.oddschecker.com/golf/uspga-championship/winner',
    'players championship': 'https://www.oddschecker.com/golf/the-players-championship/winner',
    'ryder cup': 'https://www.oddschecker.com/golf/ryder-cup/winner',
    'american express': 'https://www.oddschecker.com/golf/the-american-express/winner',
    'farmers insurance': 'https://www.oddschecker.com/golf/farmers-insurance-open/winner',
    'waste management': 'https://www.oddschecker.com/golf/waste-management-phoenix-open/winner',
    'phoenix': 'https://www.oddschecker.com/golf/waste-management-phoenix-open/winner',
    'genesis': 'https://www.oddschecker.com/golf/genesis-invitational/winner',
    'bay hill': 'https://www.oddschecker.com/golf/arnold-palmer-invitational/winner',
    'arnold palmer': 'https://www.oddschecker.com/golf/arnold-palmer-invitational/winner',
    'heritage': 'https://www.oddschecker.com/golf/rbc-heritage/winner',
    'memorial': 'https://www.oddschecker.com/golf/the-memorial-tournament/winner',
    'travelers': 'https://www.oddschecker.com/golf/travelers-championship/winner'
  };

  // Check for matching tournament
  for (const [key, url] of Object.entries(urlMappings)) {
    if (name.includes(key)) {
      return url;
    }
  }

  // Default: try to construct URL from tournament name
  const slug = tournamentName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  
  return `https://www.oddschecker.com/golf/${slug}/winner`;
}

/**
 * Parse odds from various formats (fractional, decimal)
 */
function parseOdds(oddsText) {
  if (!oddsText || oddsText === '' || oddsText === '-') return null;

  // Remove any non-numeric characters except / and .
  const cleaned = oddsText.replace(/[^\d/.]/g, '');

  // Handle fractional odds (e.g., "5/1", "9/2")
  if (cleaned.includes('/')) {
    const [numerator, denominator] = cleaned.split('/').map(Number);
    if (numerator && denominator) {
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
 * Clean player name (remove flags, extra spaces)
 */
function cleanPlayerName(name) {
  return name
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '') // Remove flag emojis
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
