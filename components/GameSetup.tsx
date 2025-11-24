
import React, { useState, useEffect } from 'react';
import { Role, GameConfig } from '../types';
import { Button } from './Button';

interface GameSetupProps {
  onStart: (config: GameConfig) => void;
  onBack: () => void;
}

export const GameSetup: React.FC<GameSetupProps> = ({ onStart, onBack }) => {
  const [totalPlayers, setTotalPlayers] = useState(6);
  const [roles, setRoles] = useState<Record<Role, number>>({
    [Role.WEREWOLF]: 2,
    [Role.VILLAGER]: 2,
    [Role.SEER]: 1,
    [Role.HUNTER]: 1,
    [Role.WITCH]: 0
  });

  // Auto-balance villagers when total changes or special roles change
  useEffect(() => {
    const specials = (roles[Role.WEREWOLF] as number) + (roles[Role.SEER] as number) + (roles[Role.WITCH] as number) + (roles[Role.HUNTER] as number);
    const villagers = Math.max(0, totalPlayers - specials);
    setRoles(prev => ({ ...prev, [Role.VILLAGER]: villagers }));
  }, [totalPlayers, roles[Role.WEREWOLF], roles[Role.SEER], roles[Role.WITCH], roles[Role.HUNTER]]);

  const updateRole = (role: Role, delta: number) => {
    setRoles(prev => {
      const newVal = Math.max(0, prev[role] + delta);
      // Constraint checks could go here
      return { ...prev, [role]: newVal };
    });
  };

  const isValid = () => {
    const sum = (Object.values(roles) as number[]).reduce((a, b) => a + b, 0);
    return sum === totalPlayers && roles[Role.WEREWOLF] > 0;
  };

  return (
    <div className="max-w-md mx-auto p-6 space-y-8 animate-fade-in">
      <div className="text-center">
        <h2 className="text-3xl font-bold text-indigo-400">创建房间</h2>
        <p className="text-slate-400">自定义游戏配置</p>
      </div>

      {/* Player Count Slider */}
      <div className="space-y-2">
        <label className="text-slate-300 font-semibold flex justify-between">
          <span>总人数</span>
          <span className="text-indigo-400 font-mono text-xl">{totalPlayers}</span>
        </label>
        <input 
          type="range" 
          min="6" 
          max="10" 
          value={totalPlayers} 
          onChange={(e) => setTotalPlayers(parseInt(e.target.value))}
          className="w-full accent-indigo-500 h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer"
        />
        <div className="flex justify-between text-xs text-slate-500">
          <span>6人</span>
          <span>10人</span>
        </div>
      </div>

      {/* Roles Config */}
      <div className="space-y-3 bg-slate-800/50 p-4 rounded-xl border border-slate-700">
        <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-2">身份配置</h3>
        
        <ConfigRow 
          label="🐺 狼人" 
          count={roles[Role.WEREWOLF]} 
          onDec={() => updateRole(Role.WEREWOLF, -1)} 
          onInc={() => updateRole(Role.WEREWOLF, 1)} 
        />
        
        <ConfigRow 
          label="🔮 预言家" 
          count={roles[Role.SEER]} 
          onDec={() => updateRole(Role.SEER, -1)} 
          onInc={() => updateRole(Role.SEER, 1)} 
          max={1}
        />

        <ConfigRow 
          label="🧪 女巫" 
          count={roles[Role.WITCH]} 
          onDec={() => updateRole(Role.WITCH, -1)} 
          onInc={() => updateRole(Role.WITCH, 1)} 
          max={1}
        />

        <ConfigRow 
          label="🔫 猎人" 
          count={roles[Role.HUNTER]} 
          onDec={() => updateRole(Role.HUNTER, -1)} 
          onInc={() => updateRole(Role.HUNTER, 1)} 
          max={1}
        />

        <div className="flex justify-between items-center py-2 border-t border-slate-700 mt-2">
          <span className="text-slate-300 font-medium">🧑‍🌾 村民 (自动)</span>
          <span className="font-mono text-lg text-slate-200">{roles[Role.VILLAGER]}</span>
        </div>
      </div>

      <div className="space-y-3">
        <Button 
          fullWidth 
          onClick={() => onStart({ totalPlayers, roleCounts: roles })}
          disabled={!isValid()}
        >
          创建并进入大厅
        </Button>
        <Button variant="ghost" fullWidth onClick={onBack}>
          返回
        </Button>
      </div>
    </div>
  );
};

const ConfigRow: React.FC<{ label: string, count: number, onInc: () => void, onDec: () => void, max?: number }> = ({ label, count, onInc, onDec, max }) => (
  <div className="flex justify-between items-center">
    <span className="text-slate-300 font-medium">{label}</span>
    <div className="flex items-center space-x-3 bg-slate-900 rounded-lg p-1">
      <button 
        onClick={onDec}
        disabled={count <= 0}
        className="w-8 h-8 flex items-center justify-center rounded bg-slate-800 text-slate-200 disabled:opacity-30 hover:bg-slate-700 transition-colors"
      >
        -
      </button>
      <span className="w-4 text-center font-mono font-bold">{count}</span>
      <button 
        onClick={onInc}
        disabled={max !== undefined && count >= max}
        className="w-8 h-8 flex items-center justify-center rounded bg-slate-800 text-slate-200 disabled:opacity-30 hover:bg-slate-700 transition-colors"
      >
        +
      </button>
    </div>
  </div>
);
