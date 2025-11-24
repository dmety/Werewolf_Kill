
export enum Role {
  WEREWOLF = '狼人',
  VILLAGER = '村民',
  SEER = '预言家',
  HUNTER = '猎人',
  WITCH = '女巫'
}

export enum Phase {
  SETUP = 'SETUP',
  LOBBY = 'LOBBY',
  ROLE_REVEAL = 'ROLE_REVEAL',
  NIGHT = 'NIGHT',
  DAY_TRANSITION = 'DAY_TRANSITION',
  DAY_DISCUSSION = 'DAY_DISCUSSION',
  VOTING = 'VOTING',
  GAME_OVER = 'GAME_OVER'
}

export enum NightStep {
  NONE = 'NONE',
  WEREWOLF_ACTION = 'WEREWOLF_ACTION',
  SEER_ACTION = 'SEER_ACTION',
  WITCH_ACTION = 'WITCH_ACTION',
  HUNTER_ACTION = 'HUNTER_ACTION'
}

export interface Player {
  id: number;
  name: string;
  role: Role;
  isAlive: boolean;
  avatar: string;
  isProtected?: boolean;
  peerId?: string; // Network ID
  isHost?: boolean;
  hasLastWords?: boolean; // Can speak once after death
}

export interface GameConfig {
  totalPlayers: number;
  roleCounts: Record<Role, number>;
}

export interface ChatMessage {
  id: string;
  senderId: number;
  senderName: string;
  text: string;
  timestamp: number;
  isSystem?: boolean;
}

export interface GameState {
  mode: number; // Player count
  config: GameConfig; // Store the full config
  phase: Phase;
  round: number;
  players: Player[];
  nightStep: NightStep;
  
  // Action Tracking
  wolvesTargetId: number | null;
  seerCheckId: number | null;
  witchSaveUsed: boolean;
  witchPoisonUsed: boolean;
  witchAction: { save: boolean; poisonTargetId: number | null };
  hunterTargetId: number | null;
  
  // Voting & Chat
  currentVotes: Record<number, number>; // voterId -> targetId
  wolfChatHistory: ChatMessage[];
  publicChatHistory: ChatMessage[];

  lastNightDeadIds: number[];
  winner: 'WEREWOLVES' | 'VILLAGERS' | null;
  
  // AI Narrative
  storyLog: string[];
  currentStory: string;
  isLoadingStory: boolean;

  // Network State (Host Only mostly, but shared structure)
  roomId?: string;
}

export type NetworkMessage = 
  | { type: 'JOIN'; payload: { name: string; peerId: string } }
  | { type: 'WELCOME'; payload: { playerId: number; gameState: GameState } }
  | { type: 'STATE_UPDATE'; payload: { gameState: GameState } }
  | { type: 'ACTION'; payload: { action: string; data: any; fromPlayerId: number } }
  | { type: 'CHAT'; payload: { message: ChatMessage; channel: 'public' | 'wolf' } };

export const DEFAULT_ROLES_6: Record<Role, number> = {
  [Role.WEREWOLF]: 2,
  [Role.VILLAGER]: 2,
  [Role.SEER]: 1,
  [Role.HUNTER]: 1,
  [Role.WITCH]: 0
};

export const DEFAULT_ROLES_8: Record<Role, number> = {
  [Role.WEREWOLF]: 3,
  [Role.VILLAGER]: 3,
  [Role.SEER]: 1,
  [Role.WITCH]: 1,
  [Role.HUNTER]: 0
};
