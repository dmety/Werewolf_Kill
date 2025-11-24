
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
  wolvesTargetId: null,
  seerCheckId: null,
  witchSaveUsed: false,
  witchPoisonUsed: false,
  witchAction: { save: false, poisonTargetId: null },
  hunterTargetId: null,
  currentVotes: {},
  wolfChatHistory: [],
  lastNightDeadIds: [],
  winner: null,
  storyLog: [],
  currentStory: "",
  isLoadingStory: false,
  roomId: undefined
});

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [gameState.storyLog, gameState.currentStory]);

  // Auto-scroll chat
  useEffect(() => {
    if (chatScrollRef.current) {
        chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [gameState.wolfChatHistory]);

  // --- TTS Trigger ---
  useEffect(() => {
    // When currentStory changes, speak it if not muted
    // We skip speaking during loading state or empty strings
    if (!isMuted && gameState.currentStory && !gameState.isLoadingStory) {
      speak(gameState.currentStory);
    }
  }, [gameState.currentStory, gameState.isLoadingStory, isMuted]);

  // Stop speech when component unmounts or game over
  useEffect(() => {
    return () => stopSpeech();
  }, []);

  // --- Networking: Message Handler Ref Pattern ---
  // This ref always holds the latest version of the handler to avoid stale closures in PeerJS listeners
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
        // Host Logic: Receiving a connection
        conn.on('data', (data) => {
          // Use the ref to ensure we have latest state (isHost, etc)
          if (handleNetworkMessageRef.current) {
             handleNetworkMessageRef.current(data as NetworkMessage, conn);
          }
        });
  
        conn.on('open', () => {
          // Add to connections list if host
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
    // console.log("Received Msg:", msg, "Am I Host?", isHost);
    
    if (msg.type === 'JOIN') {
      // Host receives JOIN
      if (!isHost) {
        console.warn("Received JOIN but I am not host. State issue?");
        return;
      }
      
      const newPlayerId = gameState.players.length;
      const newPlayer: Player = {
        id: newPlayerId,
        name: msg.payload.name,
        role: Role.VILLAGER, // Temporary, assigned on start
        isAlive: true,
        avatar: `https://picsum.photos/seed/${msg.payload.peerId}/200`,
        peerId: msg.payload.peerId
      };

      const updatedPlayers = [...gameState.players, newPlayer];
      
      // Update local state (Host)
      const newState = { ...gameState, players: updatedPlayers };
      setGameState(newState);

      // Send Welcome to new player
      conn?.send({
        type: 'WELCOME',
        payload: { playerId: newPlayerId, gameState: newState }
      } as NetworkMessage);

      // Broadcast update to all others
      broadcastState(newState);
    }

    if (msg.type === 'WELCOME') {
      // Client receives WELCOME
      setMyPlayerId(msg.payload.playerId);
      setGameState(msg.payload.gameState);
      setAppMode('LOBBY');
    }

    if (msg.type === 'STATE_UPDATE') {
      // Client receives State Update
      setGameState(msg.payload.gameState);
      // Determine if game started
      if (msg.payload.gameState.phase !== Phase.LOBBY && appMode === 'LOBBY') {
        setAppMode('GAME');
      }
    }

    if (msg.type === 'ACTION') {
      // Host receives Action (Vote, Night Action)
      if (!isHost) return;
      handleClientAction(msg.payload.action, msg.payload.data, msg.payload.fromPlayerId);
    }

    if (msg.type === 'CHAT') {
        // Only Host receives CHAT from clients, then broadcasts via state
        if (isHost) {
            const newHistory = [...gameState.wolfChatHistory, msg.payload.message];
            const newState = { ...gameState, wolfChatHistory: newHistory };
            updateAndBroadcast(newState);
        }
    }
  };

  // Keep the ref updated on every render
  useEffect(() => {
    handleNetworkMessageRef.current = handleNetworkMessage;
  });

  const broadcastState = (newState: GameState) => {
    // In a real app, we should scrub secret info (roles) for clients
    // For this prototype, we send full state but client UI hides it.
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

  const sendChatMessage = () => {
      if (!chatInput.trim()) return;
      
      const me = gameState.players.find(p => p.id === myPlayerId);
      const msg: ChatMessage = {
          id: Date.now().toString() + Math.random(),
          senderId: myPlayerId!,
          senderName: me?.name || 'Unknown',
          text: chatInput,
          timestamp: Date.now()
      };

      if (isHost) {
          const newState = { ...gameState, wolfChatHistory: [...gameState.wolfChatHistory, msg] };
          updateAndBroadcast(newState);
      } else {
          hostConnRef.current?.send({
              type: 'CHAT',
              payload: { message: msg }
          });
      }
      setChatInput('');
  };

  const leaveRoom = () => {
      // Reset State
      setGameState(createInitialState());
      setAppMode('MENU');
      setMyPlayerId(null);
      setIsHost(false);
      
      // Close Connections
      connectionsRef.current.forEach(c => c.close());
      connectionsRef.current = [];
      
      if (hostConnRef.current) {
          hostConnRef.current.close();
          hostConnRef.current = null;
      }

      // Re-init peer to get a fresh ID if needed, or just keep same peer
      // peerRef.current is usually fine to keep open, but let's just clear connections.
  };

  // --- Host Logic: Client Action Handler ---
  const handleClientAction = (action: string, data: any, fromId: number) => {
    // console.log(`Action ${action} from ${fromId}`, data);
    
    if (action === 'VOTE') {
       // Update votes in GameState
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
      role: Role.VILLAGER, // Placeholder
      isAlive: true,
      avatar: `https://picsum.photos/seed/host/200`,
      peerId: peerId,
      isHost: true
    };

    setGameState({
      ...createInitialState(),
      mode: config.totalPlayers,
      config: config, // Persist config
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
    
    setAppMode('JOIN'); // Wait for Welcome
  };

  const startGame = () => {
    if (!isHost) return;
    
    // Distribute roles based on Config
    const roles: Role[] = [];
    Object.entries(gameState.config.roleCounts).forEach(([role, count]) => {
      for(let i=0; i<(count as number); i++) roles.push(role as Role);
    });
    
    // Safety check: fill with Villagers if something is wrong
    while(roles.length < gameState.players.length) {
      roles.push(Role.VILLAGER);
    }
    
    // Shuffle
    for (let i = roles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }

    const newPlayers = gameState.players.map((p, i) => ({
      ...p,
      role: roles[i] || Role.VILLAGER
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

  // --- Game Logic Methods ---
  
  const startNight = () => {
    const newState = {
      ...gameState,
      phase: Phase.NIGHT,
      round: gameState.round + 1,
      nightStep: NightStep.WEREWOLF_ACTION,
      wolvesTargetId: null,
      seerCheckId: null,
      // Witch potion usage persists across rounds, but action target resets
      witchAction: { save: false, poisonTargetId: null },
      hunterTargetId: null,
      currentVotes: {}, // Clear votes
      // wolfChatHistory: [], // Optional: Clear chat every night? Keeping history is usually better.
      currentStory: "天黑请闭眼。狼人请睁眼，请确认你们的袭击目标..."
    };
    updateAndBroadcast(newState);
  };

  const updateAndBroadcast = (newState: GameState) => {
    setGameState(newState);
    broadcastState(newState);
  };
  
  const handleWolfSelect = (targetId: number) => {
    if (!isHost) {
        sendAction('NIGHT_ACTION', { type: 'WOLF_KILL', targetId });
        return;
    }
    setGameState(prev => ({ ...prev, wolvesTargetId: targetId }));
    broadcastState({ ...gameState, wolvesTargetId: targetId });
  };

  const confirmWolfAction = () => {
    if (!isHost) return;
    let nextStep: NightStep = NightStep.SEER_ACTION;
    
    // Check if Seer exists
    if (!gameState.config.roleCounts[Role.SEER]) {
       nextStep = NightStep.WITCH_ACTION;
    }

    // Check if Witch exists (if we are skipping Seer or Seer is done)
    if (nextStep === NightStep.WITCH_ACTION && !gameState.config.roleCounts[Role.WITCH]) {
        nextStep = NightStep.NONE;
    }

    const newState = {
      ...gameState,
      nightStep: nextStep,
      currentStory: nextStep === NightStep.NONE 
        ? "天亮了..." 
        : (nextStep === NightStep.SEER_ACTION ? "狼人请闭眼。预言家请睁眼，你要查验谁的身份？" : "狼人请闭眼。女巫请睁眼...")
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
          currentStory: nextStep === NightStep.NONE ? "天亮了..." : "预言家请闭眼。女巫请睁眼，你有一瓶毒药和一瓶解药..."
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
          currentStory: "天亮了..."
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
      
      const updatedPlayers = players.map(p => ({
          ...p,
          isAlive: deadIds.includes(p.id) ? false : p.isAlive
      }));

      const hunter = updatedPlayers.find(p => p.role === Role.HUNTER);
      const hunterDied = hunter && deadIds.includes(hunter.id);
      const hunterPoisoned = hunter && witchAction.poisonTargetId === hunter.id;
      // Hunter can shoot if died by wolf (not poisoned) or just regular death? 
      // Traditional rules: Hunter cannot shoot if poisoned.
      const canHunterShoot = hunterDied && !hunterPoisoned;

      const nextPhase = canHunterShoot ? Phase.NIGHT : Phase.DAY_TRANSITION;
      const nextNightStep = canHunterShoot ? NightStep.HUNTER_ACTION : NightStep.NONE;

      const newState = {
          ...currentState,
          players: updatedPlayers,
          lastNightDeadIds: deadIds,
          phase: nextPhase,
          nightStep: nextNightStep,
          isLoadingStory: true
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
              currentStory: "猎人请睁眼。你已倒牌，请选择开枪带走的目标...",
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
     if (gameState.hunterTargetId === null) return;
     
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
         isLoadingStory: true
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
        currentStory: "请所有幸存玩家进行投票。" 
      });
  };

  const submitVotes = () => {
      if (!isHost) return;
      // Calculate from GameState.currentVotes
      const voteCounts: Record<number, number> = {};
      Object.values(gameState.currentVotes).forEach(val => {
          voteCounts[val] = (voteCounts[val] || 0) + 1;
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
              isAlive: p.id === exiledId ? false : p.isAlive
          }));
          const exiledPlayer = gameState.players.find(p => p.id === exiledId);
          
          const newState = {
              ...gameState,
              players: updatedPlayers,
              storyLog: [...gameState.storyLog, `${exiledPlayer?.name} 被放逐。`],
              currentStory: `${exiledPlayer?.name} 被投票放逐了。`
          };
          updateAndBroadcast(newState);
          
          if (exiledPlayer?.role === Role.HUNTER) {
             updateAndBroadcast({ ...newState, phase: Phase.NIGHT, nightStep: NightStep.HUNTER_ACTION, hunterTargetId: null, currentStory: "猎人被放逐，请开枪。" });
          } else {
             setTimeout(() => {
                 const wolves = updatedPlayers.filter(p => p.isAlive && p.role === Role.WEREWOLF);
                 const good = updatedPlayers.filter(p => p.isAlive && p.role !== Role.WEREWOLF);
                 if (wolves.length === 0) updateAndBroadcast({ ...newState, phase: Phase.GAME_OVER, winner: 'VILLAGERS' });
                 else if (wolves.length >= good.length) updateAndBroadcast({ ...newState, phase: Phase.GAME_OVER, winner: 'WEREWOLVES' });
                 else startNight();
             }, 4000);
          }
      }
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
             <div className="w-20"></div> {/* Spacer */}
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
                  <div key={p.id} className="bg-slate-800 p-4 rounded-xl flex flex-col items-center">
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

  const renderWolfChat = () => {
      // Chat is visible to wolves during night
      // Or maybe always? Usually only night.
      // For this implementation, let's keep it visible at night for wolves.
      return (
        <div className="bg-slate-900 border-t border-slate-700 p-2 flex flex-col h-48">
            <div className="text-xs text-slate-500 mb-1">🐺 狼人频道</div>
            <div className="flex-1 overflow-y-auto space-y-2 mb-2 bg-slate-950/50 p-2 rounded" ref={chatScrollRef}>
                {gameState.wolfChatHistory.map(msg => (
                    <div key={msg.id} className="text-xs">
                        <span className="font-bold text-red-400">{msg.senderName}:</span> <span className="text-slate-300">{msg.text}</span>
                    </div>
                ))}
                {gameState.wolfChatHistory.length === 0 && <p className="text-xs text-slate-600 italic">暂无消息...</p>}
            </div>
            <div className="flex gap-2">
                <input 
                    className="flex-1 bg-slate-800 rounded px-2 py-1 text-sm outline-none border border-slate-700 focus:border-red-500"
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && sendChatMessage()}
                    placeholder="与同伴交流..."
                />
                <Button variant="secondary" className="py-1 px-3 text-sm" onClick={sendChatMessage}>发送</Button>
            </div>
        </div>
      );
  };

  const renderGame = () => {
     // Determine if I can act
     const me = gameState.players.find(p => p.id === myPlayerId);
     const canAct = me?.isAlive && (
         (gameState.nightStep === NightStep.WEREWOLF_ACTION && me.role === Role.WEREWOLF) ||
         (gameState.nightStep === NightStep.SEER_ACTION && me.role === Role.SEER) ||
         (gameState.nightStep === NightStep.WITCH_ACTION && me.role === Role.WITCH) ||
         (gameState.nightStep === NightStep.HUNTER_ACTION && me.role === Role.HUNTER)
     );

     // Voting Phase Special
     if (gameState.phase === Phase.VOTING) {
         return (
             <div className="p-4 max-w-2xl mx-auto space-y-6 flex flex-col h-full">
                 <div className="flex justify-between items-center">
                    <Button variant="secondary" onClick={leaveRoom} className="text-xs">退出</Button>
                    <h2 className="text-2xl font-bold text-amber-400">投票环节</h2>
                    <div className="w-10"></div>
                 </div>
                 <p className="text-center">{gameState.currentStory}</p>
                 
                 <div className="grid grid-cols-2 md:grid-cols-3 gap-3 flex-grow">
                     {gameState.players.map(p => {
                         // Calculate who voted for this player
                         const voters = Object.entries(gameState.currentVotes)
                            .filter(([_, target]) => target === p.id)
                            .map(([voterId]) => {
                                const vId = parseInt(voterId);
                                return gameState.players.find(pl => pl.id === vId)?.name || 'Unknown';
                            });
                         
                         return (
                            <div key={p.id} className="relative">
                                <PlayerCard 
                                    player={p} 
                                    selectable={p.isAlive && me?.isAlive} // Only alive can vote
                                    selected={myPlayerId !== null && gameState.currentVotes[myPlayerId] === p.id}
                                    onSelect={() => me?.isAlive && sendAction('VOTE', { targetId: p.id })}
                                    isMe={p.id === myPlayerId}
                                />
                                {voters.length > 0 && (
                                    <div className="absolute -bottom-2 -right-2 bg-amber-600 text-white text-xs rounded-full w-6 h-6 flex items-center justify-center font-bold border-2 border-slate-900 z-10">
                                        {voters.length}
                                    </div>
                                )}
                            </div>
                         );
                     })}
                 </div>
                 
                 {isHost && (
                     <div className="bg-slate-800 p-4 rounded mt-4">
                         <Button fullWidth className="mt-2" onClick={submitVotes}>公布结果</Button>
                     </div>
                 )}
             </div>
         );
     }

     return (
         <div className="flex flex-col h-full max-w-4xl mx-auto p-4 space-y-6">
            <div className="flex justify-between items-center relative">
                 <Button variant="secondary" onClick={leaveRoom} className="text-xs absolute left-0">退出</Button>
                 <div className="w-full text-center">
                    <div className="inline-block bg-indigo-900/50 px-3 py-1 rounded-full text-xs font-bold mb-2">
                        第 {gameState.round} 天 - {gameState.phase === Phase.NIGHT ? "黑夜" : "白天"}
                    </div>
                    <h2 className="text-xl font-bold text-slate-100 px-12">{gameState.currentStory}</h2>
                 </div>
             </div>
             
             {/* Main Grid */}
             <div className="grid grid-cols-3 md:grid-cols-4 gap-3 flex-grow overflow-y-auto pb-4">
                 {gameState.players.map(p => (
                     <PlayerCard
                        key={p.id}
                        player={p}
                        isMe={p.id === myPlayerId}
                        // Reveal role ONLY if it's me OR I am a wolf and they are a wolf
                        revealed={
                            p.id === myPlayerId || 
                            (!p.isAlive) || // Reveal dead
                            (me?.role === Role.WEREWOLF && p.role === Role.WEREWOLF)
                        }
                        selectable={canAct && p.isAlive}
                        selected={
                            gameState.wolvesTargetId === p.id ||
                            gameState.seerCheckId === p.id ||
                            gameState.witchAction.poisonTargetId === p.id ||
                            gameState.hunterTargetId === p.id
                        }
                        onSelect={() => {
                            if (!canAct) return;
                            if (gameState.nightStep === NightStep.WEREWOLF_ACTION) handleWolfSelect(p.id);
                            // Seer can check only 1, so overwriting is fine
                            if (gameState.nightStep === NightStep.SEER_ACTION) handleSeerCheck(p.id);
                            // Witch poisoning
                            if (gameState.nightStep === NightStep.WITCH_ACTION && !gameState.witchPoisonUsed) {
                                handleWitchAction('poison', p.id);
                            }
                            if (gameState.nightStep === NightStep.HUNTER_ACTION) handleHunterShoot(p.id);
                        }}
                     />
                 ))}
             </div>

             {/* Action Bar */}
             <div className="mt-auto">
                 {/* Seer Result */}
                 {me?.role === Role.SEER && gameState.seerCheckId !== null && (
                     <div className="bg-indigo-900/30 p-3 rounded text-center mb-4 border border-indigo-500 animate-pulse">
                         查验结果: <span className="font-bold text-xl ml-2">{gameState.players[gameState.seerCheckId].role === Role.WEREWOLF ? "🐺 狼人" : "✅ 好人"}</span>
                     </div>
                 )}
                 {/* Witch Controls */}
                 {me?.role === Role.WITCH && gameState.nightStep === NightStep.WITCH_ACTION && (
                     <div className="flex gap-2 mb-4">
                         <Button 
                             fullWidth 
                             variant={gameState.witchAction.save ? "primary" : "secondary"}
                             onClick={() => handleWitchAction('save')}
                             disabled={gameState.witchSaveUsed || !gameState.wolvesTargetId}
                         >
                             使用解药 ({gameState.wolvesTargetId ? "有人被杀" : "平安"})
                         </Button>
                         <div className="flex items-center text-xs text-slate-400 px-2">
                             {gameState.witchPoisonUsed ? "毒药已用" : "请点击玩家头像使用毒药"}
                         </div>
                     </div>
                 )}

                 {/* Wolf Chat - Only visible to wolves at night (or always if prefered, here only night) */}
                 {me?.role === Role.WEREWOLF && gameState.phase === Phase.NIGHT && renderWolfChat()}

                 {/* Phase Controls (Host Only usually, but actions are sent by clients) */}
                 {isHost && gameState.phase === Phase.NIGHT && gameState.nightStep !== NightStep.NONE && (
                     <Button fullWidth onClick={() => {
                        if (gameState.nightStep === NightStep.WEREWOLF_ACTION) confirmWolfAction();
                        else if (gameState.nightStep === NightStep.SEER_ACTION) confirmSeerAction();
                        else if (gameState.nightStep === NightStep.WITCH_ACTION) confirmWitchAction();
                        else if (gameState.nightStep === NightStep.HUNTER_ACTION) confirmHunterAction();
                     }} className="mt-2">
                         法官：确认并继续
                     </Button>
                 )}
                 
                 {isHost && gameState.phase === Phase.DAY_TRANSITION && (
                     <Button fullWidth onClick={startDiscussion} className="mt-2">开始讨论</Button>
                 )}
                 {isHost && gameState.phase === Phase.DAY_DISCUSSION && (
                     <Button fullWidth onClick={startVoting} className="mt-2">发起投票</Button>
                 )}
             </div>
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
