const { getBlobStore, getLatestBlobForTournament } = require('./shared-utils');

/**
 * Get Latest Avoid Picks from Blobs - OPTIMIZED v2
 * Returns the most recent saved avoid picks for a tour
 * NOW SUPPORTS: ?tournament= filter for current tournament matching
 */
exports.handler = async (event, context) => {
  try {
    const { tour = 'pga', tournament = '' } = event.queryStringParameters || {};
    
    console.log(`[LATEST-AVOID] Fetching latest avoid picks for ${tour}${tournament ? ` (filter: "${tournament}")` : ''}`);
    
    let store;
    try {
      store = getBlobStore('avoid-picks', context);
      console.log(`[LATEST-AVOID] Store created successfully`);
    } catch (storeError) {
      console.error(`[LATEST-AVOID] Failed to create store:`, storeError);
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'No cached avoid picks found',
          message: 'Blobs not configured or no avoid picks saved yet'
        })
      };
    }
    
    // Use smart blob lookup that filters by tournament name
    const result = await getLatestBlobForTournament(store, tour, tournament || null);
    
    if (!result) {
      console.log(`[LATEST-AVOID] No cached avoid picks found for ${tour}`);
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'No cached avoid picks found',
          message: 'No avoid picks have been saved yet for this tour'
        })
      };
    }
    
    const { data: latestData, key: latestKey, fallback } = result;
    
    if (fallback) {
      console.log(`[LATEST-AVOID] ⚠️ No match for "${tournament}", returning fallback from ${latestKey}`);
    } else {
      console.log(`[LATEST-AVOID] ✅ Returning cached data from ${latestKey}`);
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
    console.error('[LATEST-AVOID] Error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Failed to fetch latest avoid picks',
        message: error.message
      })
    };
  }
};
