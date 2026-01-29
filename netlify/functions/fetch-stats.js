const axios = require('axios');

/**
 * OPTIMIZED fetch-stats.js
 * Fetches player Strokes Gained statistics from DataGolf API
 */
exports.handler = async (event, context) => {
  try {
    const { players } = JSON.parse(event.body || '{}');
    
    if (!players?.length) {
      return createErrorResponse('Players array required', 400);
    }

    console.log(`[STATS] Fetching stats for ${players.length} players`);

    const apiKey = process.env.DATAGOLF_API_KEY || '07b56aee1a02854e9513b06af5cd';
    
    // Fetch stats from DataGolf
    const playerStats = await fetchDataGolfStats(apiKey);
    
    // Match requested players with fetched stats
    const results = matchPlayersToStats(players, playerStats);
    
    const foundCount = results.filter(r => !r.stats.notFound).length;
    console.log(`[STATS] Matched ${foundCount}/${players.length} players`);

    return createSuccessResponse(results, foundCount, players.length - foundCount);

  } catch (error) {
    console.error('[STATS] Fatal error:', error.message);
    
    // Fallback to estimated stats
    const { players } = JSON.parse(event.body || '{}');
    const estimatedResults = generateEstimatedStats(players);
    
    return createSuccessResponse(estimatedResults, 0, players.length, true, error.message);
  }
};

/**
 * Fetch stats from DataGolf API (tries multiple endpoints)
 */
async function fetchDataGolfStats(apiKey) {
  const ENDPOINTS = [
    `https://feeds.datagolf.com/preds/skill-ratings?file_format=json&key=${apiKey}`,
    `https://feeds.datagolf.com/historical-raw-data/skill-ratings?file_format=json&key=${apiKey}`,
    `https://feeds.datagolf.com/field-updates?file_format=json&tour=pga&key=${apiKey}`
  ];

  console.log(`[STATS] Attempting ${ENDPOINTS.length} DataGolf endpoints...`);

  for (const url of ENDPOINTS) {
    try {
      const endpoint = url.split('?')[0];
      console.log(`[STATS] Trying: ${endpoint}`);
      
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Golf-Predictor-App/1.0',
          'Accept': 'application/json'
        }
      });

      const playerData = extractPlayerData(response.data);
      
      if (playerData?.length > 0) {
        console.log(`[STATS] ✅ Success! Found ${playerData.length} players`);
        return processPlayerData(playerData);
      }

    } catch (error) {
      console.log(`[STATS] ❌ Failed: ${error.message}`);
    }
  }

  console.log(`[STATS] All endpoints failed, using estimated stats`);
  return {};
}

/**
 * Extract player data from various possible response structures
 */
function extractPlayerData(data) {
  if (!data) return null;
  
  // Try different possible data structures
  return data.ratings || 
         data.players || 
         data.skill_ratings || 
         data.field || 
         (Array.isArray(data) ? data : null);
}

/**
 * Process raw player data into normalized stats object
 */
function processPlayerData(playerData) {
  const stats = {};

  for (let i = 0; i < playerData.length; i++) {
    const player = playerData[i];
    
    try {
      const playerName = cleanPlayerName(
        player.player_name || player.name || player.player || ''
      );
      
      if (!playerName) continue;

      const normalizedName = normalizePlayerName(playerName);
      
      stats[normalizedName] = {
        name: playerName,
        rank: player.datagolf_rank || player.rank || player.world_rank || (i + 1),
        sgTotal: parseFloat(player.sg_total || player.total_sg || player.sgTotal || 0),
        sgOTT: parseFloat(player.sg_ott || player.ott || player.sgOTT || 0),
        sgAPP: parseFloat(player.sg_app || player.app || player.sgAPP || 0),
        sgARG: parseFloat(player.sg_arg || player.arg || player.sgARG || 0),
        sgPutt: parseFloat(player.sg_putt || player.putt || player.sgPutt || 0)
      };
    } catch (error) {
      console.error(`[STATS] Error processing player:`, error.message);
    }
  }

  console.log(`[STATS] Processed ${Object.keys(stats).length} players`);
  return stats;
}

/**
 * Match requested players with fetched stats
 */
function matchPlayersToStats(requestedPlayers, statsData) {
  return requestedPlayers.map(player => {
    const normalizedName = normalizePlayerName(player);
    
    // Try exact match first
    let stats = statsData[normalizedName];
    
    // Try last name match as fallback
    if (!stats) {
      stats = findByLastName(normalizedName, statsData);
    }

    return {
      player,
      stats: stats || createNotFoundStats(player)
    };
  });
}

/**
 * Find player by last name match
 */
function findByLastName(normalizedName, statsData) {
  const nameParts = normalizedName.split(' ');
  const lastName = nameParts[nameParts.length - 1];
  
  const matchKey = Object.keys(statsData).find(key => {
    const keyParts = key.split(' ');
    const keyLastName = keyParts[keyParts.length - 1];
    return keyLastName === lastName;
  });
  
  return matchKey ? statsData[matchKey] : null;
}

/**
 * Generate estimated stats for all players (fallback)
 */
function generateEstimatedStats(players) {
  return players.map((player, index) => {
    const fieldPosition = index / Math.max(players.length - 1, 1);
    const skillLevel = 1 - fieldPosition;
    
    const baseTotal = skillLevel * 3.5 - 1.0;
    const variance = (Math.random() - 0.5) * 0.3;
    const sgTotal = parseFloat((baseTotal + variance).toFixed(2));
    
    return {
      player,
      stats: {
        name: player,
        rank: index + 1,
        sgTotal,
        sgOTT: parseFloat((sgTotal * 0.25 + (Math.random() - 0.5) * 0.2).toFixed(2)),
        sgAPP: parseFloat((sgTotal * 0.35 + (Math.random() - 0.5) * 0.2).toFixed(2)),
        sgARG: parseFloat((sgTotal * 0.20 + (Math.random() - 0.5) * 0.15).toFixed(2)),
        sgPutt: parseFloat((sgTotal * 0.20 + (Math.random() - 0.5) * 0.2).toFixed(2)),
        estimated: true
      }
    };
  });
}

/**
 * Create "not found" stats object
 */
function createNotFoundStats(playerName) {
  return {
    name: playerName,
    rank: null,
    sgTotal: 0,
    sgOTT: 0,
    sgAPP: 0,
    sgARG: 0,
    sgPutt: 0,
    notFound: true
  };
}

/**
 * Create success response
 */
function createSuccessResponse(players, foundCount, missingCount, isEstimated = false, error = null) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600' // 1 hour cache
    },
    body: JSON.stringify({
      players,
      scrapedAt: new Date().toISOString(),
      source: isEstimated ? 'Estimated (API failed)' : 'DataGolf API',
      foundCount,
      missingCount,
      usingEstimates: isEstimated,
      error
    })
  };
}

/**
 * Create error response
 */
function createErrorResponse(message, statusCode = 500) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: message })
  };
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
