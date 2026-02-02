import React, { useState, useCallback } from 'react';
import './App.css';

/**
 * OPTIMIZED App.jsx
 * - Extracted reusable components
 * - Reduced code duplication
 * - Better state management
 * - Cleaner structure
 */

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
        ? `${endpoint}&_=${timestamp}`
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
  
  const handleGetAvoidPicks = () => 
    fetchData(`/.netlify/functions/get-avoid-picks`, 'POST', { tour }, 'avoidPicks');
  
  const handleGetNews = () => 
    fetchData(`/.netlify/functions/get-tournament-news?tour=${tour}`, 'GET', null, 'newsPreview');
  
  const handleGetMatchups = () => 
    fetchData(`/.netlify/functions/get-matchup-predictions`, 'POST', { tour }, 'matchups');

  const handleGetResults = () => 
    fetchData(`/.netlify/functions/get-prediction-results`, 'GET', null, 'results');

  const handleTourChange = (newTour) => {
    setTour(newTour);
    setData({ predictions: null, avoidPicks: null, newsPreview: null, matchups: null, results: null });
    setError(null);
    setRequestId(prev => prev + 1);
  };

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
    <p>Analyzing complete tournament field...</p>
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

  return (
    <div className="odds-breakdown">
      <div className="odds-breakdown-item">
        <span className="odds-breakdown-label">Best:</span>
        <span className="odds-breakdown-value best">{Math.round(pick.minOdds)}/1</span>
        {pick.bestBookmaker && <span className="odds-breakdown-book">({pick.bestBookmaker})</span>}
      </div>
      <div className="odds-breakdown-item">
        <span className="odds-breakdown-label">Avg:</span>
        <span className="odds-breakdown-value avg">{Math.round(pick.odds)}/1</span>
      </div>
      <div className="odds-breakdown-item">
        <span className="odds-breakdown-label">Worst:</span>
        <span className="odds-breakdown-value worst">{Math.round(pick.maxOdds)}/1</span>
        {pick.worstBookmaker && <span className="odds-breakdown-book">({pick.worstBookmaker})</span>}
      </div>
    </div>
  );
};

const FooterInfo = ({ data }) => (
  <div className="footer-info">
    <p className="generated-time">
      Generated: {new Date(data.generatedAt).toLocaleString()}
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

// ==================== PREDICTIONS VIEW ====================
const PredictionsView = ({ data, requestId }) => (
  <div className="predictions-container" key={`predictions-${requestId}-${data.generatedAt}`}>
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
                <span className="pick-odds">{Math.round(pick.odds)}/1</span>
              </div>
            </div>
            <h3 className="pick-name">{pick.player}</h3>
            <OddsBreakdown pick={pick} />
            <p className="pick-reasoning">{pick.reasoning}</p>
          </div>
        ))}
      </div>
    </div>
    
    <FooterInfo data={data} />
  </div>
);

// ==================== AVOID PICKS VIEW ====================
const AvoidPicksView = ({ data, requestId }) => (
  <div className="avoid-picks-container" key={`avoid-${requestId}-${data.generatedAt}`}>
    <TournamentInfo tournament={data.tournament} />
    
    <div className="avoid-section">
      <h3>❌ Players to Avoid (Poor Course Fit)</h3>
      <p className="avoid-subtitle">{data.reasoning}</p>
      <div className="avoid-grid">
        {data.avoidPicks?.map((avoid, index) => (
          <div key={`avoid-${requestId}-${index}`} className="avoid-card">
            <div className="avoid-header">
              <span className="avoid-icon">⚠️</span>
              <span className="avoid-odds">{Math.round(avoid.odds)}/1</span>
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
const NewsPreviewView = ({ data, requestId }) => (
  <div className="news-preview-container" key={`news-${requestId}-${data.generatedAt}`}>
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

// ==================== MATCHUPS VIEW ====================
const MatchupsView = ({ data, requestId }) => (
  <div className="matchup-container" key={`matchup-${requestId}-${data.generatedAt}`}>
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

const PlayerBox = ({ player, isPick }) => (
  <div className={`player-box ${isPick ? 'winner' : ''}`}>
    <h4>{player.name}</h4>
    <div className="player-odds">{Math.round(player.odds)}/1</div>
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
      <div className="results-container" key={`results-${requestId}`}>
        <div className="empty-state">
          <h3>No Predictions Saved Yet</h3>
          <p>Generate some predictions first, and they'll automatically be saved for results tracking!</p>
        </div>
      </div>
    );
  }

  return (
    <div className="results-container" key={`results-${requestId}`}>
      <div className="results-header">
        <h2>🏆 Prediction Results History</h2>
        <div className="results-stats">
          <span className="stat-badge">📊 {data.totalPredictions} Total Picks</span>
          <span className="stat-badge">✅ {data.completedTournaments} Completed</span>
          <span className="stat-badge">⏳ {data.tournaments.length - data.completedTournaments} Pending</span>
        </div>
      </div>

      <div className="tournaments-results">
        {data.tournaments.map((tournament, index) => (
          <TournamentResultCard key={index} tournament={tournament} />
        ))}
      </div>
    </div>
  );
};

const TournamentResultCard = ({ tournament }) => {
  const { tournament: info, predictions, results, analysis, status, generatedAt } = tournament;

  return (
    <div className={`tournament-result-card status-${status}`}>
      <div className="tournament-result-header">
        <div className="tournament-result-title">
          <h3>{info.name}</h3>
          <span className={`status-badge status-${status}`}>
            {status === 'completed' ? '✅ Completed' : '⏳ In Progress'}
          </span>
        </div>
        <div className="tournament-result-meta">
          <span>📍 {info.course}</span>
          <span>📅 {info.dates}</span>
          <span>🔮 Predicted: {new Date(generatedAt).toLocaleDateString()}</span>
        </div>
      </div>

      {status === 'completed' && analysis ? (
        <>
          {/* Performance Summary */}
          <div className="performance-summary">
            <h4>📈 Performance Summary</h4>
            <div className="performance-stats">
              <div className="perf-stat highlight">
                <span className="perf-label">Wins</span>
                <span className="perf-value">{analysis.wins}</span>
                <span className="perf-count">/ {analysis.totalPicks}</span>
              </div>
              <div className="perf-stat good">
                <span className="perf-label">Top 5</span>
                <span className="perf-value">{analysis.top5s}</span>
                <span className="perf-count">/ {analysis.totalPicks}</span>
              </div>
              <div className="perf-stat">
                <span className="perf-label">Top 10</span>
                <span className="perf-value">{analysis.top10s}</span>
                <span className="perf-count">/ {analysis.totalPicks}</span>
              </div>
              <div className="perf-stat">
                <span className="perf-label">Top 20</span>
                <span className="perf-value">{analysis.top20s}</span>
                <span className="perf-count">/ {analysis.totalPicks}</span>
              </div>
              <div className="perf-stat">
                <span className="perf-label">Made Cut</span>
                <span className="perf-value">{analysis.madeCut}</span>
                <span className="perf-count">/ {analysis.totalPicks}</span>
              </div>
              <div className="perf-stat bad">
                <span className="perf-label">Missed Cut</span>
                <span className="perf-value">{analysis.missedCut}</span>
                <span className="perf-count">/ {analysis.totalPicks}</span>
              </div>
            </div>
            
            <div className="roi-summary">
              <div className="roi-stat">
                <span className="roi-label">Total ROI ($100/pick)</span>
                <span className={`roi-value ${analysis.totalROI >= 0 ? 'positive' : 'negative'}`}>
                  {analysis.totalROI >= 0 ? '+' : ''}${analysis.totalROI.toFixed(2)}
                </span>
              </div>
              <div className="roi-stat">
                <span className="roi-label">Avg ROI per pick</span>
                <span className={`roi-value ${analysis.avgROI >= 0 ? 'positive' : 'negative'}`}>
                  {analysis.avgROI >= 0 ? '+' : ''}${analysis.avgROI.toFixed(2)}
                </span>
              </div>
            </div>
          </div>

          {/* Detailed Picks */}
          <div className="detailed-picks">
            <h4>🎯 Pick-by-Pick Results</h4>
            <div className="picks-results-grid">
              {analysis.detailedPicks.map((pick, idx) => (
                <div key={idx} className={`pick-result-card performance-${pick.performance}`}>
                  <div className="pick-result-header">
                    <h5>{pick.player}</h5>
                    <span className={`performance-badge ${pick.performance}`}>
                      {pick.performance === 'win' ? '🏆 WIN' :
                       pick.performance === 'top-5' ? '⭐ Top 5' :
                       pick.performance === 'top-10' ? '👍 Top 10' :
                       pick.performance === 'top-20' ? '✓ Top 20' :
                       pick.performance === 'made-cut' ? '✓ Made Cut' :
                       pick.performance === 'missed-cut' ? '❌ MC' : '❓'}
                    </span>
                  </div>
                  <div className="pick-result-details">
                    <div className="detail-row">
                      <span>Predicted Odds:</span>
                      <span className="detail-value">{Math.round(pick.odds)}/1</span>
                    </div>
                    <div className="detail-row">
                      <span>Final Position:</span>
                      <span className="detail-value">{pick.position}</span>
                    </div>
                    <div className="detail-row">
                      <span>Score:</span>
                      <span className="detail-value">{pick.toPar}</span>
                    </div>
                    {pick.roi !== undefined && (
                      <div className="detail-row roi-row">
                        <span>ROI ($100 bet):</span>
                        <span className={`detail-value ${pick.roi >= 0 ? 'positive' : 'negative'}`}>
                          {pick.roi >= 0 ? '+' : ''}${pick.roi.toFixed(2)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Pending Predictions */}
          <div className="pending-predictions">
            <h4>🔮 Predictions ({predictions.length} picks)</h4>
            <div className="pending-picks-grid">
              {predictions.map((pick, idx) => (
                <div key={idx} className="pending-pick-card">
                  <h5>{pick.player}</h5>
                  <div className="pending-pick-odds">{Math.round(pick.odds)}/1</div>
                  <p className="pending-pick-reasoning">{pick.reasoning}</p>
                </div>
              ))}
            </div>
            <p className="pending-note">Results will appear here once the tournament is completed.</p>
          </div>
        </>
      )}
    </div>
  );
};

export default App;
