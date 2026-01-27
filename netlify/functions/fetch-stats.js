const axios = require('axios');

/**
 * Fetches player skill ratings from DataGolf API
 * Returns Strokes Gained statistics for requested players
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

    console.log(`[STATS] Fetching stats for ${players.length} players`);

    // DataGolf API key from environment
    const DATAGOLF_API_KEY = process.env.DATAGOLF_API_KEY || '07b56aee1a02854e9513b06af5cd';

    // DataGolf Skill Decompositions endpoint (provides SG stats)
    // According to docs: https://datagolf.com/api-access
    const dataGolfUrl = `https://feeds.datagolf.com/preds/skill-decompositions?file_format=json&key=${DATAGOLF_API_KEY}`;
    
    console.log(`[STATS] Fetching from DataGolf API...`);

    let playerStats = {};

    try {
      const response = await axios.get(dataGolfUrl, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Golf-Predictor-App/1.0',
          'Accept': 'application/json'
        }
      });

      console.log(`[STATS] DataGolf response received, status: ${response.status}`);
      
      // DEBUG: Log response structure
      console.log(`[STATS] Response keys:`, Object.keys(response.data || {}));
      
      // According to DataGolf docs, skill-decompositions returns:
      // { decompositions: [ { dg_id, player_name, primary_tour, datagolf_rank, sg_putt, sg_arg, sg_app, sg_ott, sg_t2g, sg_total } ] }
      let decompositions = null;
      
      if (response.data?.decompositions) {
        decompositions = response.data.decompositions;
        console.log(`[STATS] Found decompositions array with ${decompositions.length} players`);
      } else if (Array.isArray(response.data)) {
        decompositions = response.data;
        console.log(`[STATS] Response is direct array with ${decompositions.length} players`);
      } else {
        console.error('[STATS] Unknown response structure:', JSON.stringify(response.data).substring(0, 500));
        throw new Error('Invalid DataGolf API response - unexpected structure');
      }

      if (!decompositions || decompositions.length === 0) {
        console.error('[STATS] No player decompositions found in response');
        throw new Error('No player decompositions in DataGolf response');
      }

      console.log(`[STATS] Retrieved ${decompositions.length} players with skill decompositions from DataGolf`);
      
      // DEBUG: Show first player structure
      if (decompositions.length > 0) {
        console.log(`[STATS] Sample player data:`, JSON.stringify(decompositions[0]));
      }

      // Process DataGolf skill decompositions
      decompositions.forEach(player => {
        try {
          const playerName = cleanPlayerName(player.player_name || player.name);
          const normalizedName = normalizePlayerName(playerName);
          
          playerStats[normalizedName] = {
            name: playerName,
            rank: player.datagolf_rank || null,
            sgTotal: parseFloat(player.sg_total) || 0,
            sgOTT: parseFloat(player.sg_ott) || 0,
            sgAPP: parseFloat(player.sg_app) || 0,
            sgARG: parseFloat(player.sg_arg) || 0,
            sgPutt: parseFloat(player.sg_putt) || 0,
            sgT2G: parseFloat(player.sg_t2g) || 0 // Tee to green
          };
          
        } catch (playerError) {
          console.error(`[STATS] Error processing player ${player.player_name || player.name}:`, playerError.message);
        }
      });

      console.log(`[STATS] Successfully processed ${Object.keys(playerStats).length} players with stats`);

    } catch (apiError) {
      console.error('[STATS] DataGolf API request failed:', apiError.message);
      if (apiError.response) {
        console.error('[STATS] API Response Status:', apiError.response.status);
        console.error('[STATS] API Response Data:', apiError.response.data);
      }
      
      // Fall back to estimated stats
      console.log('[STATS] Falling back to estimated stats');
      throw apiError; // Re-throw to trigger fallback
    }

    // Match requested players with stats
    const results = players.map(requestedPlayer => {
      const normalizedRequested = normalizePlayerName(requestedPlayer);
      
      // Try exact match first
      let stats = playerStats[normalizedRequested];
      
      // If not found, try partial matching on last name
      if (!stats) {
        const nameParts = normalizedRequested.split(' ');
        const lastName = nameParts[nameParts.length - 1];
        
        // Find by last name match
        const matchKey = Object.keys(playerStats).find(key => {
          const keyParts = key.split(' ');
          const keyLastName = keyParts[keyParts.length - 1];
          return keyLastName === lastName;
        });
        
        if (matchKey) {
          stats = playerStats[matchKey];
        }
      }

      return {
        player: requestedPlayer,
        stats: stats || {
          name: requestedPlayer,
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

    const foundCount = results.filter(r => !r.stats.notFound).length;
    const missingCount = results.filter(r => r.stats.notFound).length;
    
    console.log(`[STATS] Final result: Found ${foundCount}/${players.length} players`);
    if (missingCount > 0) {
      console.log(`[STATS] Missing stats for ${missingCount} players`);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600' // 1 hour cache
      },
      body: JSON.stringify({
        players: results,
        scrapedAt: new Date().toISOString(),
        source: 'DataGolf API',
        foundCount,
        missingCount
      })
    };

  } catch (error) {
    console.error('[STATS] Fatal error:', error.message);
    console.error('[STATS] Stack trace:', error.stack);
    
    // Return estimated stats as fallback
    const { players } = JSON.parse(event.body || '{}');
    
    console.log('[STATS] Using fallback estimated stats for all players');
    
    const estimatedResults = players.map((player, index) => {
      const baseRank = index + 1;
      const skillLevel = Math.max(0, 1 - (index / players.length));
      
      return {
        player,
        stats: {
          name: player,
          rank: baseRank,
          sgTotal: parseFloat((skillLevel * 2 - 0.5).toFixed(2)),
          sgOTT: parseFloat((skillLevel * 0.5 - 0.2).toFixed(2)),
          sgAPP: parseFloat((skillLevel * 0.6 - 0.2).toFixed(2)),
          sgARG: parseFloat((skillLevel * 0.4 - 0.1).toFixed(2)),
          sgPutt: parseFloat((skillLevel * 0.5 - 0.2).toFixed(2)),
          estimated: true
        }
      };
    });
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600'
      },
      body: JSON.stringify({
        players: estimatedResults,
        scrapedAt: new Date().toISOString(),
        source: 'Estimated (API failed)',
        usingEstimates: true,
        error: error.message
      })
    };
  }
};

/**
 * Clean player name - remove commas, flags, parentheses
 */
function cleanPlayerName(name) {
  return name
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '') // Remove flags
    .replace(/\([^)]*\)/g, '') // Remove parentheses content
    .replace(/,/g, '') // Remove commas
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize player name for matching
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
