const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Fetches player statistics from DataGolf
 * Key stats: SG: Total, SG: OTT, SG: APP, SG: ARG, SG: PUTT
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

    // Fetch DataGolf rankings page (has SG stats)
    const response = await axios.get('https://datagolf.com/rankings', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);
    const playerStats = {};

    // Parse the rankings table
    $('table tbody tr').each((i, row) => {
      const cells = $(row).find('td');
      
      if (cells.length >= 7) {
        const playerName = $(cells[1]).text().trim();
        const rank = $(cells[0]).text().trim();
        const sgTotal = $(cells[2]).text().trim();
        const sgOTT = $(cells[3]).text().trim();
        const sgAPP = $(cells[4]).text().trim();
        const sgARG = $(cells[5]).text().trim();
        const sgPutt = $(cells[6]).text().trim();

        // Normalize name for matching
        const normalizedName = playerName.toLowerCase().replace(/[^a-z\s]/g, '');
        
        playerStats[normalizedName] = {
          name: playerName,
          rank: parseInt(rank) || null,
          sgTotal: parseFloat(sgTotal) || 0,
          sgOTT: parseFloat(sgOTT) || 0,
          sgAPP: parseFloat(sgAPP) || 0,
          sgARG: parseFloat(sgARG) || 0,
          sgPutt: parseFloat(sgPutt) || 0
        };
      }
    });

    // Match requested players with stats
    const results = players.map(player => {
      const normalizedName = player.toLowerCase().replace(/[^a-z\s]/g, '');
      
      // Try exact match first
      let stats = playerStats[normalizedName];
      
      // If not found, try partial matching
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

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=86400' // 24 hours (stats don't change often)
      },
      body: JSON.stringify({
        players: results,
        scrapedAt: new Date().toISOString()
      })
    };

  } catch (error) {
    console.error('DataGolf fetch error:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to fetch player stats',
        message: error.message 
      })
    };
  }
};
