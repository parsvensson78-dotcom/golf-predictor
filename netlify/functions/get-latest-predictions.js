const { getStore } = require('@netlify/blobs');

/**
 * Get Latest Predictions from Blobs
 * Returns the most recent saved predictions for a tour
 */
exports.handler = async (event, context) => {
  try {
    const { tour = 'pga' } = event.queryStringParameters || {};
    
    console.log(`[LATEST] Fetching latest predictions for ${tour}`);
    
    // Get Netlify Blobs store (same approach as get-predictions.js)
    // Note: We don't check process.env.NETLIFY as it's not always set
    const siteID = process.env.SITE_ID || context.site?.id;
    const token = process.env.NETLIFY_AUTH_TOKEN;
    
    console.log(`[LATEST] Config check:`, {
      hasSiteID: !!siteID,
      hasToken: !!token,
      deployId: context.deployId || 'N/A'
    });
    
    if (!siteID || !token) {
      console.error('[LATEST] Missing SITE_ID or NETLIFY_AUTH_TOKEN');
      return {
        statusCode: 503,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'Blobs not configured',
          message: 'SITE_ID or NETLIFY_AUTH_TOKEN not configured'
        })
      };
    }
    
    let store;
    try {
      store = getStore({
        name: 'predictions',
        siteID: siteID,
        token: token,
        consistency: 'strong'
      });
      console.log(`[LATEST] Store created successfully`);
    } catch (storeError) {
      console.error(`[LATEST] Failed to create store:`, storeError);
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
      console.log(`[LATEST] Found ${blobs?.length || 0} blobs for prefix "${tour}-"`);
    } catch (listError) {
      console.error(`[LATEST] Failed to list blobs:`, listError);
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
      console.log(`[LATEST] No cached predictions found for ${tour}`);
      return {
        statusCode: 404, // 404 so frontend knows it's just "not found" not "error"
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
    
    // Return the cached predictions with generatedAt at top level for frontend
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300' // Cache for 5 minutes in browser
      },
      body: JSON.stringify({
        ...latestData,
        generatedAt: latestData.metadata?.generatedAt || latestData.generatedAt, // Ensure generatedAt at top level
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
