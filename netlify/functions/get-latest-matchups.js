const { getBlobStore, getLatestBlobForTournament } = require('./shared-utils');

/**
 * Get Latest Matchups from Blobs - OPTIMIZED v2
 * Returns the most recent saved matchup predictions for a tour
 * NOW SUPPORTS: ?tournament= filter for current tournament matching
 */
exports.handler = async (event, context) => {
  try {
    const { tour = 'pga', tournament = '' } = event.queryStringParameters || {};
    
    console.log(`[LATEST-MATCHUP] Fetching latest matchups for ${tour}${tournament ? ` (filter: "${tournament}")` : ''}`);
    
    let store;
    try {
      store = getBlobStore('matchups', context);
      console.log(`[LATEST-MATCHUP] Store created successfully`);
    } catch (storeError) {
      console.error(`[LATEST-MATCHUP] Failed to create store:`, storeError);
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'No cached matchups found',
          message: 'Blobs not configured or no matchups saved yet'
        })
      };
    }
    
    // Use smart blob lookup that filters by tournament name
    const result = await getLatestBlobForTournament(store, tour, tournament || null);
    
    if (!result) {
      console.log(`[LATEST-MATCHUP] No cached matchups found for ${tour}`);
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'No cached matchups found',
          message: 'No matchups have been saved yet for this tour'
        })
      };
    }
    
    const { data: latestData, key: latestKey, fallback } = result;
    
    if (fallback) {
      console.log(`[LATEST-MATCHUP] ⚠️ No match for "${tournament}", returning fallback from ${latestKey}`);
    } else {
      console.log(`[LATEST-MATCHUP] ✅ Returning cached data from ${latestKey}`);
    }
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300'
      },
      body: JSON.stringify({
        ...latestData,
        generatedAt: latestData.generatedAt,
        fromCache: true,
        cacheKey: latestKey,
        isFallback: !!fallback
      })
    };
    
  } catch (error) {
    console.error('[LATEST-MATCHUP] Error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Failed to fetch latest matchups',
        message: error.message
      })
    };
  }
};
