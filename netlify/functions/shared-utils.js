const { getStore } = require('@netlify/blobs');

/**
 * SHARED UTILITIES FOR GOLF PREDICTOR
 * Common functions used across multiple backend endpoints
 * Prevents code duplication and ensures consistency
 */

// ==================== BLOB STORE HELPERS ====================

/**
 * Get blob store with consistent configuration
 * Eliminates duplicate getStore setup code
 */
function getBlobStore(storeName, context = null) {
  const siteID = process.env.SITE_ID || context?.site?.id;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  
  if (!siteID || !token) {
    throw new Error(`Blob store not configured: missing ${!siteID ? 'SITE_ID' : 'NETLIFY_AUTH_TOKEN'}`);
  }
  
  return getStore({
    name: storeName,
    siteID: siteID,
    token: token,
    consistency: 'strong'
  });
}

// ==================== PLAYER NAME NORMALIZATION ====================

/**
 * Normalize player name for matching across data sources
 * Used by: get-predictions, get-avoid-picks, fetch-stats, fetch-odds
 */
function normalizePlayerName(name) {
  if (!name) return '';
  
  let normalized = name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  
  const parts = normalized.split(' ');
  return parts.sort().join(' ');
}

// ==================== ODDS FORMATTING ====================

/**
 * Format American odds with + or - prefix
 */
function formatAmericanOdds(odds) {
  if (!odds || odds === 0) return 'N/A';
  return odds > 0 ? `+${odds}` : `${odds}`;
}

/**
 * Convert American odds to decimal odds
 */
function americanToDecimal(americanOdds) {
  if (americanOdds > 0) {
    return (americanOdds / 100) + 1;
  } else {
    return (100 / Math.abs(americanOdds)) + 1;
  }
}

// ==================== COURSE ANALYSIS ====================

/**
 * Analyze course skill demands based on course characteristics
 * Used by: get-predictions, get-avoid-picks
 */
function analyzeCourseSkillDemands(courseInfo) {
  const demands = [];

  // Yardage analysis
  if (courseInfo.yardage) {
    if (courseInfo.yardage > 7500) {
      demands.push('1. SG:OTT (PRIMARY) - Extreme length demands elite driving distance and accuracy');
    } else if (courseInfo.yardage > 7300) {
      demands.push('1. SG:OTT (CRITICAL) - Long course heavily favors driving distance');
    } else if (courseInfo.yardage > 7100) {
      demands.push('1. SG:OTT (Important) - Above-average length requires solid driving');
    } else {
      demands.push('1. SG:APP + SG:ARG (PRIMARY) - Shorter course emphasizes precision over power');
    }
  }

  // Width analysis
  if (courseInfo.width) {
    const width = courseInfo.width.toLowerCase();
    if (width.includes('narrow') || width.includes('tight')) {
      demands.push('2. SG:APP (CRITICAL) - Narrow fairways require precision iron play and course management');
      demands.push('3. SG:ARG (Important) - Tight course means more scrambling opportunities');
    } else if (width.includes('wide') || width.includes('generous')) {
      demands.push('2. SG:OTT (Enhanced) - Wide fairways reward aggressive driving for distance');
      demands.push('3. SG:APP (Important) - Longer approaches from extra distance');
    }
  }

  // Rough analysis
  if (courseInfo.rough) {
    const rough = courseInfo.rough.toLowerCase();
    if (rough.includes('heavy') || rough.includes('thick') || rough.includes('penal')) {
      demands.push('4. SG:OTT (Accuracy) - Heavy rough severely punishes offline drives');
      demands.push('5. SG:ARG (Critical) - Recovery skills essential for scrambling');
    }
  }

  // Green analysis
  if (courseInfo.greens) {
    const greens = courseInfo.greens.toLowerCase();
    if (greens.includes('fast') || greens.includes('firm') || greens.includes('bentgrass')) {
      demands.push('6. SG:Putt (Enhanced) - Fast greens amplify putting skill differences');
    } else if (greens.includes('poa') || greens.includes('bumpy')) {
      demands.push('6. SG:APP (Critical) - Inconsistent greens demand precise approach distance control');
    }
  }

  // Difficulty analysis
  if (courseInfo.difficulty) {
    const difficulty = courseInfo.difficulty.toLowerCase();
    if (difficulty.includes('very difficult') || difficulty.includes('extremely')) {
      demands.push('7. SG:Total (Quality) - Difficult course requires well-rounded elite players');
    }
  }

  // Default if no specific demands identified
  if (demands.length === 0) {
    demands.push('1. SG:OTT (Important) - Driving quality sets up scoring opportunities');
    demands.push('2. SG:APP (Important) - Iron play for green-in-regulation');
    demands.push('3. SG:ARG (Moderate) - Short game for scrambling');
    demands.push('4. SG:Putt (Moderate) - Putting to convert scoring chances');
  }

  return demands.join('\n');
}

/**
 * Analyze weather conditions and their impact on play
 * Used by: get-predictions, get-avoid-picks
 */
function analyzeWeatherConditions(weatherSummary) {
  if (!weatherSummary || weatherSummary === 'Weather data not available') {
    return 'Weather data not available - focus purely on course characteristics and historical stats.';
  }

  // Parse weather summary to extract conditions
  const windSpeeds = [];
  const rainChances = [];
  let conditions = weatherSummary;

  // Extract wind speeds
  const windMatches = weatherSummary.match(/Wind:\s*(\d+)mph/g);
  if (windMatches) {
    windMatches.forEach(match => {
      const speed = parseInt(match.match(/\d+/)[0]);
      windSpeeds.push(speed);
    });
  }

  // Extract rain chances
  const rainMatches = weatherSummary.match(/Rain:\s*(\d+)%/g);
  if (rainMatches) {
    rainMatches.forEach(match => {
      const chance = parseInt(match.match(/\d+/)[0]);
      rainChances.push(chance);
    });
  }

  const avgWind = windSpeeds.length > 0 
    ? Math.round(windSpeeds.reduce((a, b) => a + b, 0) / windSpeeds.length) 
    : 0;
  const maxWind = windSpeeds.length > 0 ? Math.max(...windSpeeds) : 0;
  const highRainDays = rainChances.filter(r => r > 50).length;
  const anyRainDays = rainChances.filter(r => r > 30).length;

  let analysis = [`Raw Conditions: ${conditions}`, ''];

  // Wind analysis
  if (maxWind >= 15) {
    analysis.push(`⚠️ HIGH WIND ALERT (${maxWind}mph max, ${avgWind}mph avg):`);
    analysis.push('- CRITICAL: Prioritize SG:OTT (ball flight control, trajectory management)');
    analysis.push('- Secondary: SG:APP (wind-adjusted approach shots)');
    analysis.push('- Deprioritize: SG:Putt (less important when scores are high)');
    analysis.push('- Look for: Players with positive SG:OTT who are undervalued');
  } else if (avgWind >= 10) {
    analysis.push(`💨 MODERATE WIND (${avgWind}mph avg):`);
    analysis.push('- Important: SG:OTT (trajectory control matters)');
    analysis.push('- Balanced approach: All SG categories relevant');
  } else {
    analysis.push(`😌 CALM CONDITIONS (${avgWind}mph avg):`);
    analysis.push('- CRITICAL: SG:Putt (low scores, putting wins)');
    analysis.push('- Secondary: SG:APP (hitting greens for birdie chances)');
    analysis.push('- Deprioritize: SG:OTT (length advantage reduced when conditions are easy)');
  }

  // Rain analysis
  if (highRainDays >= 2) {
    analysis.push('');
    analysis.push(`🌧️ WET CONDITIONS (${highRainDays} days with 50%+ rain):`);
    analysis.push('- CRITICAL: SG:OTT (length advantage on soft fairways/greens)');
    analysis.push('- Important: SG:APP (wedge play, soft greens hold shots)');
    analysis.push('- Consider: SG:ARG (soft conditions around greens)');
    analysis.push('- Deprioritize: SG:Putt (soft greens are easier to putt)');
  } else if (anyRainDays > 0) {
    analysis.push('');
    analysis.push(`🌦️ SOME RAIN POSSIBLE (${anyRainDays} days with 30%+ chance):`);
    analysis.push('- Slight advantage: Longer hitters (SG:OTT)');
    analysis.push('- Monitor: Conditions may soften as week progresses');
  }

  return analysis.join('\n');
}

// ==================== COST CALCULATION ====================

/**
 * Calculate API cost for Claude usage
 * Sonnet 4: $3/M input tokens, $15/M output tokens
 */
function calculateClaudeCost(usage) {
  const inputCost = (usage.input_tokens / 1000000) * 3.00;
  const outputCost = (usage.output_tokens / 1000000) * 15.00;
  const totalCost = inputCost + outputCost;
  
  return {
    inputCost: inputCost,
    outputCost: outputCost,
    totalCost: totalCost,
    formatted: `$${totalCost.toFixed(4)}`
  };
}

// ==================== BLOB KEY GENERATION ====================

/**
 * Generate consistent blob key from tournament and date
 * Used for saving predictions, avoid picks, matchups
 */
function generateBlobKey(tournamentName, tour, timestamp) {
  const tournamentSlug = tournamentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  
  const date = new Date(timestamp);
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const timeStr = `${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`;
  
  return `${tour}-${tournamentSlug}-${dateStr}-${timeStr}`;
}

// ==================== CACHE VALIDATION ====================

/**
 * Generate a tournament-specific cache key for player data
 * Ensures cache is automatically invalidated when tournament changes
 */
function generatePlayerDataCacheKey(tour, tournamentName) {
  if (!tournamentName) return `player-data-${tour}`;
  const slug = tournamentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `player-data-${tour}-${slug}`;
}

/**
 * Validate that cached data matches the current tournament
 * Returns true if cache is valid (same tournament and not expired)
 */
function isCacheValidForTournament(cachedData, currentTournamentName, maxAgeMs = 12 * 60 * 60 * 1000) {
  if (!cachedData || !cachedData.timestamp) return false;
  
  // Check age
  const cacheAge = Date.now() - cachedData.timestamp;
  if (cacheAge >= maxAgeMs) {
    console.log(`[CACHE-VALIDATE] Cache expired (${Math.round(cacheAge / 1000 / 60 / 60)}h old)`);
    return false;
  }
  
  // Check tournament name match (if we have both)
  if (currentTournamentName && cachedData.tournament?.name) {
    const cachedName = cachedData.tournament.name.toLowerCase().trim();
    const currentName = currentTournamentName.toLowerCase().trim();
    if (cachedName !== currentName) {
      console.log(`[CACHE-VALIDATE] Tournament mismatch! Cached: "${cachedData.tournament.name}" vs Current: "${currentTournamentName}"`);
      return false;
    }
  }
  
  return true;
}

/**
 * Find the latest blob matching a specific tournament name
 * Used by get-latest-* functions to return data for the CURRENT tournament
 * Falls back to most recent blob if no tournament filter provided
 */
async function getLatestBlobForTournament(store, tour, tournamentName = null) {
  let blobs;
  try {
    const listResult = await store.list({ prefix: `${tour}-` });
    blobs = listResult.blobs;
  } catch (listError) {
    console.log(`[BLOB-FILTER] Failed to list blobs: ${listError.message}`);
    return null;
  }
  
  if (!blobs || blobs.length === 0) return null;
  
  // Sort by DATE portion of key (not tournament name!)
  // Key format: tour-tournament-slug-YYYY-MM-DD-HHMM
  // Extract date by matching the date pattern at the end
  const sortedBlobs = blobs.sort((a, b) => {
    const datePatternA = a.key.match(/(\d{4}-\d{2}-\d{2}-\d{4})$/);
    const datePatternB = b.key.match(/(\d{4}-\d{2}-\d{2}-\d{4})$/);
    const dateA = datePatternA ? datePatternA[1] : '0000-00-00-0000';
    const dateB = datePatternB ? datePatternB[1] : '0000-00-00-0000';
    return dateB.localeCompare(dateA); // Most recent first
  });
  
  console.log(`[BLOB-FILTER] Found ${sortedBlobs.length} blobs, newest: ${sortedBlobs[0].key}`);
  
  // If no tournament filter, just return the most recent valid blob
  if (!tournamentName) {
    for (const blob of sortedBlobs) {
      try {
        const data = await store.get(blob.key, { type: 'json' });
        if (data) return { data, key: blob.key };
      } catch (err) {
        console.log(`[BLOB-FILTER] Error reading blob ${blob.key}: ${err.message}`);
        continue;
      }
    }
    return null;
  }
  
  // With tournament filter: find matching blob
  for (const blob of sortedBlobs) {
    try {
      const data = await store.get(blob.key, { type: 'json' });
      if (!data) continue;
      
      const blobTournament = data.tournament?.name || data.tournamentName || '';
      if (blobTournament.toLowerCase().trim() === tournamentName.toLowerCase().trim()) {
        console.log(`[BLOB-FILTER] ✅ Found match: "${blobTournament}" in ${blob.key}`);
        return { data, key: blob.key };
      } else {
        console.log(`[BLOB-FILTER] Skipping "${blobTournament}" (looking for "${tournamentName}")`);
      }
    } catch (err) {
      console.log(`[BLOB-FILTER] Error reading blob ${blob.key}: ${err.message}`);
      continue;
    }
  }
  
  // Fallback: return most recent blob with isFallback flag
  console.log(`[BLOB-FILTER] No match for "${tournamentName}", falling back to most recent`);
  try {
    const data = await store.get(sortedBlobs[0].key, { type: 'json' });
    return data ? { data, key: sortedBlobs[0].key, fallback: true } : null;
  } catch (err) {
    return null;
  }
}

// ==================== EXPORTS ====================

module.exports = {
  // Blob store
  getBlobStore,
  
  // Player name
  normalizePlayerName,
  
  // Odds
  formatAmericanOdds,
  americanToDecimal,
  
  // Course analysis
  analyzeCourseSkillDemands,
  analyzeWeatherConditions,
  
  // Cost calculation
  calculateClaudeCost,
  
  // Blob keys
  generateBlobKey,
  
  // Cache validation (NEW)
  generatePlayerDataCacheKey,
  isCacheValidForTournament,
  getLatestBlobForTournament
};
