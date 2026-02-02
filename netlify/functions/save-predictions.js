const fs = require('fs').promises;
const path = require('path');

/**
 * Save predictions for post-tournament analysis
 * Stores predictions in a JSON file with tournament metadata
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

    // Create predictions directory if it doesn't exist
    const predictionsDir = '/tmp/predictions';
    await fs.mkdir(predictionsDir, { recursive: true });

    // Generate filename from tournament name and date
    const tournamentSlug = tournament.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    
    const date = new Date(generatedAt);
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    
    const filename = `${tournamentSlug}-${dateStr}.json`;
    const filepath = path.join(predictionsDir, filename);

    // Prepare data to save
    const predictionData = {
      tournament: {
        name: tournament.name,
        course: tournament.course,
        location: tournament.location,
        dates: tournament.dates,
        tour: tournament.tour,
        eventId: tournament.event_id
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
        status: 'pending' // pending, in-progress, completed
      }
    };

    // Save to file
    await fs.writeFile(filepath, JSON.stringify(predictionData, null, 2), 'utf8');

    console.log(`[SAVE] ✅ Saved to ${filename}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        filename,
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
