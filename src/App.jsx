import React, { useState, useEffect } from 'react';
import './App.css';

function App() {
  const [tour, setTour] = useState('pga');
  const [predictions, setPredictions] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchPredictions = async (selectedTour) => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch(`/.netlify/functions/get-predictions?tour=${selectedTour}`);
      
      if (!response.ok) {
        throw new Error('Failed to fetch predictions');
      }
      
      const data = await response.json();
      setPredictions(data);
    } catch (err) {
      setError(err.message);
      console.error('Fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPredictions(tour);
  }, [tour]);

  return (
    <div className="app">
      <header className="header">
        <h1>🏌️ Golf AI Predictor</h1>
        <p className="subtitle">Complete field analysis • Course-fit value picks • AI powered</p>
      </header>

      <div className="tour-selector">
        <button 
          className={`tour-btn ${tour === 'pga' ? 'active' : ''}`}
          onClick={() => setTour('pga')}
        >
          PGA Tour
        </button>
        <button 
          className={`tour-btn ${tour === 'dp' ? 'active' : ''}`}
          onClick={() => setTour('dp')}
        >
          DP World Tour
        </button>
      </div>

      {loading && (
        <div className="loading">
          <div className="spinner"></div>
          <p>Analyzing complete tournament field...</p>
          <p className="loading-subtext">Evaluating 120+ players for value picks</p>
        </div>
      )}

      {error && (
        <div className="error">
          <p>❌ {error}</p>
          <button onClick={() => fetchPredictions(tour)}>Retry</button>
        </div>
      )}

      {predictions && !loading && (
        <div className="predictions-container">
          <div className="tournament-info">
            <h2>{predictions.tournament.name}</h2>
            <div className="tournament-details">
              <span>📍 {predictions.tournament.course}</span>
              <span>📅 {predictions.tournament.dates}</span>
              <span>🌤️ {predictions.weather}</span>
            </div>
          </div>

          <div className="picks-grid">
            {predictions.predictions.map((pick, index) => (
              <div key={index} className="pick-card">
                <div className="pick-header">
                  <span className="pick-number">#{index + 1}</span>
                  <span className="pick-odds">+{Math.round((pick.odds - 1) * 100)}</span>
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
