const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

/**
 * Analyze prediction performance by comparing picks with actual results
 */
exports.handler = async (event, context) => {
  try {
    const baseUrl = process.env.URL || 'http://localhost:8888';

    console.log(`[ANALYSIS] Fetching saved predictions...`);

    // Get all saved predictions
    const predictionsDir = '/tmp/predictions';
    let predictionFiles = [];
    
    try {
      predictionFiles = await fs.readdir(predictionsDir);
    } catch (error) {
      console.log('[ANALYSIS] No predictions directory found');
      return createSuccessResponse({
        tournaments: [],
        message: 'No predictions saved yet'
      });
    }

    if (predictionFiles.length === 0) {
      return createSuccessResponse({
        tournaments: [],
        message: 'No predictions saved yet'
      });
    }

    console.log(`[ANALYSIS] Found ${predictionFiles.length} saved prediction files`);

    // Process each prediction file
    const tournaments = [];

    for (const filename of predictionFiles) {
      if (!filename.endsWith('.json')) continue;

      try {
        const filepath = path.join(predictionsDir, filename);
        const fileContent = await fs.readFile(filepath, 'utf8');
        const predictionData = JSON.parse(fileContent);

        console.log(`[ANALYSIS] Processing: ${predictionData.tournament.name}`);

        // Fetch tournament results
        const resultsResponse = await axios.post(`${baseUrl}/.netlify/functions/fetch-tournament-results`, {
          tournamentName: predictionData.tournament.name,
          tour: predictionData.tournament.tour,
          eventId: predictionData.tournament.eventId
        }, {
          timeout: 15000
        });

        const resultsData = resultsResponse.data;

        // Analyze performance if results are available
        let analysis = null;
        if (resultsData.status === 'completed' && resultsData.results.length > 0) {
          analysis = analyzePredictionPerformance(predictionData.predictions, resultsData.results);
        }

        tournaments.push({
          tournament: predictionData.tournament,
          predictions: predictionData.predictions,
          results: resultsData.results || [],
          analysis,
          status: resultsData.status || 'unknown',
          generatedAt: predictionData.metadata.generatedAt,
          filename
        });

      } catch (error) {
        console.error(`[ANALYSIS] Error processing ${filename}:`, error.message);
      }
    }

    // Sort by date (most recent first)
    tournaments.sort((a, b) => 
      new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime()
    );

    console.log(`[ANALYSIS] ✅ Processed ${tournaments.length} tournaments`);

    return createSuccessResponse({
      tournaments,
      totalPredictions: tournaments.reduce((sum, t) => sum + t.predictions.length, 0),
      completedTournaments: tournaments.filter(t => t.status === 'completed').length
    });

  } catch (error) {
    console.error('[ANALYSIS] Error:', error.message);
    return createErrorResponse(error.message);
  }
};

/**
 * Analyze prediction performance
 */
function analyzePredictionPerformance(predictions, results) {
  const analysis = {
    totalPicks: predictions.length,
    wins: 0,
    top5s: 0,
    top10s: 0,
    top20s: 0,
    madeCut: 0,
    missedCut: 0,
    notFound: 0,
    detailedPicks: []
  };

  for (const pick of predictions) {
    // Find player in results (normalize names for matching)
    const playerResult = results.find(r => 
      normalizePlayerName(r.player) === normalizePlayerName(pick.player)
    );

    if (!playerResult) {
      analysis.notFound++;
      analysis.detailedPicks.push({
        player: pick.player,
        odds: pick.odds,
        position: 'Not Found',
        performance: 'unknown'
      });
      continue;
    }

    // Extract position (handle "T5" format)
    const position = typeof playerResult.position === 'string' 
      ? parseInt(playerResult.position.replace(/[^0-9]/g, '')) 
      : playerResult.position;

    // Categorize performance
    let performance = 'missed-cut';
    if (position === 1) {
      analysis.wins++;
      performance = 'win';
    } else if (position <= 5) {
      analysis.top5s++;
      performance = 'top-5';
    } else if (position <= 10) {
      analysis.top10s++;
      performance = 'top-10';
    } else if (position <= 20) {
      analysis.top20s++;
      performance = 'top-20';
    } else if (position <= 70) {
      analysis.madeCut++;
      performance = 'made-cut';
    } else {
      analysis.missedCut++;
      performance = 'missed-cut';
    }

    analysis.detailedPicks.push({
      player: pick.player,
      odds: pick.odds,
      position: playerResult.position,
      score: playerResult.score,
      toPar: playerResult.toPar,
      performance,
      roi: calculateROI(pick.odds, performance)
    });
  }

  // Calculate overall ROI
  analysis.totalROI = analysis.detailedPicks.reduce((sum, p) => sum + (p.roi || 0), 0);
  analysis.avgROI = analysis.totalPicks > 0 ? analysis.totalROI / analysis.totalPicks : 0;

  return analysis;
}

/**
 * Calculate ROI for a pick
 * Assumes $100 bet on each pick
 */
function calculateROI(odds, performance) {
  const stake = 100;
  
  if (performance === 'win') {
    // Win: get back stake + (odds * stake)
    const payout = stake * odds;
    return payout - stake;
  }
  
  // Loss: lose stake
  return -stake;
}

/**
 * Normalize player name for matching
 */
function normalizePlayerName(name) {
  if (!name) return '';
  
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  return normalized.split(' ').sort().join(' ');
}

/**
 * Create success response
 */
function createSuccessResponse(data) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  };
}

/**
 * Create error response
 */
function createErrorResponse(message) {
  return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      error: 'Failed to analyze predictions',
      message 
    })
  };
}
