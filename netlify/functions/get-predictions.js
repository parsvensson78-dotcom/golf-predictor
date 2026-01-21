/**
 * Builds optimized prompt for Claude - focuses on VALUE and COURSE FIT
 */
function buildClaudePrompt(tournament, players, weather) {
  // Split players into tiers
  const favorites = players.slice(0, 15);
  const midTier = players.slice(15, 50);
  const longshots = players.slice(50);

  return `You are a professional golf analyst specializing in finding VALUE picks based on course fit, NOT favorites.

TOURNAMENT:
Name: ${tournament.name}
Course: ${tournament.course}
Location: ${tournament.location}
Weather: ${weather}

COMPLETE FIELD (${players.length} players):

TOP FAVORITES (odds 5-25) - GENERALLY AVOID UNLESS EXCEPTIONAL VALUE:
${favorites.map(p => `${p.name} [${p.odds}] - Rank:${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt})`).join('\n')}

MID-TIER VALUE ZONE (odds 25-100) - FOCUS HERE:
${midTier.map(p => `${p.name} [${p.odds}] - Rank:${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt})`).join('\n')}

LONGSHOTS (odds 100+) - CONSIDER IF COURSE FIT IS EXCELLENT:
${longshots.map(p => `${p.name} [${p.odds}] - Rank:${p.rank||'?'} | SG:${p.sgTotal} (OTT:${p.sgOTT} APP:${p.sgAPP} ARG:${p.sgARG} Putt:${p.sgPutt})`).join('\n')}

CRITICAL ANALYSIS FRAMEWORK:

1. COURSE TYPE IDENTIFICATION:
   - What type of course is this? (Links, parkland, desert, target golf, etc.)
   - What skills does THIS course reward most?
   - Examples:
     * Pebble Beach (links) = SG: OTT + ARG + Wind play
     * Augusta (target golf) = SG: APP + ARG + Distance
     * TPC Sawgrass (precision) = SG: APP + Putt + Strategy

2. WEATHER IMPACT:
   - Current weather: ${weather}
   - How does this affect play? (wind = ball striking, rain = short game, etc.)
   - Which stats become MORE important in these conditions?

3. VALUE IDENTIFICATION - DO NOT PICK OBVIOUS FAVORITES:
   - Find players with ELITE course-fit stats but OVERLOOKED odds
   - Look for: Mid-tier players (odds 30-80) with top-10 stats in key areas
   - Example: Player ranked 40th with odds of 60-1 but #5 in SG: APP at a precision course = HUGE VALUE

4. AVOID:
   - Do NOT pick anyone with odds under 20 unless they have historically DOMINATED this course
   - Do NOT pick based on world ranking alone
   - Do NOT pick big names without course fit evidence

YOUR TASK:
Select exactly 3 VALUE picks where:
- At least 2 players should have odds ABOVE 30
- Players must have statistical evidence of course fit
- Focus on SPECIALISTS who excel in this course's required skills
- Consider weather conditions in your analysis

Return ONLY valid JSON (no markdown):
{
  "picks": [
    {
      "player": "Player Name",
      "odds": 45.0,
      "reasoning": "Specific course-fit analysis: which SG stats match this course, why they're undervalued, how weather helps them. 2-3 sentences max."
    }
  ],
  "courseType": "Brief description of what this course rewards",
  "weatherImpact": "How weather affects play today"
}

Be specific with numbers. Example: "Ranks #3 in SG: APP (1.2) which is critical for this target-golf layout. At 55-1 odds despite elite approach play, he's severely underpriced."`;
}
