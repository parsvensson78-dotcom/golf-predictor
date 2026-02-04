const { getStore } = require('@netlify/blobs');

/**
 * Get Latest Matchups from Blobs
 * Returns the most recent saved matchup predictions for a tour
 */
exports.handler = async (event, context) => {
  try {
    const { tour = 'pga' } = event.queryStringParameters || {};
    
    console.log(`[LATEST-MATCHUP] Fetching latest matchups for ${tour}`);
    
    // Get Netlify Blobs store
    const siteID = process.env.SITE_ID || context.site?.id;
    const token = process.env.NETLIFY_AUTH_TOKEN;
    
    console.log(`[LATEST-MATCHUP] Config check:`, {
      hasSiteID: !!siteID,
      hasToken: !!token
    });
    
    if (!siteID || !token) {
      console.error('[LATEST-MATCHUP] Missing SITE_ID or NETLIFY_AUTH_TOKEN');
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'No cached matchups found',
          message: 'Blobs not configured or no matchups saved yet'
        })
      };
    }
    
    const store = getStore({
      name: 'matchups',
      siteID: siteID,
      token: token,
      consistency: 'strong'
    });
    
    console.log(`[LATEST-MATCHUP] Store created successfully`);
    
    // List all blobs for this tour
    const { blobs } = await store.list({ prefix: `${tour}-` });
    console.log(`[LATEST-MATCHUP] Found ${blobs?.length || 0} blobs for prefix "${tour}-"`);
    
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
