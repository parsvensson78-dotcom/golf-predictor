const Anthropic = require('@anthropic-ai/sdk');
const { getBlobStore, getLatestBlobForTournament, calculateClaudeCost } = require('./shared-utils');

/**
 * ANALYZE-RESULTS - Post-Tournament Self-Analysis
 * 
 * Claude reviews its own predictions against actual results and weather,
 * identifying what it got right, what went wrong, and why.
 * 
 * GET ?tournament=Memorial&tour=pga
 * 
 * Requires: completed tournament with results in blobs
 */

exports.handler = async (event, context) => {
  try {
    const params = event.queryStringParameters || {};
    const { tournament, tour = 'pga' } = params;
    const forceRefresh = params.refresh === 'true';

    if (!tournament) {
      return errorResponse('tournament parameter required', 400);
    }

    console.log(`[ANALYZE] Starting self-analysis for "${tournament}" (${tour})${forceRefresh ? ' (FORCE REFRESH)' : ''}`);

    // Check for cached analysis first
    const analysisStore = getBlobStore('analysis', context);
    const analysisKey = `self-analysis-${tour}-${tournament.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

    if (!forceRefresh) {
      try {
        const cached = await analysisStore.get(analysisKey, { type: 'json' });
        if (cached && cached.analysis) {
          console.log(`[ANALYZE] ✅ Returning cached analysis`);
          return successResponse({ ...cached, cached: true });
        }
      } catch (e) {
        // No cached analysis
      }
    }

    // Step 1: Get the original predictions
    const predStore = getBlobStore('predictions', context);
    const predResult = await getLatestBlobForTournament(predStore, tour, tournament);

    if (!predResult?.data) {
      return errorResponse(`No predictions found for "${tournament}"`, 404);
    }

    const predictions = predResult.data;
    console.log(`[ANALYZE] Found predictions: ${predictions.predictions?.length || 0} picks, generated ${predictions.generatedAt}`);

    // Step 2: Get actual results (from the results endpoint data)
    // We need the leaderboard data - fetch from get-prediction-results
    const baseUrl = process.env.URL || 'http://localhost:8888';
    let resultsData = null;

    try {
      const axios = require('axios');
      const resultsResponse = await axios.get(
        `${baseUrl}/.netlify/functions/get-prediction-results?tour=${tour}`,
        { timeout: 25000 }
      );
      resultsData = resultsResponse.data;
    } catch (err) {
      console.log(`[ANALYZE] Could not fetch results: ${err.message}`);
    }

    // Find the matching tournament in results
    let tournamentResults = null;
    if (resultsData?.tournaments) {
      tournamentResults = resultsData.tournaments.find(t => 
        t.tournament?.name?.toLowerCase().trim() === tournament.toLowerCase().trim()
      );
    }

    if (!tournamentResults || tournamentResults.status !== 'completed') {
      return errorResponse(`Tournament "${tournament}" not yet completed or results not available`, 404);
    }

    // Step 3: Get weather comparison data
    let weatherComparison = null;
    try {
      const weatherStore = getBlobStore('weather-cache', context);
      const tournamentSlug = tournament.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const historyKey = `weather-history-${tour}-${tournamentSlug}`;
      const weatherHistory = await weatherStore.get(historyKey, { type: 'json' });
      
      if (weatherHistory?.actual && weatherHistory?.forecasts?.length > 0) {
        weatherComparison = {
          forecast: weatherHistory.forecasts[0], // What model used
          actual: weatherHistory.actual,
          snapshotCount: weatherHistory.forecasts.length
        };
        console.log(`[ANALYZE] Found weather comparison data (${weatherHistory.forecasts.length} snapshots)`);
      }
    } catch (e) {
      console.log(`[ANALYZE] No weather comparison available: ${e.message}`);
    }

    // Step 4: Build the analysis prompt
    const prompt = buildAnalysisPrompt(predictions, tournamentResults, weatherComparison);

    // Step 5: Call Claude
    console.log(`[ANALYZE] Sending to Claude for self-analysis...`);
    const client = new Anthropic();

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText = message.content[0]?.text || '';
    console.log(`[ANALYZE] Got response (${responseText.length} chars)`);

    // Parse JSON response
    let analysis;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch (parseErr) {
      console.log(`[ANALYZE] JSON parse failed, using raw text`);
      analysis = {
        overallGrade: '?',
        summary: responseText.slice(0, 500),
        correctCalls: [],
        mistakes: [],
        weatherImpact: 'Could not parse structured analysis',
        lessonsLearned: [],
        adjustments: []
      };
    }

    const cost = calculateClaudeCost(message.usage);

    const result = {
      tournament: predictions.tournament,
      analysis,
      generatedAt: new Date().toISOString(),
      basedOn: {
        predictionsFrom: predictions.generatedAt,
        picksCount: predictions.predictions?.length || 0,
        hasWeatherComparison: !!weatherComparison
      },
      cost
    };

    // Cache the analysis
    try {
      await analysisStore.set(analysisKey, JSON.stringify(result));
      console.log(`[ANALYZE] ✅ Cached analysis`);
    } catch (e) {
      console.log(`[ANALYZE] Cache save failed: ${e.message}`);
    }

    return successResponse(result);

  } catch (error) {
    console.error('[ANALYZE] Fatal error:', error.message);
    return errorResponse(error.message, 500);
  }
};

/**
 * Build the self-analysis prompt
 */
function buildAnalysisPrompt(predictions, results, weatherComparison) {
  // Format original picks with reasoning
  const picksDetail = (predictions.predictions || []).map((pick, i) => {
    // Find this player's actual result
    let actualResult = 'Unknown';
    
    // Check value picks
    const valuePick = results.valueAnalysis?.picks?.find(p => 
      p.player?.toLowerCase() === pick.player?.toLowerCase()
    );
    if (valuePick) {
      actualResult = `Position: ${valuePick.position || 'N/A'}, Performance: ${valuePick.performance || 'N/A'}`;
    }

    // Also check raw valuePicks
    if (actualResult === 'Unknown') {
      const rawPick = results.valuePicks?.find(p => 
        p.player?.toLowerCase() === pick.player?.toLowerCase()
      );
      if (rawPick) {
        actualResult = `Found in picks but no result data`;
      }
    }

    return `Pick #${i + 1}: ${pick.player} (odds: ${pick.odds > 0 ? '+' : ''}${pick.odds})
Reasoning: ${pick.reasoning || 'No reasoning saved'}
ACTUAL RESULT: ${actualResult}`;
  }).join('\n\n');

  // Format avoid picks if available
  let avoidDetail = '';
  if (results.avoidPicks?.length > 0) {
    avoidDetail = '\n\nAVOID PICKS RESULTS:\n' + results.avoidPicks.map(p => {
      const analysis = results.avoidAnalysis?.picks?.find(ap => 
        ap.player?.toLowerCase() === p.player?.toLowerCase()
      );
      return `- ${p.player}: ${analysis ? `${analysis.position || 'N/A'} (${analysis.verdict || 'unknown'})` : 'No result'}`;
    }).join('\n');
  }

  // Format matchup results
  let matchupDetail = '';
  if (results.matchupAnalysis?.matchups?.length > 0) {
    matchupDetail = '\n\nMATCHUP RESULTS:\n' + results.matchupAnalysis.matchups.map(m => 
      `- ${m.pick} (${m.pickPosition}) vs ${m.opponent} (${m.opponentPosition}): ${m.result?.toUpperCase()}`
    ).join('\n');
  }

  // Format weather comparison
  let weatherSection = '';
  if (weatherComparison) {
    const forecast = weatherComparison.forecast;
    const actual = weatherComparison.actual;

    weatherSection = `\n\nWEATHER COMPARISON:
Forecast used by model (fetched ${forecast.fetchedAt}):
${forecast.summary || forecast.daily?.map(d => `${d.day}: ${d.tempHigh}°F, Wind: ${d.windSpeed}mph, Rain: ${d.chanceOfRain}%`).join(' | ') || 'N/A'}

Actual weather:
${actual.summary || actual.daily?.map(d => `${d.day}: ${d.tempHigh}°F, Wind: ${d.windSpeed}mph, Rain: ${d.chanceOfRain}%`).join(' | ') || 'N/A'}

Day-by-day deviations:
${(actual.daily || []).map((d, i) => {
  const f = forecast.daily?.[i];
  if (!f) return `${d.day}: No forecast to compare`;
  return `${d.day}: Temp ${f.tempHigh}°F→${d.tempHigh}°F (${d.tempHigh - f.tempHigh > 0 ? '+' : ''}${d.tempHigh - f.tempHigh}°F) | Wind ${f.windSpeed}→${d.windSpeed}mph (${d.windSpeed - f.windSpeed > 0 ? '+' : ''}${d.windSpeed - f.windSpeed}mph)`;
}).join('\n')}`;
  }

  // Format overall results summary
  const valueAnalysis = results.valueAnalysis || {};
  const overallSummary = `
OVERALL RESULTS:
- Value picks: ${valueAnalysis.wins || 0} wins, ${valueAnalysis.top5s || 0} top-5s, ${valueAnalysis.top10s || 0} top-10s, ${valueAnalysis.top20s || 0} top-20s, ${valueAnalysis.missedCut || 0} missed cuts
- ROI: ${valueAnalysis.totalROI !== undefined ? (valueAnalysis.totalROI >= 0 ? '+' : '') + '$' + valueAnalysis.totalROI.toFixed(0) : 'N/A'}
${results.matchupAnalysis ? `- Matchups: ${results.matchupAnalysis.wins || 0}W-${results.matchupAnalysis.losses || 0}L` : ''}
${results.avoidAnalysis ? `- Avoids: ${results.avoidAnalysis.correctAvoids || 0}/${results.avoidAnalysis.correctAvoids + results.avoidAnalysis.wrongAvoids || 0} correct` : ''}`;

  return `You are reviewing your OWN golf tournament predictions after the tournament has ended. Be honest and analytical about what you got right and wrong.

TOURNAMENT: ${predictions.tournament?.name || 'Unknown'}
Course: ${predictions.courseInfo?.courseName || predictions.courseInfo?.name || 'Unknown'} (${predictions.courseInfo?.yardage || '?'}y, Par ${predictions.courseInfo?.par || '?'})

YOUR ORIGINAL COURSE ANALYSIS:
${predictions.courseAnalysis?.type || 'N/A'}
Weather impact assessment: ${predictions.courseAnalysis?.weatherImpact || 'N/A'}
Key factors: ${(predictions.courseAnalysis?.keyFactors || []).join(', ') || 'N/A'}

YOUR ORIGINAL WEATHER DATA:
${predictions.weather || 'N/A'}

YOUR PICKS AND ACTUAL RESULTS:
${picksDetail}
${avoidDetail}
${matchupDetail}
${weatherSection}
${overallSummary}

Analyze your performance. Return JSON:
{
  "overallGrade": "A/B/C/D/F",
  "summary": "2-3 sentence overall assessment of how predictions performed",
  "correctCalls": [
    {"what": "Brief description of what you got right", "why": "Why this call worked"}
  ],
  "mistakes": [
    {"what": "Brief description of mistake", "why": "Root cause - be specific (wrong weather data, overweighted stat, ignored form, etc)", "severity": "high/medium/low"}
  ],
  "weatherImpact": "How much did weather forecast accuracy affect your picks? Be specific about which picks were impacted.",
  "lessonsLearned": [
    "Concrete lesson that should improve future predictions"
  ],
  "adjustments": [
    "Specific adjustment recommendation for the prediction model"
  ]
}

Be brutally honest. If weather was way off and affected picks, say so clearly. If certain statistical factors didn't translate to the course, explain why. Focus on actionable insights.`;
}

// ==================== HELPERS ====================

function successResponse(data) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
    body: JSON.stringify(data)
  };
}

function errorResponse(message, statusCode = 500) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: message })
  };
}
