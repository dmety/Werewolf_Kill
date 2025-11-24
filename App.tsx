
import React, { useState, useEffect, useRef } from 'react';
import { Peer, DataConnection } from 'peerjs';
import { GameState, Phase, Role, Player, NightStep, GameConfig, NetworkMessage, DEFAULT_ROLES_6, ChatMessage } from './types';
import { PlayerCard } from './components/PlayerCard';
import { Button } from './components/Button';
import { GameSetup } from './components/GameSetup';
import { generateNightStory, generateDiscussionTopic } from './services/geminiService';
import { speak, stopSpeech } from './services/ttsService';

// Initial State Factory
const createInitialState = (): GameState => ({
  mode: 6,
  config: { totalPlayers: 6, roleCounts: DEFAULT_ROLES_6 },
  phase: Phase.SETUP,
  round: 0,
  players: [],
  nightStep: NightStep.NONE,
  timeLeft: 0,
  wolvesTargetId: null,
  seerCheckId: null,
  witchSaveUsed: false,
  witchPoisonUsed: false,
  witchAction: { save: false, poisonTargetId: null },
  hunterTargetId: null,
  currentVotes: {},
  wolfChatHistory: [],
  publicChatHistory: [],
  lastNightDeadIds: [],
  winner: null,
  storyLog: [],
  currentStory: "",
  isLoadingStory: false,
  roomId: undefined
});

const ACTION_TIMEOUT_SECONDS = 20;

const App: React.FC = () => {
  // --- App Modes ---
  const [appMode, setAppMode] = useState<'MENU' | 'SETUP' | 'JOIN' | 'LOBBY' | 'GAME'>('MENU');
  
  // --- Game State ---
  const [gameState, setGameState] = useState<GameState>(createInitialState());
  const [myPlayerId, setMyPlayerId] = useState<number | null>(null);
  const [isHost, setIsHost] = useState(false);
  
  // --- Network State ---
  const peerRef = useRef<Peer | null>(null);
  const connectionsRef = useRef<DataConnection[]>([]); // Host: all clients
  const hostConnRef = useRef<DataConnection | null>(null); // Client: connection to host
  const [peerId, setPeerId] = useState<string>('');
  const [joinRoomId, setJoinRoomId] = useState('');
  const [playerName, setPlayerName] = useState('');
  
  // --- Helper State ---
  const [isMuted, setIsMuted] = useState(false); // TTS Mute toggle
  const [chatInput, setChatInput] = useState('');
  const [targetInput, setTargetInput] = useState(''); // Generic input for seat numbers
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const publicChatScrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [gameState.storyLog, gameState.currentStory]);

  // Auto-scroll wolf chat
  useEffect(() => {
    if (chatScrollRef.current) {
        chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [gameState.wolfChatHistory]);

  // Auto-scroll public chat
  useEffect(() => {
    if (publicChatScrollRef.current) {
        publicChatScrollRef.current.scrollTop = publicChatScrollRef.current.scrollHeight;
    }
  }, [gameState.publicChatHistory, appMode]);

  // --- TTS Trigger ---
  useEffect(() => {
    // When currentStory changes, speak it if not muted
    if (!isMuted && gameState.currentStory && !gameState.isLoadingStory) {
      speak(gameState.currentStory);
    }
  }, [gameState.currentStory, gameState.isLoadingStory, isMuted]);

  // Stop speech when component unmounts
  useEffect(() => {
    return () => stopSpeech();
  }, []);

  // --- Timer System (Host Only) ---
  useEffect(() => {
    if (!isHost) return;
    // Timer only active during Night Steps (not NONE) or Voting?
    // User asked for "Night action roles have 20s limit".
    const isActionPhase = gameState.phase === Phase.NIGHT && gameState.nightStep !== NightStep.NONE;
    
    if (!isActionPhase) return;
    if (gameState.timeLeft <= 0) return;

    const timer = setTimeout(() => {
        const newTime = gameState.timeLeft - 1;
        if (newTime <= 0) {
            handleTimerExpire();
        } else {
            // Update time locally and broadcast. 
            // Note: Broadcasting every second might be heavy, but necessary for countdown sync.
            // Optimized: We could just update local state and let clients predict, but broadcasting is safer for logic.
            updateAndBroadcast({ ...gameState, timeLeft: newTime });
        }
    }, 1000);

    return () => clearTimeout(timer);
  }, [gameState.timeLeft, gameState.phase, gameState.nightStep, isHost]);

  const handleTimerExpire = () => {
      // Auto-advance logic based on current step
      if (gameState.nightStep === NightStep.WEREWOLF_ACTION) confirmWolfAction();
      else if (gameState.nightStep === NightStep.SEER_ACTION) confirmSeerAction();
      else if (gameState.nightStep === NightStep.WITCH_ACTION) confirmWitchAction();
      else if (gameState.nightStep === NightStep.HUNTER_ACTION) confirmHunterAction();
      else {
          // Should not happen, but reset time just in case
          updateAndBroadcast({ ...gameState, timeLeft: 0 });
      }
  };


  // --- Networking: Message Handler Ref Pattern ---
  const handleNetworkMessageRef = useRef<(msg: NetworkMessage, conn?: DataConnection) => void>(() => {});

  // --- Networking: Initialization ---
  const initPeer = () => {
      if (peerRef.current) return;

      const peer = new Peer();
      
      peer.on('open', (id) => {
        setPeerId(id);
        console.log('My Peer ID:', id);
      });
  
      peer.on('error', (err) => {
        console.error("PeerJS Error:", err);
        if (err.type === 'peer-unavailable') {
           alert("房间不存在或 ID 错误");
           leaveRoom();
        }
      });
  
      peer.on('connection', (conn) => {
        conn.on('data', (data) => {
          if (handleNetworkMessageRef.current) {
             handleNetworkMessageRef.current(data as NetworkMessage, conn);
          }
        });
        conn.on('open', () => {
          if (connectionsRef.current) {
              connectionsRef.current.push(conn);
          }
        });
        conn.on('close', () => {
            connectionsRef.current = connectionsRef.current.filter(c => c !== conn);
        });
      });
  
      peerRef.current = peer;
  };

  useEffect(() => {
    initPeer();
    return () => {
      peerRef.current?.destroy();
      peerRef.current = null;
    };
  }, []);

  // --- Network Message Handling ---
  const handleNetworkMessage = (msg: NetworkMessage, conn?: DataConnection) => {
    if (msg.type === 'JOIN') {
      if (!isHost) return;
      
      const newPlayerId = gameState.players.length;
      const newPlayer: Player = {
        id: newPlayerId,
        name: msg.payload.name,
        role: Role.VILLAGER, 
        isAlive: true,
        avatar: `https://picsum.photos/seed/${msg.payload.peerId}/200`,
        peerId: msg.payload.peerId,
        hasLastWords: false
      };

      const updatedPlayers = [...gameState.players, newPlayer];
      const newState = { ...gameState, players: updatedPlayers };
      setGameState(newState);

      conn?.send({
        type: 'WELCOME',
        payload: { playerId: newPlayerId, gameState: newState }
      } as NetworkMessage);
      broadcastState(newState);
    }

    if (msg.type === 'WELCOME') {
      setMyPlayerId(msg.payload.playerId);
      setGameState(msg.payload.gameState);
      setAppMode('LOBBY');
    }

    if (msg.type === 'STATE_UPDATE') {
      setGameState(msg.payload.gameState);
      if (msg.payload.gameState.phase !== Phase.LOBBY && appMode === 'LOBBY') {
        setAppMode('GAME');
      }
    }

    if (msg.type === 'ACTION') {
      if (!isHost) return;
      handleClientAction(msg.payload.action, msg.payload.data, msg.payload.fromPlayerId);
    }

    if (msg.type === 'CHAT') {
        if (isHost) {
            handleChat(msg.payload.message, msg.payload.channel);
        }
    }
  };

  useEffect(() => {
    handleNetworkMessageRef.current = handleNetworkMessage;
  });

  const broadcastState = (newState: GameState) => {
    connectionsRef.current.forEach(conn => {
       conn.send({ type: 'STATE_UPDATE', payload: { gameState: newState } });
    });
  };

  const sendAction = (action: string, data: any) => {
    if (isHost) {
      handleClientAction(action, data, myPlayerId!);
    } else {
      hostConnRef.current?.send({
        type: 'ACTION',
        payload: { action, data, fromPlayerId: myPlayerId! }
      });
    }
  };

  const sendChatMessage = (channel: 'public' | 'wolf' = 'public') => {
      if (!chatInput.trim()) return;
      
      const me = gameState.players.find(p => p.id === myPlayerId);
      if (!me) return;

      // Validation for "Last Words" consumption
      let isLastWords = false;
      if (!me.isAlive && channel === 'public') {
          if (me.hasLastWords) {
              isLastWords = true;
          } else {
              return; // Dead and no last words
          }
      }

      const msg: ChatMessage = {
          id: Date.now().toString() + Math.random(),
          senderId: myPlayerId!,
          senderName: me.name + (isLastWords ? ' (遗言)' : ''),
          text: chatInput,
          timestamp: Date.now()
      };

      if (isHost) {
          handleChat(msg, channel);
          // If host used last words, consume it locally
          if (isLastWords) {
              consumeLastWords(me.id);
          }
      } else {
          hostConnRef.current?.send({
              type: 'CHAT',
              payload: { message: msg, channel }
          });
      }
      setChatInput('');
  };

  const consumeLastWords = (playerId: number) => {
      const updatedPlayers = gameState.players.map(p => 
          p.id === playerId ? { ...p, hasLastWords: false } : p
      );
      updateAndBroadcast({ ...gameState, players: updatedPlayers });
  };

  const handleChat = (msg: ChatMessage, channel: 'public' | 'wolf') => {
      let newState = { ...gameState };
      
      // Check if sender needs to lose last words
      const sender = newState.players.find(p => p.id === msg.senderId);
      if (sender && !sender.isAlive && sender.hasLastWords && channel === 'public') {
          sender.hasLastWords = false; // Mutate local clone or map it
          newState.players = newState.players.map(p => p.id === sender.id ? { ...p, hasLastWords: false } : p);
      }

      if (channel === 'wolf') {
          newState.wolfChatHistory = [...newState.wolfChatHistory, msg];
      } else {
          newState.publicChatHistory = [...newState.publicChatHistory, msg];
      }
      updateAndBroadcast(newState);
  };

  const leaveRoom = () => {
      setGameState(createInitialState());
      setAppMode('MENU');
      setMyPlayerId(null);
      setIsHost(false);
      connectionsRef.current.forEach(c => c.close());
      connectionsRef.current = [];
      if (hostConnRef.current) {
          hostConnRef.current.close();
          hostConnRef.current = null;
      }
  };

  // --- Host Logic: Client Action Handler ---
  const handleClientAction = (action: string, data: any, fromId: number) => {
    if (action === 'VOTE') {
       const newVotes = { ...gameState.currentVotes, [fromId]: data.targetId };
       const newState = { ...gameState, currentVotes: newVotes };
       updateAndBroadcast(newState);
    }
    
    if (action === 'NIGHT_ACTION') {
       const { type, targetId } = data;
       if (type === 'WOLF_KILL') handleWolfSelect(targetId);
       if (type === 'SEER_CHECK') handleSeerCheck(targetId);
       if (type === 'WITCH_SAVE') handleWitchAction('save');
       if (type === 'WITCH_POISON') handleWitchAction('poison', targetId);
       if (type === 'HUNTER_SHOOT') handleHunterShoot(targetId);
    }
  };

  // --- Host Logic: Game Flow ---

  const createRoom = (config: GameConfig) => {
    setIsHost(true);
    setMyPlayerId(0);
    
    const hostPlayer: Player = {
      id: 0,
      name: playerName || "房主",
      role: Role.VILLAGER, 
      isAlive: true,
      avatar: `https://picsum.photos/seed/host/200`,
      peerId: peerId,
      isHost: true,
      hasLastWords: false
    };

    setGameState({
      ...createInitialState(),
      mode: config.totalPlayers,
      config: config,
      phase: Phase.LOBBY,
      players: [hostPlayer],
      roomId: peerId
    });
    setAppMode('LOBBY');
  };

  const joinRoom = () => {
    if (!joinRoomId || !playerName) return;
    const conn = peerRef.current?.connect(joinRoomId);
    
    conn?.on('open', () => {
      hostConnRef.current = conn;
      conn.send({
        type: 'JOIN',
        payload: { name: playerName, peerId: peerId }
      });
    });

    conn?.on('data', (data) => {
        if (handleNetworkMessageRef.current) {
            handleNetworkMessageRef.current(data as NetworkMessage, conn);
        }
    });
    conn?.on('error', (err) => {
        alert("连接失败: " + err);
        setAppMode('MENU');
    });
    conn?.on('close', () => {
        alert("与房主断开连接");
        leaveRoom();
    });
    
    setAppMode('JOIN');
  };

  const startGame = () => {
    if (!isHost) return;
    
    const roles: Role[] = [];
    Object.entries(gameState.config.roleCounts).forEach(([role, count]) => {
      for(let i=0; i<(count as number); i++) roles.push(role as Role);
    });
    
    while(roles.length < gameState.players.length) {
      roles.push(Role.VILLAGER);
    }
    
    for (let i = roles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }

    const newPlayers = gameState.players.map((p, i) => ({
      ...p,
      role: roles[i] || Role.VILLAGER,
      hasLastWords: false
    }));

    const newState = {
      ...gameState,
      players: newPlayers,
      phase: Phase.ROLE_REVEAL,
      storyLog: ["游戏开始。请确认身份。"]
    };

    setGameState(newState);
    setAppMode('GAME');
    broadcastState(newState);
  };

  const updateAndBroadcast = (newState: GameState) => {
    setGameState(newState);
    broadcastState(newState);
  };

  // --- Game Mechanics ---
  
  const startNight = () => {
    const newState = {
      ...gameState,
      phase: Phase.NIGHT,
      round: gameState.round + 1,
      nightStep: NightStep.WEREWOLF_ACTION,
      timeLeft: ACTION_TIMEOUT_SECONDS, // Reset timer
      wolvesTargetId: null,
      seerCheckId: null,
      witchAction: { save: false, poisonTargetId: null },
      hunterTargetId: null,
      currentVotes: {},
      currentStory: "天黑请闭眼。狼人请睁眼，请输入座位号袭击目标..."
    };
    updateAndBroadcast(newState);
  };
  
  const handleWolfSelect = (targetId: number) => {
    if (!isHost) {
        sendAction('NIGHT_ACTION', { type: 'WOLF_KILL', targetId });
        return;
    }
    // Update target but DO NOT reset timer
    const newState = { ...gameState, wolvesTargetId: targetId };
    updateAndBroadcast(newState);
  };

  const confirmWolfAction = () => {
    // This is now triggered automatically by timer or manually by host
    // But since host manual confirmation is removed/deprecated for automatic flow, we rely on Timer mostly
    // or we can keep the button for "Early Finish".
    if (!isHost) return;
    
    let nextStep: NightStep = NightStep.SEER_ACTION;
    
    if (!gameState.config.roleCounts[Role.SEER]) {
       nextStep = NightStep.WITCH_ACTION;
    }
    if (nextStep === NightStep.WITCH_ACTION && !gameState.config.roleCounts[Role.WITCH]) {
        nextStep = NightStep.NONE;
    }

    const story = nextStep === NightStep.NONE 
      ? "天亮了..." 
      : (nextStep === NightStep.SEER_ACTION 
          ? "狼人请闭眼。预言家请睁眼，请输入座位号查验身份..." 
          : "狼人请闭眼。女巫请睁眼...");

    const newState = { 
        ...gameState, 
        nightStep: nextStep, 
        currentStory: story,
        timeLeft: nextStep === NightStep.NONE ? 0 : ACTION_TIMEOUT_SECONDS // Reset timer for next role
    };
    updateAndBroadcast(newState);
    if (nextStep === NightStep.NONE) resolveNight(newState);
  };
  
  const handleSeerCheck = (targetId: number) => {
      if (!isHost) {
          sendAction('NIGHT_ACTION', { type: 'SEER_CHECK', targetId });
          return;
      }
      const newState = { ...gameState, seerCheckId: targetId };
      updateAndBroadcast(newState);
  };

  const confirmSeerAction = () => {
      if (!isHost) return;
      let nextStep = NightStep.WITCH_ACTION;
      
      if (!gameState.config.roleCounts[Role.WITCH]) {
          nextStep = NightStep.NONE;
      }

      const newState = {
          ...gameState,
          nightStep: nextStep,
          currentStory: nextStep === NightStep.NONE ? "天亮了..." : "预言家请闭眼。女巫请睁眼...",
          timeLeft: nextStep === NightStep.NONE ? 0 : ACTION_TIMEOUT_SECONDS
      };
      updateAndBroadcast(newState);
      if (nextStep === NightStep.NONE) resolveNight(newState);
  };

  const handleWitchAction = (type: 'save' | 'poison', targetId?: number) => {
      if (!isHost) {
          sendAction('NIGHT_ACTION', { type: type === 'save' ? 'WITCH_SAVE' : 'WITCH_POISON', targetId });
          return;
      }
      
      let newAction = { ...gameState.witchAction };
      if (type === 'save') newAction.save = !newAction.save;
      if (type === 'poison') newAction.poisonTargetId = targetId || null;

      const newState = { ...gameState, witchAction: newAction };
      updateAndBroadcast(newState);
  };

  const confirmWitchAction = () => {
      if (!isHost) return;
      const newState = {
          ...gameState,
          witchSaveUsed: gameState.witchAction.save ? true : gameState.witchSaveUsed,
          witchPoisonUsed: gameState.witchAction.poisonTargetId !== null ? true : gameState.witchPoisonUsed,
          nightStep: NightStep.NONE,
          currentStory: "女巫请闭眼。天亮了...",
          timeLeft: 0
      };
      updateAndBroadcast(newState);
      resolveNight(newState);
  };

  const resolveNight = async (currentState: GameState) => {
      let deadIds: number[] = [];
      const { wolvesTargetId, witchAction, players } = currentState;

      if (wolvesTargetId !== null && !witchAction.save) deadIds.push(wolvesTargetId);
      if (witchAction.poisonTargetId !== null) deadIds.push(witchAction.poisonTargetId);
      
      deadIds = [...new Set(deadIds)];
      
      const updatedPlayers = players.map(p => {
          const died = deadIds.includes(p.id);
          return {
              ...p,
              isAlive: died ? false : p.isAlive,
              hasLastWords: died && currentState.round === 1 ? true : p.hasLastWords
          };
      });

      const hunter = updatedPlayers.find(p => p.role === Role.HUNTER);
      const hunterDied = hunter && deadIds.includes(hunter.id);
      const hunterPoisoned = hunter && witchAction.poisonTargetId === hunter.id;
      const canHunterShoot = hunterDied && !hunterPoisoned;

      const nextPhase = canHunterShoot ? Phase.NIGHT : Phase.DAY_TRANSITION;
      const nextNightStep = canHunterShoot ? NightStep.HUNTER_ACTION : NightStep.NONE;

      const newState = {
          ...currentState,
          players: updatedPlayers,
          lastNightDeadIds: deadIds,
          phase: nextPhase,
          nightStep: nextNightStep,
          isLoadingStory: true,
          timeLeft: canHunterShoot ? ACTION_TIMEOUT_SECONDS : 0
      };
      
      updateAndBroadcast(newState);

      if (nextPhase === Phase.DAY_TRANSITION) {
          const deadPlayers = updatedPlayers.filter(p => deadIds.includes(p.id));
          const story = await generateNightStory(newState.round, deadPlayers, updatedPlayers);
          
          const storyState = {
              ...newState,
              currentStory: story,
              storyLog: [...newState.storyLog, `第 ${newState.round} 夜: ${story}`],
              isLoadingStory: false
          };
          updateAndBroadcast(storyState);
      } else if (canHunterShoot) {
          updateAndBroadcast({
              ...newState,
              currentStory: "猎人请睁眼。你已倒牌，请输入座位号开枪带走一人...",
              isLoadingStory: false
          });
      }
  };

  const handleHunterShoot = (targetId: number) => {
     if (!isHost) {
        sendAction('NIGHT_ACTION', { type: 'HUNTER_SHOOT', targetId });
        return;
     }
     const newState = { ...gameState, hunterTargetId: targetId };
     updateAndBroadcast(newState);
  };

  const confirmHunterAction = () => {
     if (!isHost) return;
     // If timer expires and no target selected, Hunter dies without shooting
     if (gameState.hunterTargetId === null) {
          // Hunter forfeit
          const newState = {
            ...gameState,
            phase: Phase.DAY_TRANSITION,
            nightStep: NightStep.NONE,
            timeLeft: 0,
            isLoadingStory: true
          };
          updateAndBroadcast(newState);
          setTimeout(async () => {
             // Basic story without hunter kill
             const story = await generateNightStory(newState.round, gameState.players.filter(p => gameState.lastNightDeadIds.includes(p.id)), gameState.players);
             updateAndBroadcast({
                 ...newState,
                 currentStory: story,
                 storyLog: [...newState.storyLog, `第 ${newState.round} 夜: ${story}`],
                 isLoadingStory: false
             });
          }, 100);
          return;
     }
     
     const newDeadId = gameState.hunterTargetId;
     const updatedPlayers = gameState.players.map(p => ({
         ...p,
         isAlive: p.id === newDeadId ? false : p.isAlive
     }));
     
     const newState = {
         ...gameState,
         players: updatedPlayers,
         lastNightDeadIds: [...gameState.lastNightDeadIds, newDeadId],
         phase: Phase.DAY_TRANSITION,
         nightStep: NightStep.NONE,
         isLoadingStory: true,
         timeLeft: 0
     };
     updateAndBroadcast(newState);
     
     setTimeout(async () => {
         const story = await generateNightStory(newState.round, updatedPlayers.filter(p => newState.lastNightDeadIds.includes(p.id) || p.id === newDeadId), updatedPlayers);
         updateAndBroadcast({
             ...newState,
             currentStory: story,
             storyLog: [...newState.storyLog, `猎人开枪: ${story}`],
             isLoadingStory: false
         });
     }, 100);
  };

  const startDiscussion = async () => {
      if (!isHost) return;
      updateAndBroadcast({ ...gameState, phase: Phase.DAY_DISCUSSION, isLoadingStory: true });
      const alivePlayers = gameState.players.filter(p => p.isAlive);
      const prompt = await generateDiscussionTopic(alivePlayers);
      updateAndBroadcast({ 
          ...gameState, 
          phase: Phase.DAY_DISCUSSION,
          currentStory: prompt,
          isLoadingStory: false 
      });
  };

  const startVoting = () => {
      if (!isHost) return;
      updateAndBroadcast({ 
        ...gameState, 
        currentVotes: {}, 
        phase: Phase.VOTING, 
        currentStory: "请所有幸存玩家输入座位号进行投票。" 
      });
  };

  const submitVotes = () => {
      if (!isHost) return;
      const voteCounts: Record<number, number> = {};
      Object.values(gameState.currentVotes).forEach(val => {
          const targetId = val as number;
          voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
      });

      let maxVotes = 0;
      let exiledId: number | null = null;
      let isTie = false;

      Object.entries(voteCounts).forEach(([idStr, count]) => {
          const id = parseInt(idStr);
          if (count > maxVotes) {
              maxVotes = count;
              exiledId = id;
              isTie = false;
          } else if (count === maxVotes) {
              isTie = true;
          }
      });

      if (isTie || exiledId === null) {
          updateAndBroadcast({
              ...gameState,
              storyLog: [...gameState.storyLog, "投票平局，无人放逐。"],
              currentStory: "投票平局，无人被放逐。天又要黑了..."
          });
          setTimeout(() => startNight(), 4000);
      } else {
          const updatedPlayers = gameState.players.map(p => ({
              ...p,
              isAlive: p.id === exiledId ? false : p.isAlive,
              hasLastWords: p.id === exiledId ? true : p.hasLastWords // Exiled player gets Last Words
          }));
          const exiledPlayer = gameState.players.find(p => p.id === exiledId);
          
          const newState = {
              ...gameState,
              players: updatedPlayers,
              storyLog: [...gameState.storyLog, `${exiledPlayer?.name} 被放逐。`],
              currentStory: `${exiledPlayer?.name} 被投票放逐了。请发表遗言。`
          };
          updateAndBroadcast(newState);
          
          if (exiledPlayer?.role === Role.HUNTER) {
             // Delay slightly to let story update
             setTimeout(() => {
                 updateAndBroadcast({ ...newState, phase: Phase.NIGHT, nightStep: NightStep.HUNTER_ACTION, hunterTargetId: null, currentStory: "猎人被放逐，请开枪。", timeLeft: ACTION_TIMEOUT_SECONDS });
             }, 3000);
          } else {
             setTimeout(() => {
                 const wolves = updatedPlayers.filter(p => p.isAlive && p.role === Role.WEREWOLF);
                 const good = updatedPlayers.filter(p => p.isAlive && p.role !== Role.WEREWOLF);
                 if (wolves.length === 0) updateAndBroadcast({ ...newState, phase: Phase.GAME_OVER, winner: 'VILLAGERS' });
                 else if (wolves.length >= good.length) updateAndBroadcast({ ...newState, phase: Phase.GAME_OVER, winner: 'WEREWOLVES' });
                 else startNight();
             }, 8000); // Longer wait for last words time
          }
      }
  };

  // --- UI Helpers ---

  const handleSeatInput = (action: (id: number) => void) => {
    const seatNum = parseInt(targetInput);
    if (isNaN(seatNum) || seatNum < 1 || seatNum > gameState.players.length) {
        alert("请输入有效的座位号");
        return;
    }
    const targetId = seatNum - 1;
    // Basic check if target exists
    if (!gameState.players[targetId]) {
        alert("玩家不存在");
        return;
    }
    action(targetId);
    setTargetInput('');
  };

  // --- Render Sections ---

  const renderMenu = () => (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 space-y-8 animate-fade-in">
        <h1 className="text-5xl font-black text-indigo-400 tracking-tighter text-center">AI 狼人杀</h1>
        <div className="space-y-4 w-full max-w-sm">
            <input 
                type="text" 
                placeholder="请输入你的昵称" 
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-center focus:border-indigo-500 outline-none"
                onChange={e => setPlayerName(e.target.value)}
                value={playerName}
            />
            <Button fullWidth onClick={() => playerName && setAppMode('SETUP')} disabled={!playerName}>
                创建房间 (房主)
            </Button>
            <div className="flex gap-2">
                <input 
                    type="text" 
                    placeholder="输入房间 ID" 
                    className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-center text-sm uppercase"
                    onChange={e => setJoinRoomId(e.target.value)}
                />
                <Button onClick={joinRoom} disabled={!joinRoomId || !playerName}>加入</Button>
            </div>
        </div>
    </div>
  );

  const renderLobby = () => (
      <div className="max-w-4xl mx-auto p-6 space-y-8">
          <div className="flex justify-between items-center">
             <Button variant="secondary" onClick={leaveRoom} className="text-sm">← 离开房间</Button>
             <h2 className="text-2xl font-bold text-slate-300">游戏大厅</h2>
             <div className="w-20"></div> 
          </div>
          
          <div className="text-center">
              {isHost && (
                  <div className="mt-4 bg-indigo-900/30 p-4 rounded-xl border border-indigo-500/50 inline-block">
                      <p className="text-xs text-indigo-300 uppercase tracking-wide">房间 ID</p>
                      <p className="text-3xl font-mono font-bold text-white select-all">{peerId}</p>
                      <p className="text-xs text-slate-400 mt-2">分享给好友加入游戏</p>
                  </div>
              )}
              {!isHost && <p className="mt-4 text-slate-400">等待房主开始游戏...</p>}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {gameState.players.map(p => (
                  <div key={p.id} className="relative bg-slate-800 p-4 rounded-xl flex flex-col items-center">
                      <div className="absolute top-2 left-2 bg-slate-700 text-white w-6 h-6 flex items-center justify-center rounded-full text-xs font-mono">{p.id + 1}</div>
                      <img src={p.avatar} className="w-16 h-16 rounded-full mb-2 bg-slate-700" alt="avatar"/>
                      <span className="font-bold">{p.name} {p.id === myPlayerId ? '(我)' : ''}</span>
                      {p.isHost && <span className="text-xs text-amber-500 border border-amber-500 px-1 rounded mt-1">房主</span>}
                  </div>
              ))}
          </div>

          {isHost && (
              <Button fullWidth onClick={startGame} disabled={gameState.players.length < gameState.mode}>
                  开始游戏 ({gameState.players.length}/{gameState.mode}人)
              </Button>
          )}
      </div>
  );

  const renderRoleReveal = () => {
    const me = gameState.players.find(p => p.id === myPlayerId);
    if (!me) return null;
    return (
        <div className="flex flex-col items-center justify-center h-full p-8 text-center relative">
            <Button variant="secondary" onClick={leaveRoom} className="absolute top-4 left-4">退出</Button>
            <h2 className="text-2xl font-bold mb-8">你的身份是</h2>
            <div className="text-xl mb-4 text-slate-400 font-mono bg-slate-800 px-3 py-1 rounded-full inline-block">
                座位号: {me.id + 1}
            </div>
            <div className="animate-bounce mb-8 text-8xl">
                {me.role === Role.WEREWOLF ? '🐺' : 
                 me.role === Role.SEER ? '🔮' : 
                 me.role === Role.WITCH ? '🧪' : 
                 me.role === Role.HUNTER ? '🔫' : '🧑‍🌾'}
            </div>
            <h3 className="text-4xl font-black text-indigo-400 mb-4">{me.role}</h3>
            {isHost && (
                <Button onClick={() => startNight()}>进入天黑</Button>
            )}
            {!isHost && <p className="text-slate-500 animate-pulse">等待法官宣布天黑...</p>}
        </div>
    );
  };

  // Shared Chat Component
  const renderChat = (type: 'public' | 'wolf') => {
      const history = type === 'public' ? gameState.publicChatHistory : gameState.wolfChatHistory;
      const ref = type === 'public' ? publicChatScrollRef : chatScrollRef;
      const title = type === 'public' ? '💬 讨论频道' : '🐺 狼人频道';
      
      const me = gameState.players.find(p => p.id === myPlayerId);
      const canSpeak = me && (
          (type === 'wolf' && me.role === Role.WEREWOLF && gameState.phase === Phase.NIGHT) ||
          (type === 'public' && (me.isAlive || me.hasLastWords))
      );
      
      // Determine placeholder
      let placeholder = "发言...";
      if (!me?.isAlive && me?.hasLastWords && type === 'public') placeholder = "请发表遗言 (仅一次)...";
      if (!canSpeak) placeholder = "无法发言";

      return (
        <div className={`flex flex-col ${type === 'public' ? 'h-48' : 'h-32'} bg-slate-900 border-t border-slate-700 p-2`}>
            <div className="text-xs text-slate-500 mb-1 flex justify-between">
                <span>{title}</span>
                {type === 'public' && me?.hasLastWords && <span className="text-green-400">有遗言机会</span>}
            </div>
            <div className="flex-1 overflow-y-auto space-y-2 mb-2 bg-slate-950/50 p-2 rounded" ref={ref}>
                {history.map(msg => (
                    <div key={msg.id} className="text-xs break-all">
                        <span className={`font-bold ${msg.senderName.includes('(遗言)') ? 'text-green-400' : 'text-indigo-300'}`}>
                            {msg.senderName}:
                        </span> <span className="text-slate-300">{msg.text}</span>
                    </div>
                ))}
            </div>
            <div className="flex gap-2">
                <input 
                    className="flex-1 bg-slate-800 rounded px-2 py-1 text-sm outline-none border border-slate-700 focus:border-indigo-500 disabled:opacity-50"
                    value={type === 'public' && appMode === 'GAME' ? chatInput : chatInput} 
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && canSpeak && sendChatMessage(type)}
                    placeholder={placeholder}
                    disabled={!canSpeak}
                />
                <Button 
                    variant="secondary" 
                    className="py-1 px-3 text-sm" 
                    onClick={() => sendChatMessage(type)}
                    disabled={!canSpeak}
                >
                    发送
                </Button>
            </div>
        </div>
      );
  };

  const renderGame = () => {
     const me = gameState.players.find(p => p.id === myPlayerId);
     const isNight = gameState.phase === Phase.NIGHT;
     
     // Ability Checks
     const isWolfTurn = isNight && gameState.nightStep === NightStep.WEREWOLF_ACTION && me?.role === Role.WEREWOLF && me.isAlive;
     const isSeerTurn = isNight && gameState.nightStep === NightStep.SEER_ACTION && me?.role === Role.SEER && me.isAlive;
     const isWitchTurn = isNight && gameState.nightStep === NightStep.WITCH_ACTION && me?.role === Role.WITCH && me.isAlive;
     const isHunterTurn = (isNight || gameState.phase === Phase.NIGHT) && gameState.nightStep === NightStep.HUNTER_ACTION && me?.role === Role.HUNTER; // Hunter acts when dead in this phase
     const isVoting = gameState.phase === Phase.VOTING && me?.isAlive;
     
     // Countdown Display
     const showTimer = isNight && gameState.nightStep !== NightStep.NONE;

     return (
         <div className="flex flex-col h-full max-w-4xl mx-auto p-4 space-y-4">
            <div className="flex justify-between items-center relative">
                 <Button variant="secondary" onClick={leaveRoom} className="text-xs absolute left-0">退出</Button>
                 <div className="w-full text-center">
                    <div className="flex flex-col items-center mb-2">
                        <div className="inline-block bg-indigo-900/50 px-3 py-1 rounded-full text-xs font-bold mb-1">
                            第 {gameState.round} 天 - {isNight ? "黑夜" : "白天"}
                        </div>
                        {showTimer && (
                            <div className={`text-xl font-mono font-bold ${gameState.timeLeft <= 5 ? 'text-red-500 animate-pulse' : 'text-amber-400'}`}>
                                ⏰ {gameState.timeLeft}s
                            </div>
                        )}
                    </div>
                    <h2 className="text-xl font-bold text-slate-100 px-12 line-clamp-2">{gameState.currentStory}</h2>
                 </div>
             </div>
             
             {/* Main Grid */}
             <div className="grid grid-cols-3 md:grid-cols-4 gap-3 flex-grow overflow-y-auto pb-4 content-start">
                 {gameState.players.map(p => {
                     // Privacy Logic: Only show 'selected' border if I am the role that selected this player
                     let isSelected = false;
                     if (isWolfTurn && p.id === gameState.wolvesTargetId) isSelected = true;
                     if (isSeerTurn && p.id === gameState.seerCheckId) isSelected = true;
                     if (isWitchTurn && p.id === gameState.witchAction.poisonTargetId) isSelected = true;
                     if (isHunterTurn && p.id === gameState.hunterTargetId) isSelected = true;
                     
                     // Vote counting logic
                     const votesReceived = Object.entries(gameState.currentVotes)
                        .filter(([_, target]) => (target as number) === p.id)
                        .map(([voterId]) => parseInt(voterId) + 1); // 1-indexed

                     return (
                         <div key={p.id} className="relative">
                            <PlayerCard
                                player={p}
                                isMe={p.id === myPlayerId}
                                revealed={
                                    p.id === myPlayerId || 
                                    (!p.isAlive) || 
                                    (me?.role === Role.WEREWOLF && p.role === Role.WEREWOLF)
                                }
                                selected={isSelected}
                            />
                            {/* Vote Badges */}
                            {votesReceived.length > 0 && (
                                <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 flex gap-1 z-20">
                                    {votesReceived.map(voterSeat => (
                                        <div key={voterSeat} className="bg-amber-500 text-slate-900 text-[10px] w-4 h-4 rounded-full flex items-center justify-center font-bold shadow-sm border border-white">
                                            {voterSeat}
                                        </div>
                                    ))}
                                </div>
                            )}
                         </div>
                     );
                 })}
             </div>

             {/* Voting Results Overlay */}
             {isVoting && (
                 <div className="text-center text-xs text-amber-500">
                     正在投票... 票数将在结果公布时揭晓
                 </div>
             )}

             {/* --- Action Control Panel --- */}
             <div className="bg-slate-800 rounded-xl p-4 shadow-lg border border-slate-700">
                 
                 {/* 1. Wolf Action */}
                 {isWolfTurn && (
                     <div className="flex gap-2 items-center">
                         <span className="text-red-400 font-bold whitespace-nowrap">🐺 袭击目标:</span>
                         <input 
                            type="number" 
                            className="w-16 bg-slate-900 border border-slate-600 rounded px-2 py-1"
                            placeholder="#"
                            value={targetInput}
                            onChange={e => setTargetInput(e.target.value)}
                         />
                         <Button onClick={() => handleSeatInput(handleWolfSelect)} className="text-sm">确认袭击</Button>
                     </div>
                 )}

                 {/* 2. Seer Action */}
                 {isSeerTurn && (
                    <div className="space-y-2">
                         <div className="flex gap-2 items-center">
                             <span className="text-indigo-400 font-bold whitespace-nowrap">🔮 查验目标:</span>
                             <input 
                                type="number" 
                                className="w-16 bg-slate-900 border border-slate-600 rounded px-2 py-1"
                                placeholder="#"
                                value={targetInput}
                                onChange={e => setTargetInput(e.target.value)}
                                disabled={gameState.seerCheckId !== null} // Lock after check
                             />
                             <Button 
                                onClick={() => handleSeatInput(handleSeerCheck)} 
                                className="text-sm"
                                disabled={gameState.seerCheckId !== null}
                             >
                                 查验
                             </Button>
                         </div>
                         {/* Result Display */}
                         {gameState.seerCheckId !== null && (
                            <div className="bg-indigo-900/50 p-2 rounded text-center border border-indigo-500">
                                玩家 <span className="font-bold text-lg mx-1">{gameState.seerCheckId + 1}</span> 是: 
                                <span className="font-bold text-xl ml-2 text-white">
                                    {gameState.players[gameState.seerCheckId].role === Role.WEREWOLF ? "🐺 狼人" : "✅ 好人"}
                                </span>
                            </div>
                         )}
                    </div>
                 )}

                 {/* 3. Witch Action */}
                 {isWitchTurn && (
                     <div className="space-y-3">
                         {/* Save Info */}
                         <div className="flex justify-between items-center bg-slate-700/50 p-2 rounded">
                             <span className="text-sm text-slate-300">昨晚死亡:</span>
                             {/* Show info only if save is available or used now */}
                             {!gameState.witchSaveUsed || gameState.witchAction.save ? (
                                 <span className="font-bold text-red-400">
                                     {gameState.wolvesTargetId !== null 
                                        ? `${gameState.wolvesTargetId + 1}号 (${gameState.players[gameState.wolvesTargetId].name})` 
                                        : "无人死亡"}
                                 </span>
                             ) : (
                                 <span className="text-xs text-slate-500">解药已用，无法查看</span>
                             )}
                         </div>

                         <div className="flex gap-2">
                             <Button 
                                 fullWidth 
                                 variant={gameState.witchAction.save ? "primary" : "secondary"}
                                 onClick={() => handleWitchAction('save')}
                                 disabled={gameState.witchSaveUsed || gameState.wolvesTargetId === null}
                                 className="text-sm"
                             >
                                 {gameState.witchAction.save ? "取消使用解药" : "使用解药"}
                             </Button>
                         </div>

                         <div className="flex gap-2 items-center border-t border-slate-700 pt-2">
                             <span className="text-purple-400 font-bold whitespace-nowrap text-sm">毒药目标:</span>
                             <input 
                                type="number" 
                                className="w-16 bg-slate-900 border border-slate-600 rounded px-2 py-1"
                                placeholder="#"
                                value={targetInput}
                                onChange={e => setTargetInput(e.target.value)}
                                disabled={gameState.witchPoisonUsed}
                             />
                             <Button 
                                onClick={() => handleSeatInput((id) => handleWitchAction('poison', id))} 
                                disabled={gameState.witchPoisonUsed}
                                className="text-sm"
                             >
                                 泼毒
                             </Button>
                         </div>
                     </div>
                 )}

                 {/* 4. Hunter Action */}
                 {isHunterTurn && (
                     <div className="flex gap-2 items-center animate-pulse">
                         <span className="text-orange-400 font-bold whitespace-nowrap">🔫 带走一人:</span>
                         <input 
                            type="number" 
                            className="w-16 bg-slate-900 border border-slate-600 rounded px-2 py-1"
                            placeholder="#"
                            value={targetInput}
                            onChange={e => setTargetInput(e.target.value)}
                         />
                         <Button onClick={() => handleSeatInput(handleHunterShoot)} variant="danger" className="text-sm">开枪</Button>
                     </div>
                 )}

                 {/* 5. Voting Action */}
                 {isVoting && (
                     <div className="flex gap-2 items-center justify-center">
                         <span className="text-amber-400 font-bold whitespace-nowrap">🗳️ 投票给:</span>
                         <input 
                            type="number" 
                            className="w-16 bg-slate-900 border border-slate-600 rounded px-2 py-1"
                            placeholder="#"
                            value={targetInput}
                            onChange={e => setTargetInput(e.target.value)}
                         />
                         <Button onClick={() => handleSeatInput((id) => sendAction('VOTE', { targetId: id }))} className="text-sm">确认投票</Button>
                     </div>
                 )}

                 {/* Host Controls */}
                 {isHost && isNight && gameState.nightStep !== NightStep.NONE && (
                     <Button fullWidth onClick={() => {
                        handleTimerExpire(); // Manually trigger early
                     }} className="mt-4 border-t border-slate-600 pt-2">
                         法官：立即结束本环节
                     </Button>
                 )}
                 {isHost && gameState.phase === Phase.DAY_TRANSITION && (
                     <Button fullWidth onClick={startDiscussion} className="mt-2">开始讨论</Button>
                 )}
                 {isHost && gameState.phase === Phase.DAY_DISCUSSION && (
                     <Button fullWidth onClick={startVoting} className="mt-2">发起投票</Button>
                 )}
                 {isHost && gameState.phase === Phase.VOTING && (
                     <Button fullWidth onClick={submitVotes} className="mt-4">公布投票结果</Button>
                 )}

                 {/* Fallback Text for non-active players */}
                 {!isWolfTurn && !isSeerTurn && !isWitchTurn && !isHunterTurn && !isVoting && !isHost && (
                     <div className="text-center text-slate-500 text-sm italic">
                         等待其他玩家行动...
                     </div>
                 )}
             </div>

             {/* Chat Section */}
             {isNight && me?.role === Role.WEREWOLF && renderChat('wolf')}
             {!isNight && renderChat('public')}

         </div>
     );
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 flex flex-col relative">
       {/* Sound Toggle */}
       <button 
         onClick={() => setIsMuted(!isMuted)}
         className="absolute top-4 right-4 z-50 bg-slate-800 p-2 rounded-full border border-slate-700 hover:bg-slate-700"
         title={isMuted ? "开启语音" : "静音"}
       >
         {isMuted ? "🔇" : "🔊"}
       </button>

       <main className="flex-grow overflow-y-auto flex flex-col">
          {appMode === 'MENU' && renderMenu()}
          {appMode === 'SETUP' && <GameSetup onStart={createRoom} onBack={() => setAppMode('MENU')} />}
          {appMode === 'JOIN' && (
              <div className="text-center p-10 relative">
                  <Button variant="secondary" onClick={leaveRoom} className="absolute top-4 left-4">取消</Button>
                  正在加入房间...<br/>
                  <span className="text-xs text-slate-500 mt-2">若长时间无反应，请检查房间 ID 是否正确</span>
              </div>
          )}
          {appMode === 'LOBBY' && renderLobby()}
          {appMode === 'GAME' && (
              gameState.phase === Phase.ROLE_REVEAL ? renderRoleReveal() :
              gameState.phase === Phase.GAME_OVER ? 
                <div className="text-center p-10 flex flex-col items-center justify-center h-full">
                    <h1 className="text-4xl font-bold mb-4">{gameState.winner === 'WEREWOLVES' ? '🐺 狼人胜利' : '🧑‍🌾 好人胜利'}</h1>
                    <Button className="mt-4" onClick={leaveRoom}>返回首页</Button>
                </div> 
                : renderGame()
          )}
       </main>
       
       {/* Log Drawer */}
       {appMode === 'GAME' && gameState.phase !== Phase.ROLE_REVEAL && (
           <div className="border-t border-slate-800 bg-slate-900 p-2 max-h-32 overflow-y-auto flex-shrink-0" ref={scrollRef}>
               {gameState.storyLog.map((log, idx) => (
                   <p key={idx} className="text-xs text-slate-400 mb-1 font-mono">> {log}</p>
               ))}
           </div>
       )}
    </div>
  );
};

export default App;
