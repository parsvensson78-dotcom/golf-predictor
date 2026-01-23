const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');

/**
 * Scheduled Function: Fetch Pre-Tournament Odds Every Wednesday at 5 AM
 * 
 * This runs automatically via Netlify scheduled functions
 * Stores odds in a JSON file for comparison with live odds
 */
exports.handler = async (event, context) => {
  console.log('[PRE-ODDS] Starting Wednesday pre-tournament odds fetch...');
  
  try {
    // Determine which tournament is happening this week
    const tournament = await getCurrentTournament();
    
    if (!tournament) {
      console.log('[PRE-ODDS] No tournament found for this week');
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'No tournament this week' })
      };
    }

    console.log(`[PRE-ODDS] Fetching odds for: ${tournament.name}`);

    // Scrape Oddschecker for current odds
    const oddsData = await scrapeOddschecker(tournament.name);
    
    console.log(`[PRE-ODDS] Successfully scraped ${oddsData.length} players`);

    // Prepare cache data
    const cacheData = {
      tournament: tournament.name,
      course: tournament.course,
      dates: tournament.dates,
      tour: tournament.tour,
      fetchedAt: new Date().toISOString(),
      fetchDay: 'Wednesday',
      odds: oddsData
    };

    // Store in cache file
    const cacheDir = '/tmp/odds-cache';
    const cacheFile = path.join(cacheDir, 'pre-tournament-odds.json');
    
    // Ensure directory exists
    await fs.mkdir(cacheDir, { recursive: true });
    
    // Write cache file
    await fs.writeFile(cacheFile, JSON.stringify(cacheData, null, 2));
    
    console.log(`[PRE-ODDS] Cache saved to ${cacheFile}`);
    console.log(`[PRE-ODDS] Cached ${oddsData.length} players for ${tournament.name}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        tournament: tournament.name,
        playerCount: oddsData.length,
        fetchedAt: cacheData.fetchedAt
      })
    };

  } catch (error) {
    console.error('[PRE-ODDS] Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
  }
};

/**
 * Get current week's tournament
 */
async function getCurrentTournament() {
  try {
    const baseUrl = process.env.URL || 'http://localhost:8888';
    
    // Try PGA Tour first
    const pgaResponse = await axios.get(`${baseUrl}/.netlify/functions/fetch-tournament?tour=pga`, {
      timeout: 10000
    });
    
    if (pgaResponse.data && pgaResponse.data.name) {
      return pgaResponse.data;
    }

    // Fall back to DP World Tour
    const dpResponse = await axios.get(`${baseUrl}/.netlify/functions/fetch-tournament?tour=dp`, {
      timeout: 10000
    });
    
    return dpResponse.data;
  } catch (error) {
    console.error('[PRE-ODDS] Error fetching tournament:', error.message);
    return null;
  }
}

/**
 * Scrape Oddschecker for tournament odds
 */
async function scrapeOddschecker(tournamentName) {
  const oddsCheckerUrl = getOddsCheckerUrl(tournamentName);
  console.log(`[PRE-ODDS] Scraping: ${oddsCheckerUrl}`);

  const response = await axios.get(oddsCheckerUrl, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    }
  });

  const $ = cheerio.load(response.data);
  const oddsData = [];

  // Parse odds table
  const selectors = ['.diff-row', '.eventTableRow', 'tr.diff-row', 'tbody tr'];

  for (const selector of selectors) {
    const rows = $(selector);
    if (rows.length > 0) {
      console.log(`[PRE-ODDS] Found ${rows.length} rows with selector: ${selector}`);
      
      rows.each((index, element) => {
        const $row = $(element);
        
        let playerName = $row.find('.bet-name').first().text().trim() ||
                        $row.find('a.popup').first().text().trim() ||
                        $row.find('td').first().text().trim();
        
        playerName = cleanPlayerName(playerName);
        
        if (!playerName || playerName.length < 3) return;

        const bookmakerOdds = [];
        
        $row.find('td').each((i, cell) => {
          const oddsText = $(cell).text().trim();
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
        }
      });

      if (oddsData.length > 0) break;
    }
  }

  return oddsData;
}

/**
 * Get Oddschecker URL for tournament
 */
function getOddsCheckerUrl(tournamentName) {
  const name = tournamentName.toLowerCase();
  
  const urlMappings = {
    'masters': 'https://www.oddschecker.com/golf/us-masters/winner',
    'us open': 'https://www.oddschecker.com/golf/us-open/winner',
    'open championship': 'https://www.oddschecker.com/golf/the-open/winner',
    'pga championship': 'https://www.oddschecker.com/golf/uspga-championship/winner',
    'players championship': 'https://www.oddschecker.com/golf/the-players-championship/winner',
    'american express': 'https://www.oddschecker.com/golf/the-american-express/winner',
    'farmers insurance': 'https://www.oddschecker.com/golf/farmers-insurance-open/winner',
    'phoenix open': 'https://www.oddschecker.com/golf/waste-management-phoenix-open/winner',
    'genesis': 'https://www.oddschecker.com/golf/genesis-invitational/winner',
    'bay hill': 'https://www.oddschecker.com/golf/arnold-palmer-invitational/winner',
    'heritage': 'https://www.oddschecker.com/golf/rbc-heritage/winner',
    'memorial': 'https://www.oddschecker.com/golf/the-memorial-tournament/winner',
    'travelers': 'https://www.oddschecker.com/golf/travelers-championship/winner'
  };

  for (const [key, url] of Object.entries(urlMappings)) {
    if (name.includes(key)) return url;
  }

  const slug = tournamentName.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-');
  
  return `https://www.oddschecker.com/golf/${slug}/winner`;
}

/**
 * Parse odds
 */
function parseOdds(oddsText) {
  if (!oddsText || oddsText === '' || oddsText === '-' || oddsText === 'SP') return null;

  const cleaned = oddsText.replace(/[^\d/.]/g, '');

  if (cleaned.includes('/')) {
    const [numerator, denominator] = cleaned.split('/').map(parseFloat);
    if (numerator && denominator && denominator > 0) {
      return numerator / denominator + 1;
    }
  }

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
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
