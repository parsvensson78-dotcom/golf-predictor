const { getStore } = require('@netlify/blobs');

/**
 * Get Latest Predictions from Blobs
 * Returns the most recent saved predictions for a tour
 */
exports.handler = async (event, context) => {
  try {
    const { tour = 'pga' } = event.queryStringParameters || {};
    
    console.log(`[LATEST] Fetching latest predictions for ${tour}`);
    
    // Get Netlify Blobs store (same as save-predictions.js)
    const store = getStore('predictions');
    
    // List all blobs for this tour
    const { blobs } = await store.list({ prefix: `${tour}-` });
    
    if (!blobs || blobs.length === 0) {
      console.log(`[LATEST] No cached predictions found for ${tour}`);
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'No cached predictions found',
          message: 'Click "Get Predictions" to generate new predictions'
        })
      };
    }
    
    // Sort by key (which contains timestamp) to get most recent
    const sortedBlobs = blobs.sort((a, b) => b.key.localeCompare(a.key));
    const latestKey = sortedBlobs[0].key;
    
    console.log(`[LATEST] Found latest: ${latestKey}`);
    
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
    
    console.log(`[LATEST] Returning cached data from ${latestKey}`);
    
    // Return the cached predictions
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300' // Cache for 5 minutes in browser
      },
      body: JSON.stringify({
        ...latestData,
        fromCache: true,
        cacheKey: latestKey
      })
    };
    
  } catch (error) {
    console.error('[LATEST] Error:', error);
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
