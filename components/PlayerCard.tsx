
import React from 'react';
import { Player, Role } from '../types';

interface PlayerCardProps {
  player: Player;
  revealed?: boolean;
  selected?: boolean; // Used for highlighting targets visually if needed
  showStatus?: boolean; // Show dead/alive explicitly
  isMe?: boolean; // New: Is this the current user?
}

export const PlayerCard: React.FC<PlayerCardProps> = ({ 
  player, 
  revealed = false, 
  selected = false,
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
      className={`
        relative flex flex-col items-center justify-center p-3 rounded-xl border-2 transition-all h-32
        ${!player.isAlive ? 'opacity-50 grayscale bg-slate-900 border-slate-800' : 'bg-slate-800'}
        ${selected ? 'border-indigo-500 shadow-[0_0_15px_rgba(99,102,241,0.5)]' : 'border-slate-700'}
        ${isMe ? 'ring-2 ring-amber-400 ring-offset-2 ring-offset-slate-900' : ''}
      `}
    >
      {/* Seat Number Badge */}
      <div className="absolute -top-3 -left-2 w-8 h-8 bg-slate-700 text-white font-mono font-bold text-lg flex items-center justify-center rounded-full border-2 border-slate-600 shadow-lg z-20">
        {player.id + 1}
      </div>

      {!player.isAlive && showStatus && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 rounded-xl z-10">
          <span className="text-red-500 font-bold text-xl uppercase tracking-widest border-2 border-red-500 px-2 py-1 rotate-12">OUT</span>
        </div>
      )}
      
      {isMe && (
        <div className="absolute -top-3 -right-2 bg-amber-500 text-slate-900 text-[10px] font-bold px-2 py-0.5 rounded-full z-20">
          我
        </div>
      )}

      <div className="text-3xl mb-1">
        {revealed || !player.isAlive ? getRoleIcon(player.role) : '👤'}
      </div>
      
      <div className="font-bold text-slate-200 truncate max-w-full text-center text-sm w-full">
        {player.name}
      </div>

      {/* Show small indicator if player has Last Words available */}
      {!player.isAlive && player.hasLastWords && (
        <div className="absolute bottom-1 right-1 text-[10px] bg-green-900 text-green-300 px-1 rounded border border-green-700">
          遗言
        </div>
      )}
      
      {revealed && (
        <div className={`text-[10px] font-mono mt-1 px-1 rounded ${
          player.role === Role.WEREWOLF ? 'bg-red-900/50 text-red-300' : 
          player.role === Role.VILLAGER ? 'bg-slate-700 text-slate-300' : 'bg-indigo-900/50 text-indigo-300'
        }`}>
          {player.role}
        </div>
      )}
    </div>
  );
};
