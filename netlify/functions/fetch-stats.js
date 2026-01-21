const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Fetches player statistics from DataGolf
 * Note: DataGolf may require authentication for full access
 */
exports.handler = async (event, context) => {
  try {
    const { players } = JSON.parse(event.body || '{}');
    
    if (!players || !Array.isArray(players) || players.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Players array required' })
      };
    }

    console.log(`Fetching stats for ${players.length} players`);

    let playerStats = {};

    // Try DataGolf public rankings page
    try {
      const response = await axios.get('https://datagolf.com/rankings', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        timeout: 20000
      });

      const $ = cheerio.load(response.data);
      
      console.log('Successfully loaded DataGolf rankings page');

      // Try to parse rankings table
      $('table tbody tr, .rankings-table tr').each((i, row) => {
        const $row = $(row);
        const cells = $row.find('td');
        
        if (cells.length >= 6) {
          const playerName = $(cells.eq(1)).text().trim() || $(cells.eq(0)).text().trim();
          const rank = $(cells.eq(0)).text().trim();
          
          // Try to get SG stats
          const sgTotal = parseFloat($(cells.eq(2)).text().trim()) || 0;
          const sgOTT = parseFloat($(cells.eq(3)).text().trim()) || 0;
          const sgAPP = parseFloat($(cells.eq(4)).text().trim()) || 0;
          const sgARG = parseFloat($(cells.eq(5)).text().trim()) || 0;
          const sgPutt = parseFloat($(cells.eq(6)).text().trim()) || 0;

          if (playerName && playerName.length > 2) {
            const normalizedName = playerName.toLowerCase().replace(/[^a-z\s]/g, '');
            
            playerStats[normalizedName] = {
              name: playerName,
              rank: parseInt(rank) || null,
              sgTotal,
              sgOTT,
              sgAPP,
              sgARG,
              sgPutt
            };
          }
        }
      });

      console.log(`Parsed ${Object.keys(playerStats).length} players from DataGolf`);
      
    } catch (scrapeError) {
      console.error('DataGolf scraping failed:', scrapeError.message);
      // Continue with fallback
    }

    // If scraping failed or got no data, use estimated stats
    if (Object.keys(playerStats).length === 0) {
      console.log('Using fallback estimated stats');
      
      // Generate reasonable estimated stats for all players
      players.forEach((player, index) => {
        const normalizedName = player.toLowerCase().replace(/[^a-z\s]/g, '');
        const baseRank = index + 1;
        
        // Estimate stats based on position in field
        // Better players earlier in the field
        const skillLevel = Math.max(0, 1 - (index / players.length));
        
        playerStats[normalizedName] = {
          name: player,
          rank: baseRank,
          sgTotal: (skillLevel * 2 - 0.5).toFixed(2),
          sgOTT: (skillLevel * 0.5 - 0.2).toFixed(2),
          sgAPP: (skillLevel * 0.6 - 0.2).toFixed(2),
          sgARG: (skillLevel * 0.4 - 0.1).toFixed(2),
          sgPutt: (skillLevel * 0.5 - 0.2).toFixed(2),
          estimated: true
        };
      });
    }

    // Match requested players with stats
    const results = players.map(player => {
      const normalizedName = player.toLowerCase().replace(/[^a-z\s]/g, '');
      
      // Try exact match first
      let stats = playerStats[normalizedName];
      
      // If not found, try partial matching on last name
      if (!stats) {
        const nameParts = normalizedName.split(' ');
        const lastName = nameParts[nameParts.length - 1];
        
        stats = Object.values(playerStats).find(p => {
          const pNormalized = p.name.toLowerCase();
          return pNormalized.includes(lastName) || lastName.includes(pNormalized.split(' ').pop());
        });
      }

      return {
        player,
        stats: stats || {
          name: player,
          rank: null,
          sgTotal: 0,
          sgOTT: 0,
          sgAPP: 0,
          sgARG: 0,
          sgPutt: 0,
          notFound: true
        }
      };
    });

    const foundCount = results.filter(r => !r.stats.notFound && !r.stats.estimated).length;
    const estimatedCount = results.filter(r => r.stats.estimated).length;
    
    console.log(`Stats summary: ${foundCount} found, ${estimatedCount} estimated, ${results.length - foundCount - estimatedCount} missing`);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=86400' // 24 hours
      },
      body: JSON.stringify({
        players: results,
        scrapedAt: new Date().toISOString(),
        usingEstimates: estimatedCount > 0
      })
    };

  } catch (error) {
    console.error('Stats fetch error:', error.message);
    console.error('Stack:', error.stack);
    
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to fetch player stats',
        message: error.message 
      })
    };
  }
};
