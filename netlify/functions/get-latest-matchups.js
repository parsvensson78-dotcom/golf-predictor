const { getBlobStore } = require('./shared-utils');

/**
 * Get Latest Matchups from Blobs - OPTIMIZED
 * Returns the most recent saved matchup predictions for a tour
 * NOW USES: shared-utils getBlobStore()
 */
exports.handler = async (event, context) => {
  try {
    const { tour = 'pga' } = event.queryStringParameters || {};
    
    console.log(`[LATEST-MATCHUP] Fetching latest matchups for ${tour}`);
    
    // Use shared getBlobStore helper
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
    
    // List all blobs for this tour
    let blobs;
    try {
      const { blobs: blobList } = await store.list({ prefix: `${tour}-` });
      blobs = blobList;
      console.log(`[LATEST-MATCHUP] Found ${blobs?.length || 0} blobs for prefix "${tour}-"`);
    } catch (listError) {
      console.error(`[LATEST-MATCHUP] Failed to list blobs:`, listError);
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'No cached matchups found',
          message: listError.message
        })
      };
    }
    
    if (!blobs || blobs.length === 0) {
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
    
    // Sort by key to get most recent
    const sortedBlobs = blobs.sort((a, b) => b.key.localeCompare(a.key));
    const latestKey = sortedBlobs[0].key;
    
    console.log(`[LATEST-MATCHUP] Found latest: ${latestKey}`);
    
    // Get the blob data
    const latestData = await store.get(latestKey, { type: 'json' });
    
    if (!latestData) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'Failed to load cached matchups'
        })
      };
    }
    
    console.log(`[LATEST-MATCHUP] Returning cached data from ${latestKey}`);
    
    // Return the cached matchups
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
