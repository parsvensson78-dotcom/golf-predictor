const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const {
  getBlobStore,
  normalizePlayerName,
  formatAmericanOdds,
  americanToDecimal,
  calculateClaudeCost,
  getLatestBlobForTournament
} = require('./shared-utils');

/**
 * GET-LIVE-PICKS - In-Tournament Live Value Picks
 * 
 * Uses DataGolf's live endpoints during active tournaments to:
 * 1. Get live finish probabilities (updated every 5 min)
 * 2. Get live SG stats for current tournament
 * 3. Compare with pre-tournament predictions
 * 4. Ask Claude for updated value picks based on live data
 * 
 * GET ?tour=pga
 * GET ?tour=pga&refresh=true  (bypass cache)
 */

const LIVE_CACHE_TTL_MS = 15 * 60 * 1000; // 15 min cache for live picks

exports.handler = async (event, context) => {
  try {
    const params = event.queryStringParameters || {};
    const tour = params.tour || 'pga';
    const forceRefresh = params.refresh === 'true';
    const apiKey = process.env.DATAGOLF_API_KEY || '07b56aee1a02854e9513b06af5cd';

    console.log(`[LIVE] Fetching live picks for ${tour.toUpperCase()}...`);

    // Check cache first
    if (!forceRefresh) {
      try {
        const store = getBlobStore('live-picks', context);
        const cached = await store.get(`live-${tour}-latest`, { type: 'json' });
        if (cached && cached.timestamp && (Date.now() - cached.timestamp < LIVE_CACHE_TTL_MS)) {
          const ageMin = Math.round((Date.now() - cached.timestamp) / 60000);
          console.log(`[LIVE] ✅ Cache hit (${ageMin} min old)`);
          return successResponse({ ...cached, cached: true, cacheAge: `${ageMin}min` });
        }
      } catch (e) {
        // No cache
      }
    }

    // Step 1: Fetch live in-play probabilities
    console.log('[LIVE] Fetching in-play probabilities...');
    let inPlayData = null;
    try {
      const inPlayResponse = await axios.get(
        `https://feeds.datagolf.com/preds/in-play?tour=${tour}&dead_heat=no&odds_format=american&file_format=json&key=${apiKey}`,
        { timeout: 10000 }
      );
      inPlayData = inPlayResponse.data;
      console.log(`[LIVE] In-play data: ${inPlayData?.data?.length || 0} players`);
    } catch (err) {
      console.log(`[LIVE] In-play fetch failed: ${err.message}`);
      return errorResponse('No live tournament data available. Tournament may not be in progress.', 404);
    }

    // Validate we have live data
    const players = inPlayData?.data || inPlayData?.players || inPlayData;
    if (!Array.isArray(players) || players.length === 0) {
      return errorResponse('No live tournament in progress or no data available.', 404);
    }

    const tournamentInfo = {
      name: inPlayData.event_name || inPlayData.tournament || 'Current Tournament',
      round: inPlayData.current_round || inPlayData.round || '?',
      course: inPlayData.course || '',
      status: inPlayData.status || 'in_progress'
    };

    console.log(`[LIVE] Tournament: ${tournamentInfo.name}, Round: ${tournamentInfo.round}`);

    // Step 2: Fetch live tournament stats (SG breakdown)
    console.log('[LIVE] Fetching live tournament stats...');
    let liveStats = {};
    try {
      const statsResponse = await axios.get(
        `https://feeds.datagolf.com/preds/live-tournament-stats?stats=sg_ott,sg_app,sg_arg,sg_putt,sg_total,sg_t2g&round=event_avg&display=value&file_format=json&key=${apiKey}`,
        { timeout: 10000 }
      );
      const statsData = statsResponse.data?.data || statsResponse.data?.players || statsResponse.data || [];
      if (Array.isArray(statsData)) {
        statsData.forEach(p => {
          const name = p.player_name || p.name || '';
          if (name) {
            liveStats[normalizePlayerName(name)] = {
              name,
              sgTotal: p.sg_total || 0,
              sgOTT: p.sg_ott || 0,
              sgAPP: p.sg_app || 0,
              sgARG: p.sg_arg || 0,
              sgPutt: p.sg_putt || 0,
              sgT2G: p.sg_t2g || 0
            };
          }
        });
        console.log(`[LIVE] Stats loaded for ${Object.keys(liveStats).length} players`);
      }
    } catch (err) {
      console.log(`[LIVE] Stats fetch failed: ${err.message}`);
    }

    // Step 3: Fetch live outright odds from books
    console.log('[LIVE] Fetching live betting odds...');
    let liveOdds = {};
    try {
      const oddsResponse = await axios.get(
        `https://feeds.datagolf.com/betting-tools/outrights?tour=${tour}&market=win&odds_format=american&file_format=json&key=${apiKey}`,
        { timeout: 10000 }
      );
      const oddsData = oddsResponse.data?.oddsData || oddsResponse.data || [];
      if (Array.isArray(oddsData)) {
        oddsData.forEach(p => {
          const name = p.player_name || p.name || '';
          if (name) {
            // Get best available odds across books
            const bookOdds = [];
            for (const [key, val] of Object.entries(p)) {
              if (key !== 'player_name' && key !== 'name' && key !== 'dg_id' && typeof val === 'number' && val !== 0) {
                bookOdds.push(val);
              }
            }
            if (bookOdds.length > 0) {
              liveOdds[normalizePlayerName(name)] = {
                name,
                bestOdds: Math.max(...bookOdds),
                dgOdds: p.datagolf || p.dg || null,
                bookCount: bookOdds.length
              };
            }
          }
        });
        console.log(`[LIVE] Odds loaded for ${Object.keys(liveOdds).length} players`);
      }
    } catch (err) {
      console.log(`[LIVE] Odds fetch failed: ${err.message}`);
    }

    // Step 4: Get original pre-tournament predictions for comparison
    let preTournamentPicks = [];
    try {
      const predStore = getBlobStore('predictions', context);
      const predResult = await getLatestBlobForTournament(predStore, tour, tournamentInfo.name);
      if (predResult?.data?.predictions) {
        preTournamentPicks = predResult.data.predictions;
        console.log(`[LIVE] Found ${preTournamentPicks.length} pre-tournament picks for comparison`);
      }
    } catch (e) {
      console.log('[LIVE] No pre-tournament picks found');
    }

    // Step 5: Build merged player data for Claude
    const mergedPlayers = buildMergedPlayerList(players, liveStats, liveOdds);
    console.log(`[LIVE] Merged data for ${mergedPlayers.length} players`);

    // Step 6: Build prompt and call Claude
    const prompt = buildLivePicksPrompt(tournamentInfo, mergedPlayers, preTournamentPicks);

    console.log('[LIVE] Sending to Claude...');
    const client = new Anthropic();
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const responseText = message.content[0]?.text || '';
    let livePicks;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      livePicks = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch (parseErr) {
      console.error('[LIVE] Parse failed:', parseErr.message);
      return errorResponse('Failed to parse AI response', 500);
    }

    const cost = calculateClaudeCost(message.usage);

    const result = {
      tournament: tournamentInfo,
      livePicks: livePicks?.picks || [],
      situationAnalysis: livePicks?.situationAnalysis || '',
      cutLineInsight: livePicks?.cutLineInsight || '',
      preTournamentComparison: livePicks?.preTournamentComparison || '',
      topMoverUp: livePicks?.topMoverUp || null,
      topMoverDown: livePicks?.topMoverDown || null,
      playerCount: mergedPlayers.length,
      generatedAt: new Date().toISOString(),
      timestamp: Date.now(),
      cost
    };

    // Save to cache
    try {
      const store = getBlobStore('live-picks', context);
      await store.set(`live-${tour}-latest`, JSON.stringify(result));
      console.log('[LIVE] ✅ Cached live picks');
    } catch (e) {
      console.log(`[LIVE] Cache save failed: ${e.message}`);
    }

    return successResponse(result);

  } catch (error) {
    console.error('[LIVE] Fatal error:', error.message);
    return errorResponse(error.message, 500);
  }
};

/**
 * Build merged player list from in-play + stats + odds
 */
function buildMergedPlayerList(inPlayPlayers, liveStats, liveOdds) {
  return inPlayPlayers
    .map(p => {
      const name = p.player_name || p.name || '';
      const normalized = normalizePlayerName(name);
      const stats = liveStats[normalized] || {};
      const odds = liveOdds[normalized] || {};

      return {
        name,
        // Position & score
        currentPosition: p.current_pos || p.position || '?',
        totalScore: p.total || p.score || p.total_to_par || '?',
        thru: p.thru || p.holes_completed || '?',
        currentRound: p.current_round_score || p.today || '?',
        // DG model probabilities
        winProb: p.win || p.win_prob || 0,
        top5Prob: p.top_5 || p.top5 || 0,
        top10Prob: p.top_10 || p.top10 || 0,
        top20Prob: p.top_20 || p.top20 || 0,
        makeCutProb: p.make_cut || p.mc || 0,
        // Live SG stats this tournament
        sgTotal: stats.sgTotal || 0,
        sgOTT: stats.sgOTT || 0,
        sgAPP: stats.sgAPP || 0,
        sgARG: stats.sgARG || 0,
        sgPutt: stats.sgPutt || 0,
        // Live odds
        bestBookOdds: odds.bestOdds || null,
        dgModelOdds: odds.dgOdds || null
      };
    })
    .filter(p => p.name) // Remove empty entries
    .sort((a, b) => {
      // Sort by current position (numerically)
      const posA = parseInt(String(a.currentPosition).replace(/[^0-9]/g, '')) || 999;
      const posB = parseInt(String(b.currentPosition).replace(/[^0-9]/g, '')) || 999;
      return posA - posB;
    });
}

/**
 * Build prompt for live in-tournament picks
 */
function buildLivePicksPrompt(tournament, players, preTournamentPicks) {
  // Format player data
  const formatPlayer = (p) => {
    const odds = p.bestBookOdds ? formatAmericanOdds(p.bestBookOdds) : 'N/A';
    const dgOdds = p.dgModelOdds ? formatAmericanOdds(p.dgModelOdds) : '';
    const oddsStr = dgOdds ? `Book:${odds} DG:${dgOdds}` : odds;
    
    return `${p.currentPosition}. ${p.name} (${p.totalScore}, R:${p.currentRound}, Thru:${p.thru}) | Win:${(p.winProb * 100).toFixed(1)}% T5:${(p.top5Prob * 100).toFixed(1)}% T10:${(p.top10Prob * 100).toFixed(1)}% T20:${(p.top20Prob * 100).toFixed(1)}% | SG: Total:${p.sgTotal.toFixed(2)} OTT:${p.sgOTT.toFixed(2)} APP:${p.sgAPP.toFixed(2)} ARG:${p.sgARG.toFixed(2)} P:${p.sgPutt.toFixed(2)} | Odds:${oddsStr}`;
  };

  const top30 = players.slice(0, 30).map(formatPlayer).join('\n');
  const rest = players.slice(30, 60).map(formatPlayer).join('\n');

  // Format pre-tournament picks for comparison
  let prePicksSection = '';
  if (preTournamentPicks.length > 0) {
    const prePickNames = preTournamentPicks.map(p => {
      const found = players.find(lp => normalizePlayerName(lp.name) === normalizePlayerName(p.player));
      const status = found ? `Currently: ${found.currentPosition} (${found.totalScore})` : 'Not found in field';
      return `- ${p.player} (pre-tournament odds: ${formatAmericanOdds(p.odds)}): ${status}`;
    }).join('\n');
    prePicksSection = `\nPRE-TOURNAMENT PICKS STATUS:\n${prePickNames}\n`;
  }

  return `You are a live golf betting analyst. A tournament is currently in progress. Analyze the live data and find VALUE bets for the remainder of the tournament.

TOURNAMENT: ${tournament.name} (Round ${tournament.round})
${prePicksSection}
LIVE LEADERBOARD + STATS + ODDS (sorted by current position):

TOP 30:
${top30}

CONTENDERS (31-60):
${rest}

ANALYSIS INSTRUCTIONS:
1. FIND VALUE: Compare DataGolf model probabilities with book odds. Where DG gives higher win/top5/top10 probability than the books imply, there's value.
2. LIVE SG TRENDS: Players with strong SG:APP and SG:T2G this week are likely to maintain performance. SG:Putt is more volatile round-to-round.
3. POSITION MATTERS: A player at T15 with elite SG:APP this week and +5000 odds may be much better value than a T5 player at +800.
4. CUT LINE: For round 2, identify make-cut value bets if applicable.
5. PRE-TOURNAMENT COMPARISON: Note which pre-tournament picks are tracking well and which have busted.

Find 2 live value picks:
- Pick 1: Best outright or top 5/10 value (player whose book odds significantly undervalue their DataGolf probability)
- Pick 2: Longshot or matchup value (deeper in the field or a head-to-head edge)

Return JSON:
{
  "situationAnalysis": "2-3 sentences on the current tournament situation, who's in control, conditions, and key trends",
  "cutLineInsight": "1-2 sentences on cut line situation (if round 1-2) or weekend projection (if round 3-4)",
  "preTournamentComparison": "How are our pre-tournament picks doing? 1-2 sentences",
  "topMoverUp": {"player": "Name", "reason": "Why they're surging"},
  "topMoverDown": {"player": "Name", "reason": "Why they're fading"},
  "picks": [
    {
      "player": "Name",
      "type": "outright_value|top10_value|longshot|matchup",
      "currentPosition": "T5",
      "currentScore": "-8",
      "bookOdds": 2500,
      "dgProbability": "8.2%",
      "impliedProbability": "3.8%",
      "edge": "4.4%",
      "reasoning": "2-3 sentences: What live data supports this pick, why the market is wrong, specific SG trend backing the pick"
    }
  ]
}`;
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
