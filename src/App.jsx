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
    results: null
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [requestId, setRequestId] = useState(0);
  const hasAutoLoadedRef = useRef(false);

  // Generic fetch function to avoid duplication
  const fetchData = useCallback(async (endpoint, method = 'GET', body = null, dataKey) => {
    const newRequestId = requestId + 1;
    setRequestId(newRequestId);
    setError(null);
    setLoading(true);
    
    try {
      const timestamp = Date.now();
      const options = {
        method,
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        }
      };
      
      if (body) {
        options.body = JSON.stringify({ ...body, _: timestamp });
      }
      
      const url = method === 'GET' 
        ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}_=${timestamp}`
        : endpoint;
      
      const response = await fetch(url, options);
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Request failed');
      }
      
      const responseData = await response.json();
      setData(prev => ({ ...prev, [dataKey]: responseData }));
      
    } catch (err) {
      setError(err.message);
      console.error('Fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  const handleGetPredictions = () => 
    fetchData(`/.netlify/functions/get-predictions?tour=${tour}`, 'GET', null, 'predictions');
  
  const handleGetAvoidPicks = () => {
    // Get current value picks if they exist
    const valuePicks = data.predictions?.predictions?.map(p => p.player) || [];
    fetchData(`/.netlify/functions/get-avoid-picks`, 'POST', { 
      tour,
      excludePlayers: valuePicks 
    }, 'avoidPicks');
  };
  
  const handleGetNews = () => 
    fetchData(`/.netlify/functions/get-tournament-news?tour=${tour}`, 'GET', null, 'newsPreview');
  
  const handleGetMatchups = () => 
    fetchData(`/.netlify/functions/get-matchup-predictions`, 'POST', { tour }, 'matchups');

  const handleGetResults = () => 
    fetchData(`/.netlify/functions/get-prediction-results`, 'GET', null, 'results');

  const handleTourChange = (newTour) => {
    setTour(newTour);
    setError(null);
    setRequestId(prev => prev + 1);
    
    // Try to load latest predictions for new tour from Blobs
    console.log(`[TOUR] Switching to ${newTour}, loading latest from Blobs...`);
    fetchData(`/.netlify/functions/get-latest-predictions?tour=${newTour}`, 'GET', null, 'predictions')
      .catch(() => {
        // If no cached predictions, clear data and wait for user to click
        setData({
          predictions: null,
          avoidPicks: null,
          newsPreview: null,
          matchups: null,
          results: null
        });
        console.log(`[TOUR] No cached predictions for ${newTour}`);
      });
  };

  // Auto-load latest predictions from Netlify Blobs on mount
  useEffect(() => {
    if (!hasAutoLoadedRef.current && !loading) {
      console.log('[AUTO-LOAD] Loading latest predictions from Blobs');
      hasAutoLoadedRef.current = true;
      
      // Try to load latest from Blobs first
      fetchData(`/.netlify/functions/get-latest-predictions?tour=${tour}`, 'GET', null, 'predictions')
        .catch(() => {
          // If no cached predictions found, that's OK - user will click button
          console.log('[AUTO-LOAD] No cached predictions, waiting for user action');
        });
    }
  }, []); // Empty array is safe with ref - truly runs once

  const currentData = data[
    activeTab === 'predictions' ? 'predictions' :
    activeTab === 'avoid' ? 'avoidPicks' :
    activeTab === 'news' ? 'newsPreview' : 
    activeTab === 'results' ? 'results' : 'matchups'
  ];

  return (
    <div className="app">
      <Header />
      
      <TourSelector tour={tour} onTourChange={handleTourChange} disabled={loading} />
      
      <TabSelector activeTab={activeTab} onTabChange={setActiveTab} disabled={loading} />
      
      <ActionButton 
        activeTab={activeTab}
        loading={loading}
        onGetPredictions={handleGetPredictions}
        onGetAvoidPicks={handleGetAvoidPicks}
        onGetNews={handleGetNews}
        onGetMatchups={handleGetMatchups}
        onGetResults={handleGetResults}
      />

      {loading && <LoadingState requestId={requestId} />}
      
      {error && !loading && <ErrorState error={error} onRetry={handleGetPredictions} requestId={requestId} />}

      {currentData && !loading && !error && (
        <>
          {activeTab === 'predictions' && <PredictionsView data={currentData} requestId={requestId} />}
          {activeTab === 'avoid' && <AvoidPicksView data={currentData} requestId={requestId} />}
          {activeTab === 'news' && <NewsPreviewView data={currentData} requestId={requestId} />}
          {activeTab === 'matchups' && <MatchupsView data={currentData} requestId={requestId} />}
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
const PredictionsView = ({ data, requestId }) => {
  // Check if data is from cache (generated more than 1 minute ago)
  const generatedTime = new Date(data.generatedAt).getTime();
  const now = Date.now();
  const isCached = (now - generatedTime) > 60000; // More than 1 minute old = cached
  
  return (
    <div className="predictions-container loaded" key={`predictions-${requestId}-${data.generatedAt}`}>
      <div className={`cache-indicator ${isCached ? 'cached' : 'fresh'}`}>
        {isCached ? 'Cached' : 'Fresh'}
      </div>
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
                <span className="pick-odds">{formatAmericanOdds(pick.odds)}</span>
              </div>
            </div>
            <h3 className="pick-name">{pick.player}</h3>
            <OddsBreakdown pick={pick} />
            <div className="pick-reasoning">
              {pick.reasoning.split('. ').filter(s => s.trim()).map((sentence, i, arr) => (
                <p key={i} style={{marginBottom: '0.5rem', lineHeight: '1.6', fontSize: '0.95rem'}}>
                  {sentence.trim()}{i < arr.length - 1 || !sentence.endsWith('.') ? '.' : ''}
                </p>
              ))}
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
const AvoidPicksView = ({ data, requestId }) => (
  <div className="avoid-picks-container" key={`avoid-${requestId}-${data.generatedAt}`}>
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
              <span className="avoid-odds">{formatAmericanOdds(avoid.odds)}</span>
            </div>
            <h4 className="avoid-name">{avoid.player}</h4>
            <p className="avoid-reasoning">{avoid.reasoning}</p>
          </div>
        ))}
      </div>
    </div>
    
    <FooterInfo data={data} />
  </div>
);

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
const MatchupsView = ({ data, requestId }) => {
  const generatedTime = new Date(data.generatedAt).getTime();
  const now = Date.now();
  const isCached = (now - generatedTime) > 60000;
  
  return (
    <div className="matchup-container loaded" key={`matchup-${requestId}-${data.generatedAt}`}>
      <div className={`cache-indicator ${isCached ? 'cached' : 'fresh'}`}>
        {isCached ? 'Cached' : 'Fresh'}
      </div>
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
              <PlayerBox player={matchup.playerA} isPick={matchup.pick === matchup.playerA.name} />
              <div className="vs-divider">VS</div>
              <PlayerBox player={matchup.playerB} isPick={matchup.pick === matchup.playerB.name} />
            </div>
            <div className="matchup-analysis">
              <div className="win-probability">
                Win Probability: <strong>{matchup.winProbability}%</strong>
              </div>
              <p className="matchup-reasoning">{matchup.reasoning}</p>
            </div>
          </div>
        ))}
      </div>
    )}
    
    <FooterInfo data={data} />
  </div>
  );
};

const PlayerBox = ({ player, isPick }) => (
  <div className={`player-box ${isPick ? 'winner' : ''}`}>
    <h4>{player.name}</h4>
    <div className="player-odds">{formatAmericanOdds(player.odds)}</div>
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

// ==================== RESULTS VIEW ====================
const ResultsView = ({ data, requestId }) => {
  if (!data.tournaments || data.tournaments.length === 0) {
    return (
      <div className="predictions-container" key={`results-${requestId}`}>
        <div style={{textAlign: 'center', padding: '4rem 2rem'}}>
          <h3>No Predictions Saved Yet</h3>
          <p>Generate some predictions first, and they'll automatically be saved for results tracking!</p>
        </div>
      </div>
    );
  }

  return (
    <div className="predictions-container" key={`results-${requestId}`}>
      {data.generatedAt && <TimestampHeader generatedAt={data.generatedAt} />}
      
      <div style={{textAlign: 'center', marginBottom: '2rem'}}>
        <h2>🏆 Prediction Results History</h2>
        <div style={{display: 'flex', gap: '1rem', justifyContent: 'center', marginTop: '1rem', flexWrap: 'wrap'}}>
          <span style={{background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: 'white', padding: '0.5rem 1rem', borderRadius: '20px', fontWeight: 600}}>
            📊 {data.totalPredictions || 0} Total Picks
          </span>
          <span style={{background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: 'white', padding: '0.5rem 1rem', borderRadius: '20px', fontWeight: 600}}>
            ✅ {data.completedTournaments || 0} Completed
          </span>
        </div>
      </div>

      <div>
        {data.tournaments.map((tournament, index) => (
          <div key={index} style={{background: 'white', borderRadius: '12px', padding: '2rem', marginBottom: '2rem', boxShadow: '0 4px 6px rgba(0,0,0,0.1)', border: tournament.status === 'completed' ? '2px solid #4caf50' : '2px solid #ff9800'}}>
            <div style={{borderBottom: '2px solid #f0f0f0', paddingBottom: '1rem', marginBottom: '1.5rem'}}>
              <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem'}}>
                <h3 style={{margin: 0}}>{tournament.tournament.name}</h3>
                <span style={{padding: '0.4rem 1rem', borderRadius: '20px', fontSize: '0.85rem', fontWeight: 600, background: tournament.status === 'completed' ? '#e8f5e9' : '#fff3e0', color: tournament.status === 'completed' ? '#2e7d32' : '#e65100'}}>
                  {tournament.status === 'completed' ? '✅ Completed' : '⏳ Pending'}
                </span>
              </div>
              <div style={{display: 'flex', gap: '1.5rem', color: '#666', fontSize: '0.9rem', flexWrap: 'wrap'}}>
                <span>📍 {tournament.tournament.course}</span>
                <span>📅 {tournament.tournament.dates}</span>
                <span style={{fontWeight: '600', color: '#667eea'}}>
                  🕐 Predicted: {new Date(tournament.generatedAt).toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true
                  })}
                </span>
              </div>
            </div>

            {tournament.status === 'completed' && tournament.analysis ? (
              <div>
                <h4>📈 Performance</h4>
                <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: '1rem', marginBottom: '1.5rem'}}>
                  <div style={{background: '#f8f9fa', padding: '1rem', borderRadius: '8px', textAlign: 'center', border: '2px solid #e0e0e0'}}>
                    <div style={{fontSize: '0.85rem', color: '#666', marginBottom: '0.3rem'}}>Wins</div>
                    <div style={{fontSize: '2rem', fontWeight: 'bold'}}>{tournament.analysis.wins}/{tournament.analysis.totalPicks}</div>
                  </div>
                  <div style={{background: '#f8f9fa', padding: '1rem', borderRadius: '8px', textAlign: 'center', border: '2px solid #e0e0e0'}}>
                    <div style={{fontSize: '0.85rem', color: '#666', marginBottom: '0.3rem'}}>Top 5</div>
                    <div style={{fontSize: '2rem', fontWeight: 'bold'}}>{tournament.analysis.top5s}/{tournament.analysis.totalPicks}</div>
                  </div>
                  <div style={{background: '#f8f9fa', padding: '1rem', borderRadius: '8px', textAlign: 'center', border: '2px solid #e0e0e0'}}>
                    <div style={{fontSize: '0.85rem', color: '#666', marginBottom: '0.3rem'}}>Top 10</div>
                    <div style={{fontSize: '2rem', fontWeight: 'bold'}}>{tournament.analysis.top10s}/{tournament.analysis.totalPicks}</div>
                  </div>
                  <div style={{background: '#f8f9fa', padding: '1rem', borderRadius: '8px', textAlign: 'center', border: '2px solid #e0e0e0'}}>
                    <div style={{fontSize: '0.85rem', color: '#666', marginBottom: '0.3rem'}}>Made Cut</div>
                    <div style={{fontSize: '2rem', fontWeight: 'bold'}}>{tournament.analysis.madeCut}/{tournament.analysis.totalPicks}</div>
                  </div>
                </div>
                <div style={{background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', padding: '1.5rem', borderRadius: '8px', color: 'white', textAlign: 'center'}}>
                  <div style={{fontSize: '0.9rem', marginBottom: '0.5rem', opacity: 0.9}}>Total ROI ($100/pick)</div>
                  <div style={{fontSize: '2.5rem', fontWeight: 'bold', color: tournament.analysis.totalROI >= 0 ? '#4caf50' : '#f44336', background: 'white', padding: '0.5rem', borderRadius: '8px'}}>
                    {tournament.analysis.totalROI >= 0 ? '+' : ''}${tournament.analysis.totalROI.toFixed(2)}
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <p style={{color: '#666'}}>Waiting for tournament to complete...</p>
                <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '1rem', marginTop: '1rem'}}>
                  {tournament.predictions.map((pick, idx) => (
                    <div key={idx} style={{background: '#f8f9fa', border: '2px solid #ff9800', borderRadius: '8px', padding: '1rem'}}>
                      <h5 style={{margin: '0 0 0.5rem 0'}}>{pick.player}</h5>
                      <div style={{fontSize: '1.3rem', fontWeight: 'bold', color: '#667eea'}}>{formatAmericanOdds(pick.odds)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default App;
