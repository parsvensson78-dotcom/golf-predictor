import React, { useState } from 'react';
import './App.css';

function App() {
  const [tour, setTour] = useState('pga');
  const [predictions, setPredictions] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [requestId, setRequestId] = useState(0); // Force unique renders

  const fetchPredictions = async (selectedTour) => {
    // Increment request ID to force re-render
    const newRequestId = requestId + 1;
    setRequestId(newRequestId);
    
    // Clear everything immediately and aggressively
    setPredictions(null);
    setError(null);
    setLoading(true);
    
    // Small delay to ensure state clears
    await new Promise(resolve => setTimeout(resolve, 50));
    
    try {
      const response = await fetch(`/.netlify/functions/get-predictions?tour=${selectedTour}`);
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to fetch predictions');
      }
      
      const data = await response.json();
      
      // Only set predictions if this is still the latest request
      if (newRequestId === requestId + 1) {
        setPredictions(data);
      }
    } catch (err) {
      setError(err.message);
      console.error('Fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleTourChange = (newTour) => {
    setTour(newTour);
    setPredictions(null);
    setError(null);
    setRequestId(requestId + 1);
  };

  const handleGetPredictions = () => {
    fetchPredictions(tour);
  };

  return (
    <div className="app">
      <header className="header">
        <h1>🏌️ Golf AI Predictor</h1>
        <p className="subtitle">Complete field analysis • Course-fit value picks • AI powered</p>
      </header>

      <div className="tour-selector">
        <button 
          className={`tour-btn ${tour === 'pga' ? 'active' : ''}`}
          onClick={() => handleTourChange('pga')}
          disabled={loading}
        >
          PGA Tour
        </button>
        <button 
          className={`tour-btn ${tour === 'dp' ? 'active' : ''}`}
          onClick={() => handleTourChange('dp')}
          disabled={loading}
        >
          DP World Tour
        </button>
      </div>

      <div className="action-section">
        <button 
          className="get-predictions-btn"
          onClick={handleGetPredictions}
          disabled={loading}
        >
          {loading ? 'Analyzing...' : 'Get Predictions'}
        </button>
      </div>

      {loading && (
        <div className="loading" key={`loading-${requestId}`}>
          <div className="spinner"></div>
          <p>Analyzing complete tournament field...</p>
          <p className="loading-subtext">Evaluating 120+ players for value picks</p>
        </div>
      )}

      {error && !loading && (
        <div className="error" key={`error-${requestId}`}>
          <p>❌ {error}</p>
          <button onClick={handleGetPredictions}>Retry</button>
        </div>
      )}

      {predictions && !loading && !error && (
        <div className="predictions-container" key={`predictions-${requestId}-${predictions.generatedAt}`}>
          <div className="tournament-info">
            <h2>{predictions.tournament.name}</h2>
            <div className="tournament-details">
              <span>📍 {predictions.tournament.course}</span>
              <span>📅 {predictions.tournament.dates}</span>
              <span>🌤️ {predictions.weather}</span>
            </div>
            
            {predictions.courseAnalysis && (
              <div className="course-analysis">
                <div className="analysis-item">
                  <strong>Course Type:</strong> {predictions.courseAnalysis.type}
                </div>
                <div className="analysis-item">
                  <strong>Weather Impact:</strong> {predictions.courseAnalysis.weatherImpact}
                </div>
              </div>
            )}
          </div>

          <div className="picks-grid">
            {predictions.predictions && predictions.predictions.map((pick, index) => (
              <div key={`pick-${requestId}-${index}`} className="pick-card">
                <div className="pick-header">
                  <span className="pick-number">#{index + 1}</span>
                  <span className="pick-odds">{Math.round(pick.odds)}/1</span>
                </div>
                <h3 className="pick-name">{pick.player}</h3>
                <p className="pick-reasoning">{pick.reasoning}</p>
              </div>
            ))}
          </div>

          <div className="footer-info">
            <p className="generated-time">
              Generated: {new Date(predictions.generatedAt).toLocaleString()}
            </p>
            {predictions.tokensUsed && (
              <p className="token-usage">
                API tokens: {predictions.tokensUsed.toLocaleString()}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
