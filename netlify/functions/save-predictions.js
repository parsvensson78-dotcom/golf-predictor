const { getStore } = require('@netlify/blobs');

/**
 * Save predictions using Netlify Blobs for persistent storage
 * Note: Predictions are now automatically saved by get-predictions.js
 * This endpoint is kept for manual saves if needed
 */
exports.handler = async (event, context) => {
  try {
    const { tournament, predictions, courseInfo, weather, generatedAt } = JSON.parse(event.body);

    if (!tournament || !predictions) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Tournament and predictions required' })
      };
    }

    console.log(`[SAVE] Saving predictions for ${tournament.name}`);

    // Get Netlify Blobs store
    const store = getStore('predictions');

    // Generate key from tournament name and date
    const tournamentSlug = tournament.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    
    const date = new Date(generatedAt);
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    
    const key = `${tournamentSlug}-${dateStr}`;

    // Prepare data to save
    const predictionData = {
      tournament: {
        name: tournament.name,
        course: tournament.course,
        location: tournament.location,
        dates: tournament.dates,
        tour: tournament.tour,
        eventId: tournament.eventId
      },
      courseInfo: {
        par: courseInfo?.par,
        yardage: courseInfo?.yardage,
        difficulty: courseInfo?.difficulty
      },
      weather: weather,
      predictions: predictions.map(pick => ({
        player: pick.player,
        odds: pick.odds,
        minOdds: pick.minOdds,
        maxOdds: pick.maxOdds,
        bestBookmaker: pick.bestBookmaker,
        reasoning: pick.reasoning
      })),
      metadata: {
        generatedAt,
        savedAt: new Date().toISOString(),
        pickCount: predictions.length,
        status: 'pending'
      }
    };

    // Save to Netlify Blobs
    await store.set(key, JSON.stringify(predictionData));

    console.log(`[SAVE] ✅ Saved to blob: ${key}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        key,
        message: 'Predictions saved successfully'
      })
    };

  } catch (error) {
    console.error('[SAVE] Error:', error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: 'Failed to save predictions',
        message: error.message 
      })
    };
  }
};
