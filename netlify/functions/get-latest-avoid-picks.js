const { getBlobStore } = require('./shared-utils');

/**
 * Get Latest Avoid Picks from Blobs - OPTIMIZED
 * Returns the most recent saved avoid picks for a tour
 * NOW USES: shared-utils getBlobStore()
 */
exports.handler = async (event, context) => {
  try {
    const { tour = 'pga' } = event.queryStringParameters || {};
    
    console.log(`[LATEST-AVOID] Fetching latest avoid picks for ${tour}`);
    
    // Use shared getBlobStore helper
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
    
    // List all blobs for this tour
    let blobs;
    try {
      const { blobs: blobList } = await store.list({ prefix: `${tour}-` });
      blobs = blobList;
      console.log(`[LATEST-AVOID] Found ${blobs?.length || 0} blobs for prefix "${tour}-"`);
    } catch (listError) {
      console.error(`[LATEST-AVOID] Failed to list blobs:`, listError);
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'No cached avoid picks found',
          message: listError.message
        })
      };
    }
    
    if (!blobs || blobs.length === 0) {
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
    
    // Sort by key to get most recent
    const sortedBlobs = blobs.sort((a, b) => b.key.localeCompare(a.key));
    const latestKey = sortedBlobs[0].key;
    
    console.log(`[LATEST-AVOID] Found latest: ${latestKey}`);
    
    // Get the blob data
    const latestData = await store.get(latestKey, { type: 'json' });
    
    if (!latestData) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'Failed to load cached avoid picks'
        })
      };
    }
    
    console.log(`[LATEST-AVOID] Returning cached data from ${latestKey}`);
    
    // Return the cached avoid picks
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
        cacheKey: latestKey
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
