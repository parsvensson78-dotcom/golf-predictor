import React, { useState, useCallback, useEffect, useRef } from 'react';
import './App.css';

/**
 * OPTIMIZED App.jsx
 * - Extracted reusable components
 * - Reduced code duplication
 * - Better state management
 * - Cleaner structure
 */

// Helper function to format American odds
const formatAmericanOdds = (odds) => {
  if (!odds || odds === 0) return 'N/A';
  return odds > 0 ? `+${odds}` : `${odds}`;
};

// Helper to look up live odds for a player (handles name format differences)
const getLiveOdds = (liveOdds, playerName) => {
  if (!liveOdds || !playerName) return null;
  // Try exact match first
  if (liveOdds[playerName]) return liveOdds[playerName];
  // Try normalized match (DataGolf uses "LastName, FirstName" format)
  const normalized = playerName.toLowerCase().trim();
  for (const [name, odds] of Object.entries(liveOdds)) {
    if (name.toLowerCase().trim() === normalized) return odds;
    // Handle "LastName, FirstName" vs "FirstName LastName"
    const parts = name.split(', ');
    if (parts.length === 2) {
      const flipped = `${parts[1]} ${parts[0]}`.toLowerCase().trim();
      if (flipped === normalized) return odds;
    }
    const playerParts = playerName.split(', ');
    if (playerParts.length === 2) {
      const flipped = `${playerParts[1]} ${playerParts[0]}`.toLowerCase().trim();
      if (name.toLowerCase().trim() === flipped) return odds;
    }
  }
  return null;
};

// Helper component to show odds with live update indicator
const OddsDisplay = ({ originalOdds, liveOdds, playerName, style = {} }) => {
  const live = getLiveOdds(liveOdds, playerName);
  const displayOdds = live ? live.odds : originalOdds;
  const isUpdated = live && originalOdds && live.odds !== originalOdds;
  
  return (
    <span style={{ fontWeight: 600, color: '#667eea', ...style }}>
      {formatAmericanOdds(displayOdds)}
      {isUpdated && (
        <span style={{ fontSize: '0.7rem', color: '#ff9800', marginLeft: '3px' }} title={`Was ${formatAmericanOdds(originalOdds)} at prediction time`}>
          ⚡
        </span>
      )}
    </span>
  );
};

// Reusable timestamp header component
const TimestampHeader = ({ generatedAt }) => {
  const getRelativeTime = (timestamp) => {
    const now = new Date();
    const then = new Date(timestamp);
    const diffMs = now - then;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  return (
    <div style={{
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      color: 'white',
      padding: '0.75rem 1.5rem',
      borderRadius: '8px',
      marginBottom: '1.5rem',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
    }}>
      <span style={{fontSize: '0.95rem', fontWeight: '600'}}>
        🕐 Last Updated: {new Date(generatedAt).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        })}
      </span>
      <span style={{fontSize: '0.9rem', opacity: 0.9}}>
        ({getRelativeTime(generatedAt)})
      </span>
    </div>
  );
};

function App() {
  const [tour, setTour] = useState('pga');
  const [activeTab, setActiveTab] = useState('predictions');
  const [data, setData] = useState({
    predictions: null,
    avoidPicks: null,
    newsPreview: null,
    matchups: null,
    results: null,
    playerAnalysis: null
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [requestId, setRequestId] = useState(0);
  const [liveOdds, setLiveOdds] = useState(null);
  const hasAutoLoadedRef = useRef(false);

  // Fetch live odds from DataGolf (refreshes every 5 min via cache header)
  const fetchLiveOdds = useCallback(async (tourParam) => {
    try {
      const response = await fetch(`/.netlify/functions/get-live-odds?tour=${tourParam || tour}&_=${Math.floor(Date.now() / 300000)}`);
      if (response.ok) {
        const oddsData = await response.json();
        setLiveOdds(oddsData.odds || {});
        console.log(`[LIVE-ODDS] Loaded ${oddsData.count} player odds`);
      }
    } catch (err) {
      console.log('[LIVE-ODDS] Failed to fetch:', err.message);
    }
  }, [tour]);

  // Generic fetch function to avoid duplication
  const fetchData = useCallback(async (endpoint, method = 'GET', body = null, dataKey) => {
    const newRequestId = requestId + 1;
    setRequestId(newRequestId);
    setError(null);
    setLoading(true);
    
    try {
      const timestamp = Date.now();
      
      // Extended timeout for heavy operations (90 seconds - longer than backend)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 90000);
      
      const options = {
        method,
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        },
        signal: controller.signal
      };
      
      if (body) {
        options.body = JSON.stringify({ ...body, _: timestamp });
      }
      
      const url = method === 'GET' 
        ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}_=${timestamp}`
        : endpoint;
      
      const response = await fetch(url, options);
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        
        // Special handling for 502/504 Gateway Timeout
        // Netlify returns 502 when function exceeds time limit
        if (response.status === 502 || response.status === 504) {
          console.log(`[FETCH] ${response.status} Gateway Timeout - function took too long`);
          throw new Error('BACKEND_TIMEOUT');
        }
        
        // Special handling for get-latest-* endpoints
        if (url.includes('get-latest-')) {
          // 503 = Blobs not configured, 404 = No saved data yet
          if (response.status === 503 || response.status === 404) {
            console.log(`[FETCH] No cached data available (${response.status}), will use fallback`);
            throw new Error('NO_CACHED_DATA');
          }
        }
        
        throw new Error(errorData.message || errorData.error || 'Request failed');
      }
      
      const responseData = await response.json();
      setData(prev => ({ ...prev, [dataKey]: responseData }));
      
    } catch (err) {
      // Handle abort/timeout errors
      if (err.name === 'AbortError') {
        setError('Request timed out. The operation took too long. Please try again.');
        console.error('Request timeout after 90 seconds');
        throw err;
      }
      
      // Handle backend timeout with helpful message
      if (err.message === 'BACKEND_TIMEOUT') {
        setError('Analysis is still processing. Please refresh the page in a few seconds to see the cached results.');
        console.error('Backend timeout - but results may be cached');
        throw err;
      }
      
      // Don't show error to user if it's just no cached data available
      if (err.message !== 'NO_CACHED_DATA' && err.message !== 'BLOBS_NOT_AVAILABLE') {
        setError(err.message);
      }
      console.error('Fetch error:', err);
      throw err; // Re-throw so catch handlers can handle it
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  const handleGetPredictions = async () => {
    try {
      await fetchData(`/.netlify/functions/get-predictions?tour=${tour}`, 'GET', null, 'predictions');
    } catch (err) {
      if (err.message === 'BACKEND_TIMEOUT') {
        console.log('[PRED] Backend timeout - function still processing, polling for results...');
        setError('Generating predictions... This may take 30-40 seconds. Checking for results...');
        setLoading(true);
        
        let attempts = 0;
        const maxAttempts = 12;
        const pollInterval = setInterval(async () => {
          attempts++;
          console.log(`[PRED] Polling cache attempt ${attempts}/${maxAttempts}`);
          
          try {
            // Fetch latest predictions - the backend should have saved by now
            const response = await fetch(`/.netlify/functions/get-latest-predictions?tour=${tour}&_=${Date.now()}`, {
              cache: 'no-store',
              headers: { 'Cache-Control': 'no-cache' }
            });
            if (response.ok) {
              const predData = await response.json();
              // Only accept if generated recently (within last 2 minutes)
              const age = Date.now() - new Date(predData.generatedAt).getTime();
              if (age < 120000) {
                setData(prev => ({ ...prev, predictions: predData }));
                clearInterval(pollInterval);
                setError(null);
                setLoading(false);
                console.log('[PRED] ✅ Successfully loaded from cache!');
                return;
              }
            }
          } catch (cacheErr) {
            // Keep polling
          }
          
          if (attempts >= maxAttempts) {
            clearInterval(pollInterval);
            setLoading(false);
            setError('Prediction generation took longer than expected. Please reload the page to see results.');
          }
        }, 3000);
      }
    }
  };
  
  const handleGetAvoidPicks = async () => {
    const valuePicks = data.predictions?.predictions?.map(p => p.player) || [];
    try {
      await fetchData(`/.netlify/functions/get-avoid-picks`, 'POST', { 
        tour,
        excludePlayers: valuePicks 
      }, 'avoidPicks');
    } catch (err) {
      if (err.message === 'BACKEND_TIMEOUT') {
        console.log('[AVOID] Backend timeout - polling for cached results...');
        setError('Generating avoid picks... Checking for results...');
        setLoading(true);
        
        const tournamentName = data.predictions?.tournament?.name || '';
        const tournamentParam = tournamentName ? `&tournament=${encodeURIComponent(tournamentName)}` : '';
        
        let attempts = 0;
        const maxAttempts = 10;
        const pollInterval = setInterval(async () => {
          attempts++;
          console.log(`[AVOID] Polling cache attempt ${attempts}/${maxAttempts}`);
          
          try {
            const response = await fetch(`/.netlify/functions/get-latest-avoid-picks?tour=${tour}${tournamentParam}&_=${Date.now()}`, {
              cache: 'no-store',
              headers: { 'Cache-Control': 'no-cache' }
            });
            if (response.ok) {
              const avoidData = await response.json();
              const age = Date.now() - new Date(avoidData.generatedAt).getTime();
              if (age < 120000) {
                setData(prev => ({ ...prev, avoidPicks: avoidData }));
                clearInterval(pollInterval);
                setError(null);
                setLoading(false);
                console.log('[AVOID] ✅ Successfully loaded from cache!');
                return;
              }
            }
          } catch (cacheErr) {
            // Keep polling
          }
          
          if (attempts >= maxAttempts) {
            clearInterval(pollInterval);
            setLoading(false);
            setError('Avoid picks generation took longer than expected. Please reload the page.');
          }
        }, 3000);
      }
    }
  };
  
  const handleGetNews = () => 
    fetchData(`/.netlify/functions/get-tournament-news?tour=${tour}`, 'GET', null, 'newsPreview');
  
  const handleGetMatchups = async () => {
    try {
      await fetchData(`/.netlify/functions/get-matchup-predictions`, 'POST', { tour }, 'matchups');
    } catch (err) {
      if (err.message === 'BACKEND_TIMEOUT') {
        console.log('[MATCHUP] Backend timeout detected - function still processing in background');
        setError('Generating matchups... This may take 30-40 seconds. Checking for results...');
        setLoading(true);
        
        const tournamentName = data.predictions?.tournament?.name || '';
        const tournamentParam = tournamentName ? `&tournament=${encodeURIComponent(tournamentName)}` : '';
        
        let attempts = 0;
        const maxAttempts = 12;
        const pollInterval = setInterval(async () => {
          attempts++;
          console.log(`[MATCHUP] Polling cache attempt ${attempts}/${maxAttempts}`);
          
          try {
            const response = await fetch(`/.netlify/functions/get-latest-matchups?tour=${tour}${tournamentParam}&_=${Date.now()}`, {
              cache: 'no-store',
              headers: { 'Cache-Control': 'no-cache' }
            });
            if (response.ok) {
              const matchupData = await response.json();
              const age = Date.now() - new Date(matchupData.generatedAt).getTime();
              if (age < 120000) {
                setData(prev => ({ ...prev, matchups: matchupData }));
                clearInterval(pollInterval);
                setError(null);
                setLoading(false);
                console.log('[MATCHUP] ✅ Successfully loaded from cache!');
                return;
              }
            }
          } catch (cacheErr) {
            // Keep polling
          }
          
          if (attempts >= maxAttempts) {
            clearInterval(pollInterval);
            setLoading(false);
            setError('Matchup generation is taking longer than expected. Please try refreshing in a moment.');
          }
        }, 3000);
      }
    }
  };

  const handleGetResults = () => 
    fetchData(`/.netlify/functions/get-prediction-results?tour=${tour}`, 'GET', null, 'results');

  const handleAnalyzePlayer = async (playerName) => {
    if (!playerName) return;
    try {
      await fetchData(`/.netlify/functions/analyze-player`, 'POST', { playerName, tour }, 'playerAnalysis');
    } catch (err) {
      if (err.message === 'BACKEND_TIMEOUT') {
        setError('Analysis is taking longer than expected. The player analysis function may have timed out. Please try again.');
        setLoading(false);
      }
    }
  };

  const handleTourChange = (newTour) => {
    setTour(newTour);
    setError(null);
    setRequestId(prev => prev + 1);
    
    // Clear existing data for clean transition
    setData(prev => ({ ...prev, predictions: null, avoidPicks: null, matchups: null }));
    
    // Load predictions first to get tournament name, then load rest with filter
    console.log(`[TOUR] Switching to ${newTour}, loading cached data...`);
    
    const loadTourData = async () => {
      let tournamentName = '';
      try {
        const predResponse = await fetch(`/.netlify/functions/get-latest-predictions?tour=${newTour}&_=${Date.now()}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache' }
        });
        if (predResponse.ok) {
          const predData = await predResponse.json();
          setData(prev => ({ ...prev, predictions: predData }));
          tournamentName = predData.tournament?.name || '';
          console.log(`[TOUR] ✅ Predictions loaded for ${newTour}: "${tournamentName}"`);
        }
      } catch (err) {
        console.log(`[TOUR] No cached predictions for ${newTour}`);
      }
      
      const tournamentParam = tournamentName ? `&tournament=${encodeURIComponent(tournamentName)}` : '';
      
      const results = await Promise.allSettled([
        fetchData(`/.netlify/functions/get-latest-avoid-picks?tour=${newTour}${tournamentParam}`, 'GET', null, 'avoidPicks'),
        fetchData(`/.netlify/functions/get-latest-matchups?tour=${newTour}${tournamentParam}`, 'GET', null, 'matchups')
      ]);
      
      const loaded = results.filter(r => r.status === 'fulfilled').length;
      console.log(`[TOUR] Loaded ${loaded}/2 cached datasets for ${newTour}`);
      
      // Also refresh live odds
      fetchLiveOdds(newTour);
    };
    
    loadTourData();
  };

  // Auto-load all cached data from Netlify Blobs on mount
  // Strategy: Load predictions FIRST to get current tournament name,
  // then load avoid/matchups filtered by that tournament
  useEffect(() => {
    if (!hasAutoLoadedRef.current && !loading) {
      console.log('[AUTO-LOAD] Checking for cached data in Blobs');
      hasAutoLoadedRef.current = true;
      
      const loadAllData = async () => {
        // Step 1: Load predictions first to get current tournament name
        let tournamentName = '';
        try {
          const predResponse = await fetch(`/.netlify/functions/get-latest-predictions?tour=${tour}&_=${Date.now()}`, {
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache' }
          });
          if (predResponse.ok) {
            const predData = await predResponse.json();
            setData(prev => ({ ...prev, predictions: predData }));
            tournamentName = predData.tournament?.name || '';
            console.log(`[AUTO-LOAD] ✅ Predictions loaded: "${tournamentName}"`);
          }
        } catch (err) {
          console.log('[AUTO-LOAD] No cached predictions available');
        }
        
        // Step 2: Load avoid, matchups, results in parallel WITH tournament filter
        const tournamentParam = tournamentName ? `&tournament=${encodeURIComponent(tournamentName)}` : '';
        console.log(`[AUTO-LOAD] Loading remaining data${tournamentName ? ` filtered by "${tournamentName}"` : ''}...`);
        
        const results = await Promise.allSettled([
          fetchData(`/.netlify/functions/get-latest-avoid-picks?tour=${tour}${tournamentParam}`, 'GET', null, 'avoidPicks'),
          fetchData(`/.netlify/functions/get-latest-matchups?tour=${tour}${tournamentParam}`, 'GET', null, 'matchups'),
          fetchData(`/.netlify/functions/get-prediction-results?tour=${tour}`, 'GET', null, 'results')
        ]);
        
        const loaded = results.filter(r => r.status === 'fulfilled').length;
        console.log(`[AUTO-LOAD] Successfully loaded ${loaded}/3 additional cached datasets`);
        
        // Step 3: Fetch live odds in background
        fetchLiveOdds(tour);
      };
      
      loadAllData();
    }
  }, []); // Empty array is safe with ref - truly runs once

  const currentData = data[
    activeTab === 'predictions' ? 'predictions' :
    activeTab === 'avoid' ? 'avoidPicks' :
    activeTab === 'news' ? 'newsPreview' : 
    activeTab === 'results' ? 'results' : 
    activeTab === 'playerAnalysis' ? 'playerAnalysis' : 'matchups'
  ];

  return (
    <div className="app">
      <Header />
      
      <TourSelector tour={tour} onTourChange={handleTourChange} disabled={loading} />
      
      <TabSelector activeTab={activeTab} onTabChange={setActiveTab} disabled={loading} />
      
      {activeTab !== 'playerAnalysis' && (
        <ActionButton 
          activeTab={activeTab}
          loading={loading}
          onGetPredictions={handleGetPredictions}
          onGetAvoidPicks={handleGetAvoidPicks}
          onGetNews={handleGetNews}
          onGetMatchups={handleGetMatchups}
          onGetResults={handleGetResults}
        />
      )}

      {loading && activeTab !== 'playerAnalysis' && <LoadingState requestId={requestId} />}
      
      {error && !loading && activeTab !== 'playerAnalysis' && <ErrorState error={error} onRetry={handleGetPredictions} requestId={requestId} />}

      {/* Player Analysis has its own self-contained UI */}
      {activeTab === 'playerAnalysis' && (
        <PlayerAnalysisView 
          data={data.playerAnalysis} 
          onAnalyze={handleAnalyzePlayer}
          loading={loading}
          error={error}
          tour={tour}
          field={data.predictions?.field || data.predictions?.tournament?.field || []}
          requestId={requestId}
        />
      )}

      {currentData && !loading && !error && activeTab !== 'playerAnalysis' && (
        <>
          {activeTab === 'predictions' && <PredictionsView data={currentData} liveOdds={liveOdds} requestId={requestId} />}
          {activeTab === 'avoid' && <AvoidPicksView data={currentData} liveOdds={liveOdds} requestId={requestId} />}
          {activeTab === 'news' && <NewsPreviewView data={currentData} requestId={requestId} />}
          {activeTab === 'matchups' && <MatchupsView data={currentData} liveOdds={liveOdds} requestId={requestId} />}
          {activeTab === 'results' && <ResultsView data={currentData} requestId={requestId} />}
        </>
      )}
    </div>
  );
}

// ==================== HEADER ====================
const Header = () => (
  <header className="header">
    <h1>🏌️ Golf AI Predictor</h1>
    <p className="subtitle">Complete field analysis • Course-fit value picks • AI powered</p>
  </header>
);

// ==================== TOUR SELECTOR ====================
const TourSelector = ({ tour, onTourChange, disabled }) => (
  <div className="tour-selector">
    <button 
      className={`tour-btn ${tour === 'pga' ? 'active' : ''}`}
      onClick={() => onTourChange('pga')}
      disabled={disabled}
    >
      PGA Tour
    </button>
    <button 
      className={`tour-btn ${tour === 'dp' ? 'active' : ''}`}
      onClick={() => onTourChange('dp')}
      disabled={disabled}
    >
      DP World Tour
    </button>
  </div>
);

// ==================== TAB SELECTOR ====================
const TabSelector = ({ activeTab, onTabChange, disabled }) => (
  <div className="tab-selector">
    {[
      { id: 'predictions', icon: '📊', label: 'Value Predictions' },
      { id: 'avoid', icon: '❌', label: 'Avoid Picks' },
      { id: 'news', icon: '📰', label: 'News & Preview' },
      { id: 'matchups', icon: '🆚', label: 'Matchup Predictor' },
      { id: 'playerAnalysis', icon: '🔍', label: 'Player Analyzer' },
      { id: 'results', icon: '🏆', label: 'Results' }
    ].map(tab => (
      <button 
        key={tab.id}
        className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
        onClick={() => onTabChange(tab.id)}
        disabled={disabled}
      >
        {tab.icon} {tab.label}
      </button>
    ))}
  </div>
);

// ==================== ACTION BUTTON ====================
const ActionButton = ({ activeTab, loading, onGetPredictions, onGetAvoidPicks, onGetNews, onGetMatchups, onGetResults }) => {
  const buttonConfig = {
    predictions: { text: 'Get Predictions', handler: onGetPredictions },
    avoid: { text: 'Get Avoid Picks', handler: onGetAvoidPicks },
    news: { text: 'Get News & Preview', handler: onGetNews },
    matchups: { text: 'Get Matchup Predictions', handler: onGetMatchups },
    results: { text: 'View Results History', handler: onGetResults }
  };

  const config = buttonConfig[activeTab];

  return (
    <div className="action-section">
      <button 
        className="get-predictions-btn"
        onClick={config.handler}
        disabled={loading}
      >
        {loading ? 'Analyzing...' : config.text}
      </button>
    </div>
  );
};

// ==================== LOADING STATE ====================
const LoadingState = ({ requestId }) => (
  <div className="loading" key={`loading-${requestId}`}>
    <div className="spinner"></div>
    <p className="loading-text">Analyzing complete tournament field...</p>
    <p className="loading-subtext">Evaluating 120+ players for value picks</p>
  </div>
);

// ==================== ERROR STATE ====================
const ErrorState = ({ error, onRetry, requestId }) => (
  <div className="error" key={`error-${requestId}`}>
    <p>❌ {error}</p>
    <button onClick={onRetry}>Retry</button>
  </div>
);

// ==================== SHARED COMPONENTS ====================
const TournamentInfo = ({ tournament }) => (
  <div className="tournament-info">
    <h2>{tournament.name}</h2>
    <div className="tournament-details">
      <span>📍 {tournament.course}</span>
      <span>📅 {tournament.dates}</span>
    </div>
  </div>
);

const WeatherForecast = ({ dailyForecast }) => {
  if (!dailyForecast?.length) return null;
  
  return (
    <div className="weather-forecast-section">
      <h3>🌤️ Tournament Week Forecast</h3>
      <div className="daily-forecast-grid">
        {dailyForecast.map((day, index) => (
          <div key={index} className="forecast-day-card">
            <div className="forecast-day-name">{day.day}</div>
            <div className="forecast-temp">
              <span className="temp-high">{day.tempHigh}°</span>
              <span className="temp-divider">/</span>
              <span className="temp-low">{day.tempLow}°</span>
            </div>
            <div className="forecast-condition">{day.condition}</div>
            <div className="forecast-details">
              <span className="forecast-wind">💨 {day.windSpeed}mph</span>
              {day.chanceOfRain > 30 && (
                <span className="forecast-rain">🌧️ {day.chanceOfRain}%</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const CourseDetails = ({ courseInfo, courseAnalysis }) => {
  if (!courseInfo) return null;

  return (
    <div className="course-details-card">
      <div className="course-header-section">
        <h3>⛳ Course Profile: {courseInfo.name}</h3>
        {courseInfo.difficulty && (
          <span className="difficulty-badge">{courseInfo.difficulty}</span>
        )}
      </div>

      <div className="course-overview">
        <h4>📏 Course Specifications</h4>
        <div className="course-stats-grid">
          {courseInfo.yardage && (
            <div className="course-stat highlight">
              <span className="stat-label">Total Length</span>
              <span className="stat-value">{courseInfo.yardage.toLocaleString()}</span>
              <span className="stat-unit">yards</span>
            </div>
          )}
          <div className="course-stat">
            <span className="stat-label">Par</span>
            <span className="stat-value">{courseInfo.par}</span>
            <span className="stat-unit">strokes</span>
          </div>
          {courseInfo.avgScore && (
            <>
              <div className="course-stat">
                <span className="stat-label">Tour Average</span>
                <span className="stat-value">{courseInfo.avgScore}</span>
                <span className="stat-unit">strokes</span>
              </div>
              {courseInfo.par && (
                <div className="course-stat">
                  <span className="stat-label">Scoring Margin</span>
                  <span className="stat-value">
                    {(courseInfo.avgScore - courseInfo.par) > 0 ? '+' : ''}
                    {(courseInfo.avgScore - courseInfo.par).toFixed(1)}
                  </span>
                  <span className="stat-unit">vs par</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="course-characteristics-detailed">
        <h4>🏌️ Course Characteristics</h4>
        <div className="characteristics-grid">
          <CharacteristicCard icon="🎯" title="Fairways" content={courseInfo.width} />
          <CharacteristicCard icon="🟢" title="Greens" content={courseInfo.greens} />
          <CharacteristicCard icon="🌿" title="Rough" content={courseInfo.rough} />
        </div>
      </div>

      {courseAnalysis?.notes && (
        <div className="course-notes-section">
          <h4>📝 Course Setup & Betting Insights</h4>
          <div className="course-notes-content">
            <p>{courseAnalysis.notes}</p>
          </div>
        </div>
      )}

      {courseInfo.keyFeatures?.length > 0 && (
        <div className="key-features-detailed">
          <h4>⭐ Signature Course Features</h4>
          <div className="features-grid">
            {courseInfo.keyFeatures.map((feature, idx) => (
              <div key={idx} className="feature-item">
                <span className="feature-bullet">⛳</span>
                <span className="feature-text">{feature}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {courseInfo.rewards?.length > 0 && (
        <div className="rewards-skills-detailed">
          <h4>💪 Critical Skills for Success</h4>
          <p className="skills-intro">This course rewards players who excel in:</p>
          <div className="skills-tags">
            {courseInfo.rewards.map((skill, idx) => (
              <span key={idx} className="skill-tag-enhanced">
                <span className="skill-number">{idx + 1}</span>
                {skill}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const CharacteristicCard = ({ icon, title, content }) => (
  <div className="characteristic-card">
    <div className="char-icon">{icon}</div>
    <div className="char-content">
      <strong>{title}</strong>
      <p>{content}</p>
    </div>
  </div>
);

const CourseAnalysis = ({ courseAnalysis }) => {
  if (!courseAnalysis) return null;

  return (
    <div className="course-analysis">
      <h3>📊 Course Analysis</h3>
      <div className="analysis-item">
        <strong>Course Type:</strong> {courseAnalysis.type}
      </div>
      <div className="analysis-item">
        <strong>Weather Impact:</strong> {courseAnalysis.weatherImpact}
      </div>
      {courseAnalysis.keyFactors?.length > 0 && (
        <div className="analysis-item">
          <strong>Key Success Factors:</strong>
          <ul className="factors-list">
            {courseAnalysis.keyFactors.map((factor, idx) => (
              <li key={idx}>{factor}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

const OddsBreakdown = ({ pick }) => {
  if (!pick.minOdds || !pick.maxOdds) return null;

  // Convert decimal odds to American
  const decimalToAmerican = (decimal) => {
    if (decimal >= 2) {
      return Math.round((decimal - 1) * 100);
    } else {
      return Math.round(-100 / (decimal - 1));
    }
  };

  return (
    <div className="odds-breakdown">
      <div className="odds-breakdown-item">
        <span className="odds-breakdown-label">Best:</span>
        <span className="odds-breakdown-value best">{formatAmericanOdds(decimalToAmerican(pick.minOdds))}</span>
        {pick.bestBookmaker && <span className="odds-breakdown-book">({pick.bestBookmaker})</span>}
      </div>
      <div className="odds-breakdown-item">
        <span className="odds-breakdown-label">Avg:</span>
        <span className="odds-breakdown-value avg">{formatAmericanOdds(pick.odds)}</span>
      </div>
      <div className="odds-breakdown-item">
        <span className="odds-breakdown-label">Worst:</span>
        <span className="odds-breakdown-value worst">{formatAmericanOdds(decimalToAmerican(pick.maxOdds))}</span>
        {pick.worstBookmaker && <span className="odds-breakdown-book">({pick.worstBookmaker})</span>}
      </div>
    </div>
  );
};

const FooterInfo = ({ data }) => {
  // Calculate relative time
  const getRelativeTime = (timestamp) => {
    const now = new Date();
    const then = new Date(timestamp);
    const diffMs = now - then;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  };

  return (
    <div className="footer-info">
      <p className="generated-time" style={{fontSize: '1rem', fontWeight: '600', color: '#333', marginBottom: '0.5rem'}}>
        🕐 Generated: {new Date(data.generatedAt).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        })} 
        <span style={{color: '#666', fontWeight: '400', marginLeft: '0.5rem'}}>
          ({getRelativeTime(data.generatedAt)})
        </span>
      </p>
    {data.tokensUsed && (
      <div className="api-usage-info">
        <div className="token-info">
          <span className="token-label">API tokens:</span>
          <span className="token-value">{data.tokensUsed.toLocaleString()}</span>
          {data.tokenBreakdown && (
            <span className="token-breakdown">
              (↓{data.tokenBreakdown.input.toLocaleString()} 
              ↑{data.tokenBreakdown.output.toLocaleString()})
            </span>
          )}
        </div>
        {data.estimatedCost && (
          <div className="cost-info">
            <span className="cost-label">Estimated cost:</span>
            <span className="cost-value">{data.estimatedCost.formatted}</span>
          </div>
        )}
      </div>
    )}
  </div>
  );
};

// ==================== PREDICTIONS VIEW ====================
const PredictionsView = ({ data, liveOdds, requestId }) => {
  // Check if data is from cache (generated more than 1 minute ago)
  const generatedTime = new Date(data.generatedAt).getTime();
  const now = Date.now();
  const isCached = (now - generatedTime) > 60000; // More than 1 minute old = cached
  
  // Helper function to format reasoning with proper structure
  const formatReasoning = (reasoning) => {
    // Split by double newlines OR by section headers
    const sections = reasoning
      .split(/\n\n+/)
      .filter(s => s.trim())
      .map(s => s.trim());
    
    // If we have multiple sections, render them as separate paragraphs
    if (sections.length > 1) {
      return sections.map((section, i) => {
        // Check if section starts with a label
        const hasLabel = /^(Course fit|History|Form|Weather|Value):/i.test(section);
        return (
          <p 
            key={i} 
            style={{
              marginBottom: hasLabel ? '0.75rem' : '0.5rem',
              lineHeight: '1.6',
              fontSize: '0.95rem',
              fontWeight: hasLabel ? '500' : '400'
            }}
          >
            {section}
          </p>
        );
      });
    }
    
    // Fallback: split by periods for backwards compatibility
    return reasoning.split('. ').filter(s => s.trim()).map((sentence, i, arr) => (
      <p key={i} style={{marginBottom: '0.5rem', lineHeight: '1.6', fontSize: '0.95rem'}}>
        {sentence.trim()}{i < arr.length - 1 || !sentence.endsWith('.') ? '.' : ''}
      </p>
    ));
  };
  
  return (
    <div className="predictions-container loaded" key={`predictions-${requestId}-${data.generatedAt}`}>
      <div className={`cache-indicator ${isCached ? 'cached' : 'fresh'}`}>
        {isCached ? 'Cached' : 'Fresh'}
      </div>
      
      {/* Warning if data is from a previous tournament (fallback) */}
      {data.isFallback && (
        <div style={{
          background: '#fff3e0',
          border: '2px solid #ff9800',
          borderRadius: '8px',
          padding: '1rem 1.5rem',
          marginBottom: '1rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem'
        }}>
          <span style={{fontSize: '1.5rem'}}>⚠️</span>
          <div>
            <strong style={{color: '#e65100'}}>Previous tournament data</strong>
            <p style={{margin: '0.25rem 0 0', color: '#bf360c', fontSize: '0.9rem'}}>
              No predictions saved for this week's tournament yet. Showing last available data.
              Click "Get Predictions" to generate fresh predictions.
            </p>
          </div>
        </div>
      )}
      
      <TimestampHeader generatedAt={data.generatedAt} />
      <TournamentInfo tournament={data.tournament} />
    <WeatherForecast dailyForecast={data.dailyForecast} />
    <CourseDetails courseInfo={data.courseInfo} courseAnalysis={data.courseAnalysis} />
    <CourseAnalysis courseAnalysis={data.courseAnalysis} />
    
    <div className="picks-section">
      <h3>💎 Value Picks</h3>
      <div className="picks-grid">
        {data.predictions?.map((pick, index) => (
          <div key={`pick-${requestId}-${index}`} className="pick-card">
            <div className="pick-header">
              <span className="pick-number">#{index + 1}</span>
              <div className="odds-container">
                <OddsDisplay originalOdds={pick.odds} liveOdds={liveOdds} playerName={pick.player} className="pick-odds" />
              </div>
            </div>
            <h3 className="pick-name">{pick.player}</h3>
            <OddsBreakdown pick={pick} />
            <div className="pick-reasoning">
              {formatReasoning(pick.reasoning)}
            </div>
          </div>
        ))}
      </div>
    </div>
    
    <FooterInfo data={data} />
  </div>
  );
};

// ==================== AVOID PICKS VIEW ====================
const AvoidPicksView = ({ data, liveOdds, requestId }) => {
  const generatedTime = new Date(data.generatedAt).getTime();
  const now = Date.now();
  const isCached = (now - generatedTime) > 60000;
  
  // Helper function to format reasoning with proper structure
  const formatReasoning = (reasoning) => {
    // Split by double newlines OR by section headers (Course fit:, History:, etc.)
    const sections = reasoning
      .split(/\n\n+/)
      .filter(s => s.trim())
      .map(s => s.trim());
    
    // If we have multiple sections, render them as separate paragraphs
    if (sections.length > 1) {
      return sections.map((section, i) => {
        // Check if section starts with a label (Course fit:, History:, etc.)
        const hasLabel = /^(Course fit|History|Form|Weather|Value):/i.test(section);
        return (
          <p 
            key={i} 
            style={{
              marginBottom: hasLabel ? '0.75rem' : '0.5rem',
              lineHeight: '1.6',
              fontSize: '0.95rem',
              fontWeight: hasLabel ? '500' : '400'
            }}
          >
            {section}
          </p>
        );
      });
    }
    
    // Fallback: split by periods for backwards compatibility
    return reasoning.split('. ').filter(s => s.trim()).map((sentence, i, arr) => (
      <p key={i} style={{marginBottom: '0.5rem', lineHeight: '1.6', fontSize: '0.95rem'}}>
        {sentence.trim()}{i < arr.length - 1 || !sentence.endsWith('.') ? '.' : ''}
      </p>
    ));
  };
  
  return (
    <div className="avoid-picks-container loaded" key={`avoid-${requestId}-${data.generatedAt}`}>
      <div className={`cache-indicator ${isCached ? 'cached' : 'fresh'}`}>
        {isCached ? 'Cached' : 'Fresh'}
      </div>
      
      {data.isFallback && (
        <div style={{
          background: '#fff3e0', border: '2px solid #ff9800', borderRadius: '8px',
          padding: '1rem 1.5rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem'
        }}>
          <span style={{fontSize: '1.5rem'}}>⚠️</span>
          <div>
            <strong style={{color: '#e65100'}}>Previous tournament data</strong>
            <p style={{margin: '0.25rem 0 0', color: '#bf360c', fontSize: '0.9rem'}}>
              No avoid picks saved for this week yet. Click "Get Avoid Picks" to generate fresh analysis.
            </p>
          </div>
        </div>
      )}
      
      <TimestampHeader generatedAt={data.generatedAt} />
      <TournamentInfo tournament={data.tournament} />
    
    <div className="avoid-section">
      <h3>❌ Players to Avoid (Poor Course Fit)</h3>
      <p className="avoid-subtitle">{data.reasoning}</p>
      <div className="avoid-grid">
        {data.avoidPicks?.map((avoid, index) => (
          <div key={`avoid-${requestId}-${index}`} className="avoid-card">
            <div className="avoid-header">
              <span className="avoid-icon">⚠️</span>
              <OddsDisplay originalOdds={avoid.odds} liveOdds={liveOdds} playerName={avoid.player} />
            </div>
            <h4 className="avoid-name">{avoid.player}</h4>
            <div className="avoid-reasoning">
              {formatReasoning(avoid.reasoning)}
            </div>
          </div>
        ))}
      </div>
    </div>
    
    <FooterInfo data={data} />
  </div>
  );
};

// ==================== NEWS PREVIEW VIEW ====================
const NewsPreviewView = ({ data, requestId }) => {
  const generatedTime = new Date(data.generatedAt).getTime();
  const now = Date.now();
  const isCached = (now - generatedTime) > 60000;
  
  return (
    <div className="news-preview-container loaded" key={`news-${requestId}-${data.generatedAt}`}>
      <div className={`cache-indicator ${isCached ? 'cached' : 'fresh'}`}>
        {isCached ? 'Cached' : 'Fresh'}
      </div>
      <TimestampHeader generatedAt={data.generatedAt} />
    <TournamentInfo tournament={data.tournament} />
    
    {data.preview && (
      <div className="ai-preview-section">
        <h3>🤖 AI Tournament Preview</h3>
        {data.preview.overview && (
          <div className="preview-overview">
            <p>{data.preview.overview}</p>
          </div>
        )}
        {/* Add other preview sections as needed */}
      </div>
    )}
    
    {data.news?.length > 0 && (
      <div className="news-articles-section">
        <h3>📰 Latest Golf News</h3>
        <div className="news-grid">
          {data.news.map((article, index) => (
            <div key={index} className="news-article-card">
              <div className="article-source">{article.source}</div>
              <h4 className="article-title">
                <a href={article.link} target="_blank" rel="noopener noreferrer">
                  {article.title}
                </a>
              </h4>
              {article.description && (
                <p className="article-description">{article.description}</p>
              )}
              <div className="article-date">
                {new Date(article.pubDate).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      </div>
    )}
    
    <FooterInfo data={data} />
  </div>
  );
};

// ==================== MATCHUPS VIEW ====================
const MatchupsView = ({ data, liveOdds, requestId }) => {
  const generatedTime = new Date(data.generatedAt).getTime();
  const now = Date.now();
  const isCached = (now - generatedTime) > 60000;
  
  // Helper function to format reasoning
  const formatReasoning = (reasoning) => {
    // Split by double newlines OR by section headers
    const sections = reasoning
      .split(/\n\n+/)
      .filter(s => s.trim())
      .map(s => s.trim());
    
    // If we have multiple sections, render them as separate paragraphs
    if (sections.length > 1) {
      return sections.map((section, i) => {
        const hasLabel = /^(Course fit|History|Form|Weather|Probability):/i.test(section);
        return (
          <p 
            key={i} 
            style={{
              marginBottom: hasLabel ? '0.75rem' : '0.5rem',
              lineHeight: '1.6',
              fontSize: '0.95rem',
              fontWeight: hasLabel ? '500' : '400'
            }}
          >
            {section}
          </p>
        );
      });
    }
    
    // Fallback: split by periods
    return reasoning.split('. ').filter(s => s.trim()).map((sentence, i, arr) => (
      <p key={i} style={{marginBottom: '0.5rem', lineHeight: '1.6', fontSize: '0.95rem'}}>
        {sentence.trim()}{i < arr.length - 1 || !sentence.endsWith('.') ? '.' : ''}
      </p>
    ));
  };
  
  return (
    <div className="matchup-container loaded" key={`matchup-${requestId}-${data.generatedAt}`}>
      <div className={`cache-indicator ${isCached ? 'cached' : 'fresh'}`}>
        {isCached ? 'Cached' : 'Fresh'}
      </div>
      
      {data.isFallback && (
        <div style={{
          background: '#fff3e0', border: '2px solid #ff9800', borderRadius: '8px',
          padding: '1rem 1.5rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem'
        }}>
          <span style={{fontSize: '1.5rem'}}>⚠️</span>
          <div>
            <strong style={{color: '#e65100'}}>Previous tournament data</strong>
            <p style={{margin: '0.25rem 0 0', color: '#bf360c', fontSize: '0.9rem'}}>
              No matchups saved for this week yet. Click "Get Matchup Predictions" to generate fresh analysis.
            </p>
          </div>
        </div>
      )}
      
      <TimestampHeader generatedAt={data.generatedAt} />
    <TournamentInfo tournament={data.tournament} />
    
    {data.suggestedMatchups?.length > 0 && (
      <div className="suggested-matchups-section">
        <h3>🆚 AI-Suggested Matchups</h3>
        <p className="matchup-subtitle">Head-to-head predictions based on stats and course fit</p>
        
        {data.suggestedMatchups.map((matchup, index) => (
          <div key={index} className="matchup-card">
            <div className="matchup-header">
              <span className="matchup-number">Matchup #{index + 1}</span>
              <span className={`confidence-badge confidence-${matchup.confidence.toLowerCase().replace('-', '')}`}>
                {matchup.confidence}
              </span>
            </div>
            <div className="matchup-players">
              <PlayerBox player={matchup.playerA} isPick={matchup.pick === matchup.playerA.name} liveOdds={liveOdds} />
              <div className="vs-divider">VS</div>
              <PlayerBox player={matchup.playerB} isPick={matchup.pick === matchup.playerB.name} liveOdds={liveOdds} />
            </div>
            <div className="matchup-analysis">
              <div className="win-probability">
                Win Probability: <strong>{matchup.winProbability}%</strong>
              </div>
              <div className="matchup-reasoning">
                {formatReasoning(matchup.reasoning)}
              </div>
            </div>
          </div>
        ))}
      </div>
    )}
    
    <FooterInfo data={data} />
  </div>
  );
};

const PlayerBox = ({ player, isPick, liveOdds }) => (
  <div className={`player-box ${isPick ? 'winner' : ''}`}>
    <h4>{player.name}</h4>
    <div className="player-odds">
      <OddsDisplay originalOdds={player.odds} liveOdds={liveOdds} playerName={player.name} />
    </div>
    <div className="player-stats">
      {['OTT', 'APP', 'ARG', 'Putt'].map(stat => (
        <div key={stat} className="stat-row">
          <span>SG:{stat}</span>
          <span className="stat-value">{player[`sg${stat}`]}</span>
        </div>
      ))}
    </div>
    {isPick && <div className="winner-badge">✓ PICK</div>}
  </div>
);

// ==================== PLAYER ANALYSIS VIEW ====================
const PlayerAnalysisView = ({ data, onAnalyze, loading, error, tour, requestId }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [field, setField] = useState([]);
  const [fieldLoading, setFieldLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef(null);

  // Fetch FULL field list on mount / tour change
  useEffect(() => {
    const fetchField = async () => {
      setFieldLoading(true);
      try {
        // Use dedicated full-field endpoint (returns all 120-156 players)
        const response = await fetch(`/.netlify/functions/get-full-field?tour=${tour}`);
        if (response.ok) {
          const data = await response.json();
          const players = (data.field || [])
            .map(p => p.name)
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b));
          setField(players);
          console.log(`[PLAYER] Loaded ${players.length} players from field`);
        }
      } catch (err) {
        console.error('[PLAYER] Failed to fetch field:', err);
      }
      setFieldLoading(false);
    };
    fetchField();
  }, [tour]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredPlayers = field.filter(name =>
    name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const selectPlayer = (name) => {
    setSearchTerm(name);
    setShowDropdown(false);
    onAnalyze(name);
  };

  const verdictColors = {
    'STRONG BET': { bg: '#1b5e20', text: '#fff' },
    'LEAN YES': { bg: '#4caf50', text: '#fff' },
    'NEUTRAL': { bg: '#ff9800', text: '#fff' },
    'LEAN AVOID': { bg: '#f44336', text: '#fff' },
    'AVOID': { bg: '#b71c1c', text: '#fff' }
  };

  return (
    <div className="predictions-container" key={`player-${requestId}`}>
      <div style={{textAlign: 'center', marginBottom: '1.5rem'}}>
        <h2 style={{margin: '0 0 0.5rem'}}>🔍 Player Analyzer</h2>
        <p style={{color: '#666', margin: 0}}>Select a player for AI-powered course fit analysis</p>
      </div>

      {/* Search Input */}
      <div ref={dropdownRef} style={{position: 'relative', maxWidth: '500px', margin: '0 auto 2rem'}}>
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => { setSearchTerm(e.target.value); setShowDropdown(true); }}
          onFocus={() => setShowDropdown(true)}
          placeholder={fieldLoading ? 'Loading field...' : `Search ${field.length} players in field...`}
          disabled={fieldLoading || loading}
          style={{
            width: '100%',
            padding: '0.9rem 1.2rem',
            fontSize: '1rem',
            border: '2px solid #ddd',
            borderRadius: '10px',
            outline: 'none',
            boxSizing: 'border-box',
            transition: 'border-color 0.2s',
            background: loading ? '#f5f5f5' : '#fff'
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && filteredPlayers.length > 0) {
              selectPlayer(filteredPlayers[0]);
            }
          }}
        />
        
        {showDropdown && searchTerm.length > 0 && filteredPlayers.length > 0 && (
          <div style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            background: 'white',
            border: '2px solid #ddd',
            borderTop: 'none',
            borderRadius: '0 0 10px 10px',
            maxHeight: '250px',
            overflowY: 'auto',
            zIndex: 100,
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)'
          }}>
            {filteredPlayers.slice(0, 20).map((name, i) => (
              <div
                key={i}
                onClick={() => selectPlayer(name)}
                style={{
                  padding: '0.7rem 1.2rem',
                  cursor: 'pointer',
                  borderBottom: '1px solid #f0f0f0',
                  transition: 'background 0.15s'
                }}
                onMouseEnter={(e) => e.target.style.background = '#f0f4ff'}
                onMouseLeave={(e) => e.target.style.background = 'white'}
              >
                {name}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Loading state */}
      {loading && (
        <div style={{textAlign: 'center', padding: '3rem 1rem'}}>
          <div style={{fontSize: '2rem', marginBottom: '1rem'}}>🔄</div>
          <p style={{color: '#666', fontWeight: 500}}>Analyzing {searchTerm}...</p>
          <p style={{color: '#999', fontSize: '0.85rem'}}>Fetching stats, odds, course data & weather</p>
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div style={{textAlign: 'center', padding: '2rem', background: '#fff3e0', borderRadius: '10px', margin: '1rem 0'}}>
          <p style={{color: '#e65100', margin: 0}}>❌ {error}</p>
        </div>
      )}

      {/* Analysis Results */}
      {data && !loading && (
        <div style={{animation: 'fadeIn 0.3s ease-in'}}>
          {/* Header Card */}
          <div style={{
            background: 'white',
            borderRadius: '12px',
            padding: '1.5rem',
            marginBottom: '1rem',
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
            border: '2px solid #667eea'
          }}>
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem'}}>
              <div>
                <h2 style={{margin: '0 0 0.25rem'}}>{data.player}</h2>
                <span style={{color: '#666', fontSize: '0.9rem'}}>
                  {data.tournament?.name} • R{data.stats?.rank || '?'}
                  {data.odds && ` • ${formatAmericanOdds(data.odds.odds)}`}
                </span>
              </div>
              <div style={{display: 'flex', gap: '0.75rem', alignItems: 'center'}}>
                <div style={{
                  fontSize: '2.2rem',
                  fontWeight: 'bold',
                  color: data.analysis.overallRating >= 7 ? '#2e7d32' : data.analysis.overallRating >= 5 ? '#ff9800' : '#c62828'
                }}>
                  {data.analysis.overallRating}/10
                </div>
                <span style={{
                  padding: '0.5rem 1rem',
                  borderRadius: '20px',
                  fontWeight: 700,
                  fontSize: '0.85rem',
                  ...(verdictColors[data.analysis.verdict] || { bg: '#666', text: '#fff' }),
                  background: (verdictColors[data.analysis.verdict] || {}).bg,
                  color: (verdictColors[data.analysis.verdict] || {}).text
                }}>
                  {data.analysis.verdict}
                </span>
              </div>
            </div>
            <p style={{margin: '1rem 0 0', color: '#333', lineHeight: 1.5}}>{data.analysis.summary}</p>
          </div>

          {/* SG Stats Bar */}
          <div style={{
            background: 'white',
            borderRadius: '12px',
            padding: '1rem 1.5rem',
            marginBottom: '1rem',
            boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
            display: 'flex',
            justifyContent: 'space-around',
            flexWrap: 'wrap',
            gap: '0.5rem'
          }}>
            {[
              { label: 'OTT', value: data.stats?.sgOTT },
              { label: 'APP', value: data.stats?.sgAPP },
              { label: 'ARG', value: data.stats?.sgARG },
              { label: 'Putt', value: data.stats?.sgPutt },
              { label: 'Total', value: data.stats?.sgTotal }
            ].map(sg => (
              <div key={sg.label} style={{textAlign: 'center', minWidth: '60px'}}>
                <div style={{fontSize: '0.75rem', color: '#999', marginBottom: '0.2rem'}}>SG:{sg.label}</div>
                <div style={{
                  fontSize: '1.1rem',
                  fontWeight: 700,
                  color: (sg.value || 0) > 0.5 ? '#2e7d32' : (sg.value || 0) > 0 ? '#666' : '#c62828'
                }}>
                  {sg.value != null ? (sg.value > 0 ? '+' : '') + sg.value.toFixed(2) : 'N/A'}
                </div>
              </div>
            ))}
          </div>

          {/* Analysis Cards */}
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem', marginBottom: '1rem'}}>
            <AnalysisCard icon="⛳" title="Course Fit" data={data.analysis.courseFit} />
            <AnalysisCard icon="📈" title="Recent Form" data={data.analysis.recentForm} />
            <AnalysisCard icon="💰" title="Odds Value" data={data.analysis.oddsValue} />
            <AnalysisCard icon="🌤️" title="Weather Impact" data={data.analysis.weatherImpact} />
          </div>

          {/* Key Strength/Weakness */}
          <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem'}}>
            <div style={{background: '#e8f5e9', borderRadius: '10px', padding: '1rem', borderLeft: '4px solid #4caf50'}}>
              <div style={{fontWeight: 600, fontSize: '0.85rem', color: '#2e7d32', marginBottom: '0.3rem'}}>💪 Key Strength</div>
              <p style={{margin: 0, fontSize: '0.9rem', color: '#333'}}>{data.analysis.keyStrength}</p>
            </div>
            <div style={{background: '#ffebee', borderRadius: '10px', padding: '1rem', borderLeft: '4px solid #f44336'}}>
              <div style={{fontWeight: 600, fontSize: '0.85rem', color: '#c62828', marginBottom: '0.3rem'}}>⚠️ Key Weakness</div>
              <p style={{margin: 0, fontSize: '0.9rem', color: '#333'}}>{data.analysis.keyWeakness}</p>
            </div>
          </div>

          <FooterInfo data={data} />
        </div>
      )}

      {/* Empty state */}
      {!data && !loading && !error && (
        <div style={{textAlign: 'center', padding: '3rem 1rem', color: '#999'}}>
          <div style={{fontSize: '3rem', marginBottom: '1rem'}}>🏌️</div>
          <p>Search for a player above to get a detailed analysis of their course fit, form, and odds value.</p>
        </div>
      )}
    </div>
  );
};

const AnalysisCard = ({ icon, title, data }) => {
  if (!data) return null;
  const ratingColor = data.rating >= 7 ? '#2e7d32' : data.rating >= 5 ? '#ff9800' : '#c62828';
  
  return (
    <div style={{
      background: 'white',
      borderRadius: '12px',
      padding: '1.25rem',
      boxShadow: '0 2px 8px rgba(0,0,0,0.08)'
    }}>
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem'}}>
        <h4 style={{margin: 0, fontSize: '0.95rem'}}>{icon} {title}</h4>
        <span style={{
          background: ratingColor,
          color: 'white',
          padding: '0.2rem 0.6rem',
          borderRadius: '12px',
          fontWeight: 700,
          fontSize: '0.8rem'
        }}>
          {data.rating}/10
        </span>
      </div>
      <p style={{margin: 0, fontSize: '0.85rem', color: '#444', lineHeight: 1.5}}>{data.analysis}</p>
    </div>
  );
};

// ==================== RESULTS VIEW ====================
const ResultsView = ({ data, requestId }) => {
  if (!data.tournaments || data.tournaments.length === 0) {
    return (
      <div className="predictions-container" key={`results-${requestId}`}>
        <div style={{textAlign: 'center', padding: '4rem 2rem'}}>
          <h3>No Results Yet</h3>
          <p>Generate predictions, avoid picks, or matchups first — results will be tracked automatically!</p>
        </div>
      </div>
    );
  }

  const s = data.summary || {};

  return (
    <div className="predictions-container" key={`results-${requestId}`}>
      {/* Overall Summary */}
      <div style={{textAlign: 'center', marginBottom: '2rem'}}>
        <h2 style={{margin: '0 0 1rem'}}>🏆 Results Tracker</h2>
        <div style={{display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap'}}>
          <SummaryBadge label="Tournaments" value={s.completedTournaments || 0} />
          {s.totalBets > 0 && (
            <SummaryBadge 
              label="Value ROI" 
              value={`${s.overallROI >= 0 ? '+' : ''}$${(s.overallROI || 0).toFixed(0)}`}
              color={s.overallROI >= 0 ? '#4caf50' : '#f44336'}
            />
          )}
          {s.matchupRecord?.total > 0 && (
            <SummaryBadge label="Matchups" value={`${s.matchupRecord.wins}W-${s.matchupRecord.total - s.matchupRecord.wins}L`} />
          )}
          {s.avoidRecord?.total > 0 && (
            <SummaryBadge label="Avoids" value={`${s.avoidRecord.correct}/${s.avoidRecord.total} correct`} />
          )}
        </div>
      </div>

      {/* Tournament Cards */}
      {data.tournaments.map((t, index) => (
        <TournamentResultCard key={index} tournament={t} />
      ))}
    </div>
  );
};

const SummaryBadge = ({ label, value, color }) => (
  <span style={{
    background: color ? 'white' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    color: color || 'white',
    border: color ? `2px solid ${color}` : 'none',
    padding: '0.4rem 0.8rem',
    borderRadius: '20px',
    fontWeight: 600,
    fontSize: '0.85rem'
  }}>
    {label}: {value}
  </span>
);

const TournamentResultCard = ({ tournament: t }) => {
  const isCompleted = t.status === 'completed';
  const isPending = t.status === 'pending';
  
  return (
    <div style={{
      background: 'white',
      borderRadius: '12px',
      padding: '1.5rem',
      marginBottom: '1.5rem',
      boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
      border: `2px solid ${isCompleted ? '#4caf50' : isPending ? '#ff9800' : '#e0e0e0'}`
    }}>
      {/* Tournament Header */}
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem'}}>
        <div>
          <h3 style={{margin: '0 0 0.25rem'}}>{t.tournament.name}</h3>
          <span style={{color: '#666', fontSize: '0.85rem'}}>
            📍 {t.tournament.course} • 📅 {t.tournament.dates}
          </span>
        </div>
        <span style={{
          padding: '0.3rem 0.8rem',
          borderRadius: '20px',
          fontSize: '0.8rem',
          fontWeight: 600,
          background: isCompleted ? '#e8f5e9' : '#fff3e0',
          color: isCompleted ? '#2e7d32' : '#e65100'
        }}>
          {isCompleted ? '✅ Completed' : isPending ? '⏳ In Progress' : '❓ Unknown'}
        </span>
      </div>

      {/* Weather Accuracy Comparison */}
      <WeatherComparison tournament={t.tournament} />

      {/* Value Picks Section */}
      {t.valuePicks.length > 0 && (
        <ResultSection 
          title="📊 Value Picks" 
          isCompleted={isCompleted}
          analysis={t.valueAnalysis}
          renderContent={() => (
            <>
              {isCompleted && t.valueAnalysis && (
                <div style={{display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap'}}>
                  <MiniStat label="W" value={t.valueAnalysis.wins} highlight={t.valueAnalysis.wins > 0} />
                  <MiniStat label="T5" value={t.valueAnalysis.top5s} />
                  <MiniStat label="T10" value={t.valueAnalysis.top10s} />
                  <MiniStat label="T20" value={t.valueAnalysis.top20s} />
                  <MiniStat label="MC" value={t.valueAnalysis.missedCut} bad />
                  <MiniStat 
                    label="ROI" 
                    value={`${t.valueAnalysis.totalROI >= 0 ? '+' : ''}$${t.valueAnalysis.totalROI.toFixed(0)}`}
                    highlight={t.valueAnalysis.totalROI > 0}
                    bad={t.valueAnalysis.totalROI < 0}
                  />
                </div>
              )}
              <PicksTable 
                picks={isCompleted && t.valueAnalysis ? t.valueAnalysis.picks : t.valuePicks.map(p => ({ player: p.player, odds: p.odds, position: '—', performance: 'pending' }))}
                showOdds
                showROI={isCompleted}
              />
            </>
          )}
        />
      )}

      {/* Avoid Picks Section */}
      {t.avoidPicks.length > 0 && (
        <ResultSection
          title="❌ Avoid Picks"
          isCompleted={isCompleted}
          analysis={t.avoidAnalysis}
          renderContent={() => (
            <>
              {isCompleted && t.avoidAnalysis && (
                <div style={{display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap'}}>
                  <MiniStat label="Correct" value={t.avoidAnalysis.correctAvoids} highlight />
                  <MiniStat label="Wrong" value={t.avoidAnalysis.wrongAvoids} bad={t.avoidAnalysis.wrongAvoids > 0} />
                </div>
              )}
              <PicksTable
                picks={isCompleted && t.avoidAnalysis ? t.avoidAnalysis.picks.map(p => ({
                  ...p,
                  performance: p.verdict
                })) : t.avoidPicks.map(p => ({ player: p.player, odds: p.odds, position: '—', performance: 'pending' }))}
                showOdds
                isAvoid
              />
            </>
          )}
        />
      )}

      {/* Matchups Section */}
      {t.matchups.length > 0 && (
        <ResultSection
          title="🆚 Matchups"
          isCompleted={isCompleted}
          analysis={t.matchupAnalysis}
          renderContent={() => (
            <>
              {isCompleted && t.matchupAnalysis && (
                <div style={{display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap'}}>
                  <MiniStat label="Wins" value={t.matchupAnalysis.wins} highlight={t.matchupAnalysis.wins > 0} />
                  <MiniStat label="Losses" value={t.matchupAnalysis.losses} bad={t.matchupAnalysis.losses > 0} />
                  {t.matchupAnalysis.pushes > 0 && <MiniStat label="Push" value={t.matchupAnalysis.pushes} />}
                </div>
              )}
              <MatchupsTable 
                matchups={isCompleted && t.matchupAnalysis ? t.matchupAnalysis.matchups : t.matchups.map(m => ({
                  pick: m.pick,
                  pickPosition: '—',
                  opponent: m.playerA?.name === m.pick ? m.playerB?.name : m.playerA?.name,
                  opponentPosition: '—',
                  result: 'pending'
                }))}
              />
            </>
          )}
        />
      )}

      {/* AI Self-Analysis (only for completed tournaments) */}
      <SelfAnalysis tournament={t.tournament} isCompleted={isCompleted} />
    </div>
  );
};

const ResultSection = ({ title, isCompleted, renderContent }) => (
  <div style={{
    background: '#f8f9fa',
    borderRadius: '8px',
    padding: '1rem',
    marginBottom: '0.75rem'
  }}>
    <h4 style={{margin: '0 0 0.75rem', fontSize: '0.95rem'}}>{title}</h4>
    {renderContent()}
  </div>
);

// ==================== WEATHER COMPARISON ====================
const WeatherComparison = ({ tournament }) => {
  const [weatherHistory, setWeatherHistory] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const loadWeatherHistory = async () => {
    if (weatherHistory) {
      setExpanded(!expanded);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(
        `/.netlify/functions/fetch-weather?tournament=${encodeURIComponent(tournament.name)}&tour=${tournament.tour || 'pga'}&history=true`
      );
      const data = await response.json();
      setWeatherHistory(data);
      setExpanded(true);
    } catch (err) {
      console.error('Failed to load weather history:', err);
    }
    setLoading(false);
  };

  const fetchActualWeather = async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `/.netlify/functions/fetch-weather?location=${encodeURIComponent(tournament.location || tournament.course)}&tournament=${encodeURIComponent(tournament.name)}&tour=${tournament.tour || 'pga'}&actual=true`
      );
      const data = await response.json();
      // Reload history to get updated comparison
      const histResponse = await fetch(
        `/.netlify/functions/fetch-weather?tournament=${encodeURIComponent(tournament.name)}&tour=${tournament.tour || 'pga'}&history=true`
      );
      const histData = await histResponse.json();
      setWeatherHistory(histData);
      setExpanded(true);
    } catch (err) {
      console.error('Failed to fetch actual weather:', err);
    }
    setLoading(false);
  };

  const comparison = weatherHistory?.comparison;
  const hasActual = !!weatherHistory?.actual;

  return (
    <div style={{
      background: '#f0f4ff',
      borderRadius: '8px',
      padding: '1rem',
      marginBottom: '0.75rem',
      border: '1px solid #d0d8f0'
    }}>
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem'}}>
        <h4 style={{margin: 0, fontSize: '0.95rem', cursor: 'pointer'}} onClick={loadWeatherHistory}>
          🌤️ Weather Accuracy {comparison ? (comparison.summary.avgWindDiff <= 5 ? '✅' : '⚠️') : ''}
        </h4>
        <div style={{display: 'flex', gap: '0.5rem'}}>
          {!hasActual && (
            <button 
              onClick={fetchActualWeather}
              disabled={loading}
              style={{
                padding: '0.25rem 0.6rem',
                borderRadius: '6px',
                border: '1px solid #667eea',
                background: 'white',
                color: '#667eea',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: loading ? 'wait' : 'pointer'
              }}
            >
              {loading ? '...' : '📡 Fetch Actual'}
            </button>
          )}
          <button 
            onClick={loadWeatherHistory}
            disabled={loading}
            style={{
              padding: '0.25rem 0.6rem',
              borderRadius: '6px',
              border: '1px solid #999',
              background: 'white',
              color: '#666',
              fontSize: '0.75rem',
              cursor: 'pointer'
            }}
          >
            {expanded ? '▲ Hide' : '▼ Show'}
          </button>
        </div>
      </div>

      {expanded && comparison && (
        <div style={{marginTop: '0.75rem'}}>
          {/* Summary badges */}
          <div style={{display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap'}}>
            <span style={{
              padding: '0.2rem 0.6rem', borderRadius: '12px', fontSize: '0.8rem', fontWeight: 600,
              background: comparison.summary.avgTempDeviation <= 5 ? '#e8f5e9' : '#ffebee',
              color: comparison.summary.avgTempDeviation <= 5 ? '#2e7d32' : '#c62828'
            }}>
              Temp: ±{comparison.summary.avgTempDeviation}°F avg
            </span>
            <span style={{
              padding: '0.2rem 0.6rem', borderRadius: '12px', fontSize: '0.8rem', fontWeight: 600,
              background: comparison.summary.avgWindDeviation <= 5 ? '#e8f5e9' : '#ffebee',
              color: comparison.summary.avgWindDeviation <= 5 ? '#2e7d32' : '#c62828'
            }}>
              Wind: ±{comparison.summary.avgWindDeviation}mph avg
            </span>
            <span style={{
              padding: '0.2rem 0.6rem', borderRadius: '12px', fontSize: '0.8rem', fontWeight: 600,
              background: '#e3e8f0', color: '#444'
            }}>
              {comparison.summary.forecastCount} snapshots
            </span>
          </div>

          {/* Day-by-day comparison table */}
          <div style={{overflowX: 'auto'}}>
            <table style={{width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem'}}>
              <thead>
                <tr style={{borderBottom: '2px solid #ccc'}}>
                  <th style={{textAlign: 'left', padding: '0.4rem'}}>Day</th>
                  <th style={{textAlign: 'center', padding: '0.4rem'}}>Forecast Temp</th>
                  <th style={{textAlign: 'center', padding: '0.4rem'}}>Actual Temp</th>
                  <th style={{textAlign: 'center', padding: '0.4rem'}}>Forecast Wind</th>
                  <th style={{textAlign: 'center', padding: '0.4rem'}}>Actual Wind</th>
                  <th style={{textAlign: 'center', padding: '0.4rem'}}>Deviation</th>
                </tr>
              </thead>
              <tbody>
                {comparison.days.map((day, i) => {
                  const windOff = day.deviation ? Math.abs(day.deviation.windDiff) : 0;
                  const tempOff = day.deviation ? Math.abs(day.deviation.tempDiff) : 0;
                  const isOff = windOff > 8 || tempOff > 10;
                  return (
                    <tr key={i} style={{borderBottom: '1px solid #eee', background: isOff ? '#fff8e1' : 'transparent'}}>
                      <td style={{padding: '0.4rem', fontWeight: 600}}>{day.day}</td>
                      <td style={{textAlign: 'center', padding: '0.4rem'}}>{day.firstForecast?.tempHigh}°F</td>
                      <td style={{textAlign: 'center', padding: '0.4rem', fontWeight: 600}}>{day.actual?.tempHigh}°F</td>
                      <td style={{textAlign: 'center', padding: '0.4rem'}}>{day.firstForecast?.windSpeed}mph</td>
                      <td style={{textAlign: 'center', padding: '0.4rem', fontWeight: 600}}>{day.actual?.windSpeed}mph</td>
                      <td style={{textAlign: 'center', padding: '0.4rem'}}>
                        {day.deviation && (
                          <span style={{
                            padding: '0.1rem 0.4rem', borderRadius: '8px', fontSize: '0.75rem', fontWeight: 600,
                            background: isOff ? '#ffebee' : '#e8f5e9',
                            color: isOff ? '#c62828' : '#2e7d32'
                          }}>
                            {day.deviation.windDiff > 0 ? '+' : ''}{day.deviation.windDiff}mph / {day.deviation.tempDiff > 0 ? '+' : ''}{day.deviation.tempDiff}°F
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Forecast timeline note */}
          <div style={{marginTop: '0.5rem', fontSize: '0.75rem', color: '#888'}}>
            First forecast: {new Date(comparison.summary.firstForecastAt).toLocaleString()} • 
            Last update: {new Date(comparison.summary.lastForecastAt).toLocaleString()}
          </div>
        </div>
      )}

      {expanded && !comparison && weatherHistory && (
        <div style={{marginTop: '0.75rem', color: '#888', fontSize: '0.85rem'}}>
          {hasActual ? 'No forecast data available to compare.' : 
           weatherHistory.snapshotCount > 0 
             ? `${weatherHistory.snapshotCount} forecast snapshots saved. Click "Fetch Actual" after the tournament to see comparison.`
             : 'No weather data recorded for this tournament yet.'}
        </div>
      )}
    </div>
  );
};

// ==================== SELF-ANALYSIS ====================
const SelfAnalysis = ({ tournament, isCompleted }) => {
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(true);

  const runAnalysis = async (forceRefresh = false) => {
    if (analysis && !forceRefresh) {
      setExpanded(!expanded);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const refreshParam = forceRefresh ? '&refresh=true' : '';
      const response = await fetch(
        `/.netlify/functions/analyze-results?tournament=${encodeURIComponent(tournament.name)}&tour=${tournament.tour || 'pga'}${refreshParam}`
      );
      const data = await response.json();
      if (data.error) {
        setError(data.error);
      } else {
        setAnalysis(data);
        setExpanded(true);
      }
    } catch (err) {
      setError('Failed to run analysis: ' + err.message);
    }
    setLoading(false);
  };

  if (!isCompleted) return null;

  const a = analysis?.analysis;
  const gradeColor = {
    'A': '#2e7d32', 'B': '#388e3c', 'C': '#f57f17', 'D': '#e65100', 'F': '#c62828'
  };

  return (
    <div style={{
      background: '#faf8ff',
      borderRadius: '8px',
      padding: '1rem',
      marginBottom: '0.75rem',
      border: '1px solid #d4c8f0'
    }}>
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem'}}>
        <h4 style={{margin: 0, fontSize: '0.95rem'}}>
          🔍 AI Self-Analysis {a ? `— Grade: ` : ''}
          {a && (
            <span style={{
              padding: '0.15rem 0.5rem',
              borderRadius: '8px',
              background: gradeColor[a.overallGrade] || '#666',
              color: 'white',
              fontSize: '0.85rem'
            }}>
              {a.overallGrade}
            </span>
          )}
        </h4>
        <div style={{display: 'flex', gap: '0.4rem'}}>
          {analysis?.cached && (
            <button
              onClick={() => runAnalysis(true)}
              disabled={loading}
              style={{
                padding: '0.3rem 0.6rem',
                borderRadius: '6px',
                border: '1px solid #764ba2',
                background: 'white',
                color: '#764ba2',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: loading ? 'wait' : 'pointer'
              }}
            >
              🔄 Re-analyze
            </button>
          )}
          <button
            onClick={() => runAnalysis(false)}
            disabled={loading}
            style={{
              padding: '0.3rem 0.8rem',
              borderRadius: '6px',
              border: 'none',
              background: loading ? '#ccc' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
              color: 'white',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: loading ? 'wait' : 'pointer'
            }}
          >
            {loading ? '⏳ Analyzing...' : analysis ? (expanded ? '▲ Hide' : '▼ Show') : '🧠 Run Analysis'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{marginTop: '0.5rem', color: '#c62828', fontSize: '0.85rem'}}>
          ⚠️ {error}
        </div>
      )}

      {expanded && a && (
        <div style={{marginTop: '0.75rem'}}>
          {/* Summary */}
          <p style={{margin: '0 0 0.75rem', fontSize: '0.9rem', lineHeight: 1.5, color: '#333'}}>
            {a.summary}
          </p>

          {/* Correct Calls */}
          {a.correctCalls?.length > 0 && (
            <div style={{marginBottom: '0.75rem'}}>
              <h5 style={{margin: '0 0 0.4rem', fontSize: '0.85rem', color: '#2e7d32'}}>✅ What Worked</h5>
              {a.correctCalls.map((c, i) => (
                <div key={i} style={{
                  background: '#e8f5e9', borderRadius: '6px', padding: '0.5rem 0.75rem', marginBottom: '0.4rem', fontSize: '0.85rem'
                }}>
                  <strong>{c.what}</strong>
                  <div style={{color: '#555', marginTop: '0.2rem'}}>{c.why}</div>
                </div>
              ))}
            </div>
          )}

          {/* Mistakes */}
          {a.mistakes?.length > 0 && (
            <div style={{marginBottom: '0.75rem'}}>
              <h5 style={{margin: '0 0 0.4rem', fontSize: '0.85rem', color: '#c62828'}}>❌ Mistakes</h5>
              {a.mistakes.map((m, i) => (
                <div key={i} style={{
                  background: m.severity === 'high' ? '#ffebee' : m.severity === 'medium' ? '#fff8e1' : '#f5f5f5',
                  borderRadius: '6px', padding: '0.5rem 0.75rem', marginBottom: '0.4rem', fontSize: '0.85rem',
                  borderLeft: `3px solid ${m.severity === 'high' ? '#c62828' : m.severity === 'medium' ? '#f57f17' : '#999'}`
                }}>
                  <strong>{m.what}</strong>
                  <span style={{
                    marginLeft: '0.5rem', padding: '0.1rem 0.4rem', borderRadius: '8px', fontSize: '0.7rem',
                    fontWeight: 600, background: m.severity === 'high' ? '#c62828' : m.severity === 'medium' ? '#f57f17' : '#999',
                    color: 'white'
                  }}>
                    {m.severity}
                  </span>
                  <div style={{color: '#555', marginTop: '0.2rem'}}>{m.why}</div>
                </div>
              ))}
            </div>
          )}

          {/* Weather Impact */}
          {a.weatherImpact && (
            <div style={{
              background: '#e3f2fd', borderRadius: '6px', padding: '0.5rem 0.75rem', marginBottom: '0.75rem', fontSize: '0.85rem'
            }}>
              <strong>🌤️ Weather Impact:</strong> {a.weatherImpact}
            </div>
          )}

          {/* Lessons Learned */}
          {a.lessonsLearned?.length > 0 && (
            <div style={{marginBottom: '0.75rem'}}>
              <h5 style={{margin: '0 0 0.4rem', fontSize: '0.85rem', color: '#1565c0'}}>📚 Lessons Learned</h5>
              {a.lessonsLearned.map((lesson, i) => (
                <div key={i} style={{
                  background: '#e8eaf6', borderRadius: '6px', padding: '0.4rem 0.75rem', marginBottom: '0.3rem', fontSize: '0.85rem'
                }}>
                  {lesson}
                </div>
              ))}
            </div>
          )}

          {/* Adjustments */}
          {a.adjustments?.length > 0 && (
            <div style={{marginBottom: '0.5rem'}}>
              <h5 style={{margin: '0 0 0.4rem', fontSize: '0.85rem', color: '#7b1fa2'}}>🔧 Suggested Adjustments</h5>
              {a.adjustments.map((adj, i) => (
                <div key={i} style={{
                  background: '#f3e5f5', borderRadius: '6px', padding: '0.4rem 0.75rem', marginBottom: '0.3rem', fontSize: '0.85rem'
                }}>
                  {adj}
                </div>
              ))}
            </div>
          )}

          {/* Meta info */}
          <div style={{fontSize: '0.75rem', color: '#999', marginTop: '0.5rem'}}>
            Analysis generated {new Date(analysis.generatedAt).toLocaleString()}
            {analysis.cached && ' (cached)'}
            {analysis.cost && ` • Cost: ${analysis.cost.formatted}`}
          </div>
        </div>
      )}
    </div>
  );
};

const MiniStat = ({ label, value, highlight, bad }) => (
  <span style={{
    padding: '0.2rem 0.6rem',
    borderRadius: '12px',
    fontSize: '0.8rem',
    fontWeight: 600,
    background: highlight ? '#e8f5e9' : bad ? '#ffebee' : '#e3e8f0',
    color: highlight ? '#2e7d32' : bad ? '#c62828' : '#444'
  }}>
    {label}: {value}
  </span>
);

const PicksTable = ({ picks, showOdds, showROI, isAvoid }) => (
  <div style={{overflowX: 'auto'}}>
    <table style={{width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem'}}>
      <thead>
        <tr style={{borderBottom: '2px solid #ddd'}}>
          <th style={{textAlign: 'left', padding: '0.4rem 0.5rem'}}>Player</th>
          {showOdds && <th style={{textAlign: 'center', padding: '0.4rem 0.5rem'}}>Odds</th>}
          <th style={{textAlign: 'center', padding: '0.4rem 0.5rem'}}>Finish</th>
          <th style={{textAlign: 'center', padding: '0.4rem 0.5rem'}}>{isAvoid ? 'Verdict' : 'Result'}</th>
          {showROI && <th style={{textAlign: 'right', padding: '0.4rem 0.5rem'}}>ROI</th>}
        </tr>
      </thead>
      <tbody>
        {picks.map((pick, i) => {
          const perfColor = getPerformanceColor(pick.performance, isAvoid);
          return (
            <tr key={i} style={{borderBottom: '1px solid #eee'}}>
              <td style={{padding: '0.4rem 0.5rem', fontWeight: 500}}>{pick.player}</td>
              {showOdds && <td style={{textAlign: 'center', padding: '0.4rem 0.5rem', color: '#667eea', fontWeight: 600}}>
                {formatAmericanOdds(pick.odds)}
              </td>}
              <td style={{textAlign: 'center', padding: '0.4rem 0.5rem', fontWeight: 600}}>
                {pick.position}
              </td>
              <td style={{textAlign: 'center', padding: '0.4rem 0.5rem'}}>
                <span style={{
                  padding: '0.15rem 0.5rem',
                  borderRadius: '10px',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  background: perfColor.bg,
                  color: perfColor.text
                }}>
                  {getPerformanceLabel(pick.performance, isAvoid)}
                </span>
              </td>
              {showROI && <td style={{
                textAlign: 'right',
                padding: '0.4rem 0.5rem',
                fontWeight: 600,
                color: (pick.roi || 0) >= 0 ? '#2e7d32' : '#c62828'
              }}>
                {(pick.roi || 0) >= 0 ? '+' : ''}${(pick.roi || 0).toFixed(0)}
              </td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

const MatchupsTable = ({ matchups }) => (
  <div style={{overflowX: 'auto'}}>
    <table style={{width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem'}}>
      <thead>
        <tr style={{borderBottom: '2px solid #ddd'}}>
          <th style={{textAlign: 'left', padding: '0.4rem 0.5rem'}}>Our Pick</th>
          <th style={{textAlign: 'center', padding: '0.4rem 0.5rem'}}>Pos</th>
          <th style={{textAlign: 'center', padding: '0.4rem 0.5rem'}}>vs</th>
          <th style={{textAlign: 'left', padding: '0.4rem 0.5rem'}}>Opponent</th>
          <th style={{textAlign: 'center', padding: '0.4rem 0.5rem'}}>Pos</th>
          <th style={{textAlign: 'center', padding: '0.4rem 0.5rem'}}>Result</th>
        </tr>
      </thead>
      <tbody>
        {matchups.map((m, i) => {
          const resultColor = m.result === 'win' ? {bg: '#e8f5e9', text: '#2e7d32'} :
                              m.result === 'loss' ? {bg: '#ffebee', text: '#c62828'} :
                              {bg: '#e3e8f0', text: '#444'};
          return (
            <tr key={i} style={{borderBottom: '1px solid #eee'}}>
              <td style={{padding: '0.4rem 0.5rem', fontWeight: 600}}>{m.pick}</td>
              <td style={{textAlign: 'center', padding: '0.4rem 0.5rem'}}>{m.pickPosition}</td>
              <td style={{textAlign: 'center', padding: '0.4rem 0.5rem', color: '#999'}}>vs</td>
              <td style={{padding: '0.4rem 0.5rem'}}>{m.opponent}</td>
              <td style={{textAlign: 'center', padding: '0.4rem 0.5rem'}}>{m.opponentPosition}</td>
              <td style={{textAlign: 'center', padding: '0.4rem 0.5rem'}}>
                <span style={{
                  padding: '0.15rem 0.5rem',
                  borderRadius: '10px',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  background: resultColor.bg,
                  color: resultColor.text
                }}>
                  {m.result === 'win' ? '✅ Win' : m.result === 'loss' ? '❌ Loss' : m.result === 'push' ? '🤝 Push' : '⏳'}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

function getPerformanceColor(perf, isAvoid) {
  if (isAvoid) {
    if (perf === 'correct') return {bg: '#e8f5e9', text: '#2e7d32'};
    if (perf === 'wrong') return {bg: '#ffebee', text: '#c62828'};
    return {bg: '#e3e8f0', text: '#444'};
  }
  if (perf === 'win') return {bg: '#ffd700', text: '#333'};
  if (perf === 'top-5') return {bg: '#e8f5e9', text: '#2e7d32'};
  if (perf === 'top-10') return {bg: '#e8f5e9', text: '#388e3c'};
  if (perf === 'top-20') return {bg: '#e3f2fd', text: '#1565c0'};
  if (perf === 'made-cut') return {bg: '#f5f5f5', text: '#666'};
  if (perf === 'missed-cut') return {bg: '#ffebee', text: '#c62828'};
  return {bg: '#e3e8f0', text: '#444'};
}

function getPerformanceLabel(perf, isAvoid) {
  if (isAvoid) {
    if (perf === 'correct') return '✅ Correct';
    if (perf === 'wrong') return '❌ Wrong';
    return '⏳ Pending';
  }
  if (perf === 'win') return '🏆 Win!';
  if (perf === 'top-5') return 'Top 5';
  if (perf === 'top-10') return 'Top 10';
  if (perf === 'top-20') return 'Top 20';
  if (perf === 'made-cut') return 'Made Cut';
  if (perf === 'missed-cut') return 'MC';
  if (perf === 'not-found') return '?';
  return '⏳ Pending';
}

export default App;
