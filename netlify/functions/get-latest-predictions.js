const { getBlobStore } = require('./shared-utils');

/**
 * Get Latest Predictions from Blobs - OPTIMIZED
 * Returns the most recent saved predictions for a tour
 * NOW USES: shared-utils getBlobStore()
 */
exports.handler = async (event, context) => {
  try {
    const { tour = 'pga' } = event.queryStringParameters || {};
    
    console.log(`[LATEST-PRED] Fetching latest predictions for ${tour}`);
    
    // Use shared getBlobStore helper (eliminates 15 lines of duplicate code)
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
    
    // List all blobs for this tour
    let blobs;
    try {
      const listResult = await store.list({ prefix: `${tour}-` });
      blobs = listResult.blobs;
      console.log(`[LATEST-PRED] Found ${blobs?.length || 0} blobs for prefix "${tour}-"`);
    } catch (listError) {
      console.error(`[LATEST-PRED] Failed to list blobs:`, listError);
      return {
        statusCode: 503,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'Failed to list blobs',
          message: listError.message
        })
      };
    }
    
    if (!blobs || blobs.length === 0) {
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
    
    // Sort by key (which contains timestamp) to get most recent
    const sortedBlobs = blobs.sort((a, b) => b.key.localeCompare(a.key));
    const latestKey = sortedBlobs[0].key;
    
    console.log(`[LATEST-PRED] Found latest: ${latestKey}`);
    
    // Get the blob data
    const latestData = await store.get(latestKey, { type: 'json' });
    
    if (!latestData) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'Failed to load cached predictions'
        })
      };
    }
    
    console.log(`[LATEST-PRED] Returning cached data from ${latestKey}`);
    
    // Return the cached predictions
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300' // Cache for 5 minutes in browser
      },
      body: JSON.stringify({
        ...latestData,
        generatedAt: latestData.metadata?.generatedAt || latestData.generatedAt,
        fromCache: true,
        cacheKey: latestKey
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
