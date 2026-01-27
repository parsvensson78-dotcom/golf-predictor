/**
 * Find current or upcoming tournament from schedule
 * Improved logic to handle DataGolf's schedule format
 */
function findCurrentTournament(schedule, now) {
  // Convert schedule to array if needed
  const tournaments = Array.isArray(schedule) ? schedule : Object.values(schedule);
  
  console.log(`[TOURNAMENT] Analyzing ${tournaments.length} tournaments`);
  
  // DEBUG: Log first tournament to see date format
  if (tournaments.length > 0) {
    console.log(`[TOURNAMENT] Sample tournament:`, JSON.stringify(tournaments[0], null, 2));
  }
  
  // Parse dates more robustly - DataGolf might use various formats
  const parseDate = (dateStr) => {
    if (!dateStr) return null;
    
    try {
      // Try direct parsing first
      let parsed = new Date(dateStr);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
      
      // Try YYYY-MM-DD format
      if (typeof dateStr === 'string' && dateStr.includes('-')) {
        const parts = dateStr.split('-');
        if (parts.length === 3) {
          parsed = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
          if (!isNaN(parsed.getTime())) {
            return parsed;
          }
        }
      }
      
      return null;
    } catch (e) {
      console.error(`[TOURNAMENT] Error parsing date "${dateStr}":`, e.message);
      return null;
    }
  };
  
  // Filter and parse tournaments with valid dates
  const validTournaments = tournaments.map(t => {
    const startDate = parseDate(t.date || t.start_date);
    // DataGolf doesn't provide end_date, so calculate it (tournaments are typically 4 days)
    const endDate = startDate ? new Date(startDate.getTime() + 3 * 24 * 60 * 60 * 1000) : null;
    
    return {
      ...t,
      _startDate: startDate,
      _endDate: endDate,
      // Add calculated end_date to the object so it can be used later
      end_date: endDate ? endDate.toISOString().split('T')[0] : null
    };
  }).filter(t => t._startDate !== null);
  
  console.log(`[TOURNAMENT] ${validTournaments.length} tournaments with valid dates`);
  
  if (validTournaments.length === 0) {
    console.error('[TOURNAMENT] No tournaments with valid dates found');
    return null;
  }
  
  // Sort by start date
  const sorted = validTournaments.sort((a, b) => {
    return a._startDate - b._startDate;
  });
  
  // Strategy 1: Find tournament happening NOW (started but not ended)
  for (const tournament of sorted) {
    if (tournament._startDate <= now && tournament._endDate >= now) {
      console.log(`[TOURNAMENT] Found IN PROGRESS: ${tournament.event_name}`);
      console.log(`[TOURNAMENT] Start: ${tournament._startDate.toISOString()}, End: ${tournament._endDate.toISOString()}`);
      return tournament;
    }
  }

  // Strategy 2: Find next upcoming tournament (within next 14 days)
  const fourteenDaysFromNow = new Date(now);
  fourteenDaysFromNow.setDate(fourteenDaysFromNow.getDate() + 14);
  
  for (const tournament of sorted) {
    // Tournament starts in the future but within 14 days
    if (tournament._startDate > now && tournament._startDate <= fourteenDaysFromNow) {
      console.log(`[TOURNAMENT] Found UPCOMING (within 14 days): ${tournament.event_name}`);
      console.log(`[TOURNAMENT] Starts: ${tournament._startDate.toISOString()}, Ends: ${tournament._endDate.toISOString()}`);
      return tournament;
    }
  }

  // Strategy 3: Find tournament that ended recently (within last 7 days)
  // This is for post-tournament but pre-next-tournament period
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  
  for (let i = sorted.length - 1; i >= 0; i--) {
    const tournament = sorted[i];
    if (tournament._endDate >= sevenDaysAgo && tournament._endDate < now) {
      console.log(`[TOURNAMENT] Found RECENTLY ENDED: ${tournament.event_name}`);
      console.log(`[TOURNAMENT] Ended: ${tournament._endDate.toISOString()}`);
      return tournament;
    }
  }

  // Strategy 4: Just get the next tournament in the future
  const nextTournament = sorted.find(t => t._startDate > now);
  
  if (nextTournament) {
    console.log(`[TOURNAMENT] Found NEXT FUTURE: ${nextTournament.event_name}`);
    console.log(`[TOURNAMENT] Starts: ${nextTournament._startDate.toISOString()}, Ends: ${nextTournament._endDate.toISOString()}`);
    return nextTournament;
  }

  // Strategy 5: Fallback - return last tournament in sorted list (most recent)
  const lastTournament = sorted[sorted.length - 1];
  console.log(`[TOURNAMENT] Using FALLBACK (most recent): ${lastTournament?.event_name || 'None'}`);
  if (lastTournament) {
    console.log(`[TOURNAMENT] Dates: ${lastTournament._startDate.toISOString()} - ${lastTournament._endDate.toISOString()}`);
  }
  return lastTournament;
}
