const { getBlobStore, getLatestBlobForTournament } = require('./shared-utils');

/**
 * Get Latest Predictions from Blobs - OPTIMIZED v2
 * Returns the most recent saved predictions for a tour
 * NOW SUPPORTS: ?tournament= filter to get data for specific tournament
 * USES: shared-utils getLatestBlobForTournament() for smart matching
 */
exports.handler = async (event, context) => {
  try {
    const { tour = 'pga', tournament = '' } = event.queryStringParameters || {};
    
    console.log(`[LATEST-PRED] Fetching latest predictions for ${tour}${tournament ? ` (filter: "${tournament}")` : ''}`);
    
    // Use shared getBlobStore helper
    let store;
    try {
      store = getBlobStore('predictions', context);
      console.log(`[LATEST-PRED] Store created successfully`);
    } catch (storeError) {
      console.error(`[LATEST-PRED] Failed to create store:`, storeError);
      return {
        statusCode: 503,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'Blobs not available',
          message: 'Failed to initialize Netlify Blobs storage',
          details: storeError.message
        })
      };
    }
    
    // Use smart blob lookup that filters by tournament name
    const result = await getLatestBlobForTournament(store, tour, tournament || null);
    
    if (!result) {
      console.log(`[LATEST-PRED] No cached predictions found for ${tour}`);
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'No cached predictions found',
          message: 'No predictions have been saved yet for this tour'
        })
      };
    }
    
    const { data: latestData, key: latestKey, fallback } = result;
    
    if (fallback) {
      console.log(`[LATEST-PRED] ⚠️ No match for "${tournament}", returning fallback from ${latestKey}`);
    } else {
      console.log(`[LATEST-PRED] ✅ Returning cached data from ${latestKey}`);
    }
    
    // Return the cached predictions
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300'
      },
      body: JSON.stringify({
        ...latestData,
        generatedAt: latestData.metadata?.generatedAt || latestData.generatedAt,
        fromCache: true,
        cacheKey: latestKey,
        isFallback: !!fallback
      })
    };
    
  } catch (error) {
    console.error('[LATEST-PRED] Error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Failed to fetch latest predictions',
        message: error.message
      })
    };
  }
};
