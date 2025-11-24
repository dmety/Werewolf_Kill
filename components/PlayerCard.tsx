import React from 'react';
import { Player, Role } from '../types';

interface PlayerCardProps {
  player: Player;
  revealed?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  showStatus?: boolean; // Show dead/alive explicitly
  isMe?: boolean; // New: Is this the current user?
}

export const PlayerCard: React.FC<PlayerCardProps> = ({ 
  player, 
  revealed = false, 
  selectable = false, 
  selected = false,
  onSelect,
  showStatus = true,
  isMe = false
}) => {
  
  const getRoleIcon = (role: Role) => {
    switch(role) {
      case Role.WEREWOLF: return '🐺';
      case Role.SEER: return '🔮';
      case Role.WITCH: return '🧪';
      case Role.HUNTER: return '🔫';
      default: return '🧑‍🌾';
    }
  };

  return (
    <div 
      onClick={() => selectable && onSelect && onSelect()}
      className={`
        relative flex flex-col items-center justify-center p-4 rounded-xl border-2 transition-all
        ${!player.isAlive ? 'opacity-50 grayscale bg-slate-900 border-slate-800' : 'bg-slate-800'}
        ${selectable ? 'cursor-pointer hover:bg-slate-750' : ''}
        ${selected ? 'border-indigo-500 shadow-[0_0_15px_rgba(99,102,241,0.5)]' : 'border-slate-700'}
        ${isMe ? 'ring-2 ring-amber-400 ring-offset-2 ring-offset-slate-900' : ''}
      `}
    >
      {!player.isAlive && showStatus && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 rounded-xl z-10">
          <span className="text-red-500 font-bold text-xl uppercase tracking-widest border-2 border-red-500 px-2 py-1 rotate-12">OUT</span>
        </div>
      )}
      
      {isMe && (
        <div className="absolute -top-3 bg-amber-500 text-slate-900 text-[10px] font-bold px-2 py-0.5 rounded-full">
          我
        </div>
      )}

      <div className="text-4xl mb-2">
        {revealed || !player.isAlive ? getRoleIcon(player.role) : '👤'}
      </div>
      
      <div className="font-bold text-slate-200 truncate max-w-full text-center text-sm">
        {player.name}
      </div>
      
      {revealed && (
        <div className={`text-xs font-mono mt-1 px-2 py-0.5 rounded ${
          player.role === Role.WEREWOLF ? 'bg-red-900/50 text-red-300' : 
          player.role === Role.VILLAGER ? 'bg-slate-700 text-slate-300' : 'bg-indigo-900/50 text-indigo-300'
        }`}>
          {player.role}
        </div>
      )}
    </div>
  );
};