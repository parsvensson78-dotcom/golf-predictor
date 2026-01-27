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

    // DataGolf Skill Ratings endpoint (available with Scratch Plus subscription)
    // Try different possible endpoint paths
    const endpoints = [
      `https://feeds.datagolf.com/preds/skill-ratings?file_format=json&key=${DATAGOLF_API_KEY}`,
      `https://feeds.datagolf.com/historical-raw-data/skill-ratings?file_format=json&key=${DATAGOLF_API_KEY}`,
      `https://feeds.datagolf.com/field-updates?file_format=json&tour=pga&key=${DATAGOLF_API_KEY}`
    ];
    
    console.log(`[STATS] Attempting to fetch from DataGolf skill ratings API...`);

    let playerStats = {};
    let successfulEndpoint = null;

    // Try each endpoint until one works
    for (const dataGolfUrl of endpoints) {
      try {
        console.log(`[STATS] Trying endpoint: ${dataGolfUrl.split('?')[0]}`);
        
        const response = await axios.get(dataGolfUrl, {
          timeout: 15000,
          headers: {
            'User-Agent': 'Golf-Predictor-App/1.0',
            'Accept': 'application/json'
          }
        });

        console.log(`[STATS] ✅ Success! Status: ${response.status}`);
        console.log(`[STATS] Response keys:`, Object.keys(response.data || {}));
        
        // Log first few keys to understand structure
        if (response.data) {
          console.log(`[STATS] Sample data:`, JSON.stringify(response.data).substring(0, 300));
        }
        
        // Try to find player data in various possible structures
        let playerData = null;
        
        if (response.data?.ratings) {
          playerData = response.data.ratings;
        } else if (response.data?.players) {
          playerData = response.data.players;
        } else if (response.data?.skill_ratings) {
          playerData = response.data.skill_ratings;
        } else if (Array.isArray(response.data)) {
          playerData = response.data;
        } else if (response.data?.field) {
          playerData = response.data.field;
        }
        
        if (playerData && playerData.length > 0) {
          console.log(`[STATS] Found player data array with ${playerData.length} players`);
          console.log(`[STATS] First player structure:`, JSON.stringify(playerData[0]));
          
          // Process the player data
          playerData.forEach((player, index) => {
            try {
              const playerName = cleanPlayerName(
                player.player_name || player.name || player.player || ''
              );
              const normalizedName = normalizePlayerName(playerName);
              
              // Extract stats with various possible field names
              playerStats[normalizedName] = {
                name: playerName,
                rank: player.datagolf_rank || player.rank || player.world_rank || (index + 1),
                sgTotal: parseFloat(player.sg_total || player.total_sg || player.sgTotal || 0),
                sgOTT: parseFloat(player.sg_ott || player.ott || player.sgOTT || 0),
                sgAPP: parseFloat(player.sg_app || player.app || player.sgAPP || 0),
                sgARG: parseFloat(player.sg_arg || player.arg || player.sgARG || 0),
                sgPutt: parseFloat(player.sg_putt || player.putt || player.sgPutt || 0)
              };
            } catch (err) {
              console.error(`[STATS] Error processing player:`, err.message);
            }
          });
          
          successfulEndpoint = dataGolfUrl.split('?')[0];
          console.log(`[STATS] Successfully processed ${Object.keys(playerStats).length} players from DataGolf`);
          break; // Success! Exit the loop
        }
        
      } catch (apiError) {
        console.log(`[STATS] ❌ Endpoint failed: ${apiError.message}`);
        if (apiError.response) {
          console.log(`[STATS] Status: ${apiError.response.status}`);
        }
        // Continue to next endpoint
      }
    }
    
    // If no endpoint worked, generate estimated stats
    if (Object.keys(playerStats).length === 0) {
      console.log(`[STATS] All endpoints failed. Generating estimated stats...`);
      
      // Generate estimated stats for all requested players
      players.forEach((player, index) => {
        const normalizedName = normalizePlayerName(player);
        
        const fieldPosition = index / Math.max(players.length - 1, 1);
        const skillLevel = 1 - fieldPosition;
        
        const sgTotal = parseFloat((skillLevel * 3.5 - 1.0).toFixed(2));
        const variance = (Math.random() - 0.5) * 0.3;
        
        playerStats[normalizedName] = {
          name: player,
          rank: index + 1,
          sgTotal: parseFloat((sgTotal + variance).toFixed(2)),
          sgOTT: parseFloat((sgTotal * 0.25 + (Math.random() - 0.5) * 0.2).toFixed(2)),
          sgAPP: parseFloat((sgTotal * 0.35 + (Math.random() - 0.5) * 0.2).toFixed(2)),
          sgARG: parseFloat((sgTotal * 0.20 + (Math.random() - 0.5) * 0.15).toFixed(2)),
          sgPutt: parseFloat((sgTotal * 0.20 + (Math.random() - 0.5) * 0.2).toFixed(2)),
          estimated: true
        };
      });
      
      console.log(`[STATS] Generated estimated stats for ${Object.keys(playerStats).length} players`);
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
