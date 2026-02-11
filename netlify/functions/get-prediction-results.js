const { getBlobStore, normalizePlayerName, americanToDecimal } = require('./shared-utils');
const axios = require('axios');

/**
 * Analyze ALL prediction performance - Value Picks, Avoid Picks, and Matchups
 * Reads saved data from Netlify Blobs across all three stores
 * Returns grouped by tournament with results for each category
 */
exports.handler = async (event, context) => {
  try {
    const tour = event.queryStringParameters?.tour || 'pga';
    const baseUrl = process.env.URL || 'http://localhost:8888';

    console.log(`[RESULTS] Fetching all saved data for ${tour} tour...`);

    // Fetch blobs from all three stores in parallel
    let predictionBlobs = [];
    let avoidBlobs = [];
    let matchupBlobs = [];

    try {
      const predStore = getBlobStore('predictions', context);
      const avoidStore = getBlobStore('avoid-picks', context);
      const matchupStore = getBlobStore('matchups', context);

      const [predList, avoidList, matchupList] = await Promise.all([
        predStore.list({ prefix: `${tour}-` }).catch(() => ({ blobs: [] })),
        avoidStore.list({ prefix: `${tour}-` }).catch(() => ({ blobs: [] })),
        matchupStore.list({ prefix: `${tour}-` }).catch(() => ({ blobs: [] }))
      ]);

      predictionBlobs = predList.blobs || [];
      avoidBlobs = avoidList.blobs || [];
      matchupBlobs = matchupList.blobs || [];

      console.log(`[RESULTS] Found blobs - Predictions: ${predictionBlobs.length}, Avoid: ${avoidBlobs.length}, Matchups: ${matchupBlobs.length}`);
    } catch (blobError) {
      console.error('[RESULTS] Blob storage error:', blobError.message);
      return createSuccessResponse({
        tournaments: [],
        summary: { totalTournaments: 0, completedTournaments: 0 },
        message: 'Blob storage not configured yet.'
      });
    }

    if (predictionBlobs.length === 0 && avoidBlobs.length === 0 && matchupBlobs.length === 0) {
      return createSuccessResponse({
        tournaments: [],
        summary: { totalTournaments: 0, completedTournaments: 0 },
        message: `No data saved yet for ${tour.toUpperCase()} tour.`
      });
    }

    // Load all blob data and group by tournament name
    const tournamentMap = {};

    const loadBlobs = async (storeName, blobs, category) => {
      const store = getBlobStore(storeName, context);
      for (const blob of blobs) {
        try {
          const data = await store.get(blob.key, { type: 'json' });
          if (!data || !data.tournament?.name) continue;

          const name = data.tournament.name;
          if (!tournamentMap[name]) {
            tournamentMap[name] = {
              tournament: data.tournament,
              generatedAt: data.generatedAt || data.metadata?.generatedAt,
              predictions: [],
              avoidPicks: [],
              matchups: []
            };
          }

          // Track most recent timestamp
          const dataTime = new Date(data.generatedAt || data.metadata?.generatedAt || 0).getTime();
          const existingTime = new Date(tournamentMap[name].generatedAt || 0).getTime();
          if (dataTime > existingTime) {
            tournamentMap[name].generatedAt = data.generatedAt || data.metadata?.generatedAt;
          }

          // MERGE all unique players from all blobs (not just first blob)
          if (category === 'predictions') {
            const newPicks = data.predictions || [];
            for (const pick of newPicks) {
              const isDuplicate = tournamentMap[name].predictions.some(existing =>
                normalizePlayerName(existing.player) === normalizePlayerName(pick.player)
              );
              if (!isDuplicate) {
                tournamentMap[name].predictions.push(pick);
              }
            }
          } else if (category === 'avoidPicks') {
            const newPicks = data.avoidPicks || [];
            for (const pick of newPicks) {
              const isDuplicate = tournamentMap[name].avoidPicks.some(existing =>
                normalizePlayerName(existing.player) === normalizePlayerName(pick.player)
              );
              if (!isDuplicate) {
                tournamentMap[name].avoidPicks.push(pick);
              }
            }
          } else if (category === 'matchups') {
            const newMatchups = data.suggestedMatchups || [];
            for (const matchup of newMatchups) {
              // Dedupe matchups by pick name + opponent name
              const pickName = matchup.pick || '';
              const opponentName = matchup.playerA?.name === pickName ? matchup.playerB?.name : matchup.playerA?.name;
              const isDuplicate = tournamentMap[name].matchups.some(existing => {
                const existPick = existing.pick || '';
                const existOpp = existing.playerA?.name === existPick ? existing.playerB?.name : existing.playerA?.name;
                return normalizePlayerName(existPick) === normalizePlayerName(pickName) &&
                       normalizePlayerName(existOpp) === normalizePlayerName(opponentName);
              });
              if (!isDuplicate) {
                tournamentMap[name].matchups.push(matchup);
              }
            }
          }
        } catch (err) {
          console.log(`[RESULTS] Error reading ${category} blob ${blob.key}: ${err.message}`);
        }
      }
    };

    await Promise.all([
      loadBlobs('predictions', predictionBlobs, 'predictions'),
      loadBlobs('avoid-picks', avoidBlobs, 'avoidPicks'),
      loadBlobs('matchups', matchupBlobs, 'matchups')
    ]);

    console.log(`[RESULTS] Found ${Object.keys(tournamentMap).length} unique tournaments`);
    
    // Log merged counts
    for (const [name, tData] of Object.entries(tournamentMap)) {
      console.log(`[RESULTS] "${name}" - ${tData.predictions.length} value picks, ${tData.avoidPicks.length} avoid picks, ${tData.matchups.length} matchups`);
    }

    // For each tournament, fetch results and analyze
    const tournaments = [];

    for (const [tournamentName, tData] of Object.entries(tournamentMap)) {
      try {
        console.log(`[RESULTS] Fetching results for: ${tournamentName}`);

        const resultsResponse = await axios.post(`${baseUrl}/.netlify/functions/fetch-tournament-results`, {
          tournamentName: tData.tournament.name,
          tour: tData.tournament.tour,
          eventId: tData.tournament.eventId
        }, { timeout: 15000 });

        const resultsData = resultsResponse.data;
        const results = resultsData.results || [];
        const isCompleted = resultsData.status !== 'not_completed' && results.length > 0;

        // Skip tournaments that haven't started or are still in progress
        if (!isCompleted) {
          console.log(`[RESULTS] Skipping "${tournamentName}" - not yet completed`);
          continue;
        }

        let valueAnalysis = null;
        let avoidAnalysis = null;
        let matchupAnalysis = null;

        if (tData.predictions?.length > 0) {
          valueAnalysis = analyzeValuePicks(tData.predictions, results);
        }
        if (tData.avoidPicks?.length > 0) {
          avoidAnalysis = analyzeAvoidPicks(tData.avoidPicks, results);
        }
        if (tData.matchups?.length > 0) {
          matchupAnalysis = analyzeMatchups(tData.matchups, results);
        }

        tournaments.push({
          tournament: tData.tournament,
          generatedAt: tData.generatedAt,
          status: 'completed',
          valuePicks: tData.predictions || [],
          avoidPicks: tData.avoidPicks || [],
          matchups: tData.matchups || [],
          valueAnalysis,
          avoidAnalysis,
          matchupAnalysis
        });

      } catch (error) {
        console.error(`[RESULTS] Error processing ${tournamentName}:`, error.message);
        tournaments.push({
          tournament: tData.tournament,
          generatedAt: tData.generatedAt,
          status: 'error',
          valuePicks: tData.predictions || [],
          avoidPicks: tData.avoidPicks || [],
          matchups: tData.matchups || [],
          valueAnalysis: null,
          avoidAnalysis: null,
          matchupAnalysis: null
        });
      }
    }

    // Sort by date (most recent first)
    tournaments.sort((a, b) =>
      new Date(b.generatedAt || 0).getTime() - new Date(a.generatedAt || 0).getTime()
    );

    // Summary stats
    const completedTournaments = tournaments.filter(t => t.status === 'completed').length;
    let overallROI = 0;
    let totalBets = 0;
    let matchupWins = 0;
    let matchupTotal = 0;
    let avoidCorrect = 0;
    let avoidTotal = 0;

    tournaments.forEach(t => {
      if (t.valueAnalysis) {
        overallROI += t.valueAnalysis.totalROI;
        totalBets += t.valueAnalysis.totalPicks;
      }
      if (t.matchupAnalysis) {
        matchupWins += t.matchupAnalysis.wins;
        matchupTotal += t.matchupAnalysis.totalMatchups;
      }
      if (t.avoidAnalysis) {
        avoidCorrect += t.avoidAnalysis.correctAvoids;
        avoidTotal += t.avoidAnalysis.totalPicks;
      }
    });

    console.log(`[RESULTS] ✅ Processed ${tournaments.length} tournaments`);

    return createSuccessResponse({
      tournaments,
      summary: {
        totalTournaments: tournaments.length,
        completedTournaments,
        overallROI,
        totalBets,
        matchupRecord: { wins: matchupWins, total: matchupTotal },
        avoidRecord: { correct: avoidCorrect, total: avoidTotal }
      }
    });

  } catch (error) {
    console.error('[RESULTS] Error:', error.message);
    return createErrorResponse(error.message);
  }
};

// ==================== ANALYSIS FUNCTIONS ====================

function analyzeValuePicks(predictions, results) {
  const analysis = {
    totalPicks: predictions.length,
    wins: 0, top5s: 0, top10s: 0, top20s: 0,
    madeCut: 0, missedCut: 0, notFound: 0,
    totalROI: 0,
    picks: []
  };

  for (const pick of predictions) {
    const playerResult = findPlayer(pick.player, results);
    const position = playerResult ? parsePosition(playerResult.position) : null;
    let performance = 'not-found';
    let roi = -100;

    if (!playerResult) {
      analysis.notFound++;
    } else if (position === 1) {
      analysis.wins++;
      performance = 'win';
      const dec = americanToDecimal(pick.odds);
      roi = dec ? (100 * dec) - 100 : 0;
    } else if (position <= 5) {
      analysis.top5s++;
      performance = 'top-5';
    } else if (position <= 10) {
      analysis.top10s++;
      performance = 'top-10';
    } else if (position <= 20) {
      analysis.top20s++;
      performance = 'top-20';
    } else if (position <= 65) {
      analysis.madeCut++;
      performance = 'made-cut';
    } else {
      analysis.missedCut++;
      performance = 'missed-cut';
    }

    analysis.totalROI += roi;
    analysis.picks.push({
      player: pick.player,
      odds: pick.odds,
      position: playerResult?.position || 'N/A',
      performance,
      roi
    });
  }

  return analysis;
}

function analyzeAvoidPicks(avoidPicks, results) {
  const analysis = {
    totalPicks: avoidPicks.length,
    correctAvoids: 0,
    wrongAvoids: 0,
    picks: []
  };

  for (const pick of avoidPicks) {
    const playerResult = findPlayer(pick.player, results);
    const position = playerResult ? parsePosition(playerResult.position) : null;
    let verdict = 'correct';

    if (playerResult && position && position <= 20) {
      analysis.wrongAvoids++;
      verdict = 'wrong';
    } else {
      analysis.correctAvoids++;
    }

    analysis.picks.push({
      player: pick.player,
      odds: pick.odds,
      position: playerResult?.position || 'MC/WD',
      verdict
    });
  }

  return analysis;
}

function analyzeMatchups(matchups, results) {
  const analysis = {
    totalMatchups: matchups.length,
    wins: 0, losses: 0, pushes: 0,
    matchups: []
  };

  for (const m of matchups) {
    const pickName = m.pick;
    const otherName = m.playerA?.name === pickName ? m.playerB?.name : m.playerA?.name;
    const pickPos = parsePosition(findPlayer(pickName, results)?.position);
    const otherPos = parsePosition(findPlayer(otherName, results)?.position);

    let result = 'push';
    if (pickPos < otherPos) { analysis.wins++; result = 'win'; }
    else if (pickPos > otherPos) { analysis.losses++; result = 'loss'; }
    else { analysis.pushes++; }

    analysis.matchups.push({
      pick: pickName,
      pickPosition: findPlayer(pickName, results)?.position || 'MC/WD',
      opponent: otherName,
      opponentPosition: findPlayer(otherName, results)?.position || 'MC/WD',
      result
    });
  }

  return analysis;
}

// ==================== HELPERS ====================

function findPlayer(name, results) {
  return results.find(r => normalizePlayerName(r.player) === normalizePlayerName(name));
}

function parsePosition(pos) {
  if (!pos) return 999;
  if (typeof pos === 'number') return pos;
  const num = parseInt(String(pos).replace(/[^0-9]/g, ''));
  return isNaN(num) ? 999 : num;
}

function createSuccessResponse(data) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  };
}

function createErrorResponse(message) {
  return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Failed to analyze results', message })
  };
}
