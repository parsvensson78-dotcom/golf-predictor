import React from 'react';

/**
 * Enhanced Player Card Component
 * Shows average odds, best/worst odds with bookmaker names, and bookmaker count
 */
const PlayerCardWithOddsRange = ({ player, reasoning }) => {
  // Convert decimal odds to fractional for display
  const toFractional = (decimal) => {
    if (!decimal) return 'N/A';
    const numerator = Math.round((decimal - 1) * 1);
    return `${numerator}/1`;
  };

  return (
    <div className="bg-white rounded-lg shadow-md p-6 mb-4 border border-gray-200 hover:shadow-lg transition-shadow">
      {/* Player Name and Rank */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xl font-bold text-gray-900">{player.name}</h3>
        {player.rank && (
          <span className="text-sm text-gray-500 font-medium">
            World Rank: #{player.rank}
          </span>
        )}
      </div>

      {/* Odds Display - Prominent Section */}
      <div className="bg-gradient-to-r from-blue-50 to-blue-100 rounded-lg p-4 mb-4">
        <div className="grid grid-cols-3 gap-4">
          {/* Best Odds */}
          <div className="text-center">
            <div className="text-xs text-gray-600 mb-1 font-medium">BEST ODDS</div>
            <div className="text-2xl font-bold text-green-600">
              {player.americanMinOdds || toFractional(player.minOdds)}
            </div>
            {player.bestBookmaker && (
              <div className="text-xs text-green-700 font-medium mt-1">
                {player.bestBookmaker}
              </div>
            )}
            <div className="text-xs text-gray-500 mt-1">
              {player.minOdds?.toFixed(1)} decimal
            </div>
          </div>

          {/* Average Odds */}
          <div className="text-center border-x border-blue-200">
            <div className="text-xs text-gray-600 mb-1 font-medium">AVERAGE</div>
            <div className="text-2xl font-bold text-blue-600">
              {player.americanOdds || toFractional(player.odds)}
            </div>
            <div className="text-xs text-gray-600 font-medium mt-1">
              {player.bookmakerCount} books
            </div>
            <div className="text-xs text-gray-500 mt-1">
              {player.odds?.toFixed(1)} decimal
            </div>
          </div>

          {/* Worst Odds */}
          <div className="text-center">
            <div className="text-xs text-gray-600 mb-1 font-medium">WORST ODDS</div>
            <div className="text-2xl font-bold text-red-600">
              {player.americanMaxOdds || toFractional(player.maxOdds)}
            </div>
            {player.worstBookmaker && (
              <div className="text-xs text-red-700 font-medium mt-1">
                {player.worstBookmaker}
              </div>
            )}
            <div className="text-xs text-gray-500 mt-1">
              {player.maxOdds?.toFixed(1)} decimal
            </div>
          </div>
        </div>

        {/* Shopping Tip */}
        <div className="text-center mt-3 pt-3 border-t border-blue-200">
          <span className="text-xs text-gray-600">
            💡 <span className="font-semibold">Tip:</span> Always shop for the best odds - they vary significantly between bookmakers
          </span>
        </div>
      </div>

      {/* Stats Section */}
      <div className="grid grid-cols-5 gap-2 mb-4 text-center">
        <div className="bg-gray-50 rounded p-2">
          <div className="text-xs text-gray-500">Total</div>
          <div className="font-bold text-gray-900">{player.sgTotal}</div>
        </div>
        <div className="bg-gray-50 rounded p-2">
          <div className="text-xs text-gray-500">OTT</div>
          <div className="font-bold text-gray-900">{player.sgOTT}</div>
        </div>
        <div className="bg-gray-50 rounded p-2">
          <div className="text-xs text-gray-500">APP</div>
          <div className="font-bold text-gray-900">{player.sgAPP}</div>
        </div>
        <div className="bg-gray-50 rounded p-2">
          <div className="text-xs text-gray-500">ARG</div>
          <div className="font-bold text-gray-900">{player.sgARG}</div>
        </div>
        <div className="bg-gray-50 rounded p-2">
          <div className="text-xs text-gray-500">Putt</div>
          <div className="font-bold text-gray-900">{player.sgPutt}</div>
        </div>
      </div>

      {/* Reasoning */}
      <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 rounded">
        <p className="text-sm text-gray-700 leading-relaxed">{reasoning}</p>
      </div>

      {/* Value Indicator */}
      {player.minOdds && player.maxOdds && (
        <div className="mt-3 text-center">
          <span className="inline-block bg-green-100 text-green-800 text-xs px-3 py-1 rounded-full font-medium">
            💰 Shop for best value - up to {((player.minOdds / player.maxOdds - 1) * 100).toFixed(0)}% better odds available
          </span>
        </div>
      )}
    </div>
  );
};

/**
 * Compact Odds Display (for lists/tables)
 * Now includes bookmaker names
 */
const CompactOddsDisplay = ({ player }) => {
  return (
    <div className="inline-flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
      <div className="text-center">
        <div className="text-xs text-green-600 font-medium">Best</div>
        <div className="text-sm font-bold">{player.americanMinOdds || 'N/A'}</div>
        {player.bestBookmaker && (
          <div className="text-xs text-gray-500">{player.bestBookmaker}</div>
        )}
      </div>
      <div className="text-gray-300">|</div>
      <div className="text-center">
        <div className="text-xs text-blue-600 font-medium">Avg</div>
        <div className="text-sm font-bold">{player.americanOdds || 'N/A'}</div>
      </div>
      <div className="text-gray-300">|</div>
      <div className="text-center">
        <div className="text-xs text-red-600 font-medium">Worst</div>
        <div className="text-sm font-bold">{player.americanMaxOdds || 'N/A'}</div>
        {player.worstBookmaker && (
          <div className="text-xs text-gray-500">{player.worstBookmaker}</div>
        )}
      </div>
    </div>
  );
};

/**
 * Odds Comparison Tooltip Component
 * Enhanced with bookmaker information
 */
const OddsTooltip = ({ player }) => {
  const potentialGain = player.minOdds && player.maxOdds 
    ? ((player.minOdds / player.maxOdds - 1) * 100).toFixed(1)
    : 0;

  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-4 w-72">
      <h4 className="font-bold text-gray-900 mb-3">Odds Breakdown</h4>
      
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <div>
            <span className="text-sm text-gray-600">Best Available:</span>
            {player.bestBookmaker && (
              <div className="text-xs text-green-600 font-medium">{player.bestBookmaker}</div>
            )}
          </div>
          <span className="font-bold text-green-600 text-lg">{player.americanMinOdds}</span>
        </div>
        
        <div className="flex justify-between items-center">
          <div>
            <span className="text-sm text-gray-600">Average:</span>
            <div className="text-xs text-gray-500">{player.bookmakerCount} books</div>
          </div>
          <span className="font-bold text-blue-600 text-lg">{player.americanOdds}</span>
        </div>
        
        <div className="flex justify-between items-center">
          <div>
            <span className="text-sm text-gray-600">Worst:</span>
            {player.worstBookmaker && (
              <div className="text-xs text-red-600 font-medium">{player.worstBookmaker}</div>
            )}
          </div>
          <span className="font-bold text-red-600 text-lg">{player.americanMaxOdds}</span>
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-gray-200">
        {potentialGain > 0 && (
          <div className="text-sm font-medium text-green-600 mb-2">
            ✨ Shopping can improve returns by {potentialGain}%
          </div>
        )}
        <div className="text-xs text-gray-500">
          Based on {player.bookmakerCount} bookmakers including DraftKings, FanDuel, BetMGM, Bet365, Pinnacle, and more
        </div>
      </div>
    </div>
  );
};

/**
 * Odds Comparison Table (Alternative Display)
 * Shows all three odds side-by-side with bookmaker names
 */
const OddsComparisonTable = ({ player }) => {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Type</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">American</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Decimal</th>
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Bookmaker</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          <tr className="bg-green-50">
            <td className="px-4 py-3 text-sm font-medium text-green-700">Best</td>
            <td className="px-4 py-3 text-sm font-bold text-green-600">{player.americanMinOdds}</td>
            <td className="px-4 py-3 text-sm text-gray-600">{player.minOdds?.toFixed(2)}</td>
            <td className="px-4 py-3 text-sm text-green-700">{player.bestBookmaker || 'N/A'}</td>
          </tr>
          <tr>
            <td className="px-4 py-3 text-sm font-medium text-blue-700">Average</td>
            <td className="px-4 py-3 text-sm font-bold text-blue-600">{player.americanOdds}</td>
            <td className="px-4 py-3 text-sm text-gray-600">{player.odds?.toFixed(2)}</td>
            <td className="px-4 py-3 text-sm text-gray-600">{player.bookmakerCount} books</td>
          </tr>
          <tr className="bg-red-50">
            <td className="px-4 py-3 text-sm font-medium text-red-700">Worst</td>
            <td className="px-4 py-3 text-sm font-bold text-red-600">{player.americanMaxOdds}</td>
            <td className="px-4 py-3 text-sm text-gray-600">{player.maxOdds?.toFixed(2)}</td>
            <td className="px-4 py-3 text-sm text-red-700">{player.worstBookmaker || 'N/A'}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

/**
 * Example Usage in Your App
 */
const PredictionsPage = ({ predictions }) => {
  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-6">Value Picks</h1>
      
      {predictions.map((pick, index) => (
        <PlayerCardWithOddsRange 
          key={index}
          player={pick.player}
          reasoning={pick.reasoning}
        />
      ))}
    </div>
  );
};

export { 
  PlayerCardWithOddsRange, 
  CompactOddsDisplay, 
  OddsTooltip,
  OddsComparisonTable,
  PredictionsPage 
};
