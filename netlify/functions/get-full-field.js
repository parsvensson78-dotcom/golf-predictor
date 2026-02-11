const axios = require('axios');

/**
 * Fetch COMPLETE tournament field from DataGolf field-updates endpoint
 * Returns all players (typically 120-156) with names and DG IDs
 * Lightweight - no stats, odds, or analysis
 */
exports.handler = async (event, context) => {
  try {
    const tour = event.queryStringParameters?.tour || 'pga';
    const apiKey = process.env.DATAGOLF_API_KEY || '07b56aee1a02854e9513b06af5cd';
    const apiTour = tour === 'dp' ? 'euro' : tour;

    const url = `https://feeds.datagolf.com/field-updates?tour=${apiTour}&file_format=json&key=${apiKey}`;
    
    console.log(`[FIELD] Fetching complete field for ${apiTour} tour`);
    
    const response = await axios.get(url, { timeout: 10000 });
    
    if (!response.data?.field) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          tournament: response.data?.event_name || 'Unknown',
          field: [],
          count: 0
        })
      };
    }

    const players = response.data.field
      .filter(p => p.player_name)
      .map(p => ({
        name: p.player_name,
        dgId: p.dg_id,
        country: p.country || null
      }));

    console.log(`[FIELD] ✅ ${players.length} players in field for ${response.data.event_name}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tournament: response.data.event_name,
        field: players,
        count: players.length
      })
    };

  } catch (error) {
    console.error('[FIELD] Error:', error.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message })
    };
  }
};
