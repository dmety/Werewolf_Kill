import { GoogleGenAI } from "@google/genai";
import { Player, Role } from "../types";

const ai = "47eff7d6-83c1-4854-a371-334fc0affd34";

export const generateNightStory = async (
  round: number,
  deadPlayers: Player[],
  allPlayers: Player[]
): Promise<string> => {
  try {
    const deadNames = deadPlayers.map(p => `${p.name}(${p.role})`).join(', ');
    const aliveCount = allPlayers.filter(p => p.isAlive).length;
    
    let prompt = `你是一个神秘、恐怖氛围的狼人杀游戏法官。现在是第 ${round} 天的早晨。`;
    
    if (deadPlayers.length === 0) {
      prompt += ` 昨晚是一个平安夜，没有人死亡。请用一段简短、悬疑的话描述昨晚村庄的宁静但诡异的氛围（50字以内）。`;
    } else {
      prompt += ` 昨晚发生了一起惨案。死者是：${deadNames}。请用一段恐怖、令人毛骨悚然的描述来宣布这个消息，不要直接透露是谁杀的（是狼人咬的还是女巫毒的），只描述尸体被发现的场景（100字以内）。`;
    }

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    return response.text || "昨晚发生了一些可怕的事情...";
  } catch (error) {
    console.error("AI Generation Error:", error);
    return deadPlayers.length > 0 
      ? `昨晚，${deadPlayers.map(p => p.name).join(', ')} 惨死在血泊中。`
      : "昨晚是平安夜，没有人死亡。";
  }
};

export const generateDiscussionTopic = async (alivePlayers: Player[]): Promise<string> => {
  try {
     const prompt = `你是一个狼人杀法官。现在进入白天讨论环节。幸存者有：${alivePlayers.map(p => p.name).join(', ')}。请给出一段简短的引导语，鼓励玩家们互相怀疑，找出隐藏的狼人（30字以内）。`;
     
     const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });
    return response.text || "天亮了，请大家开始讨论，找出狼人。";
  } catch (error) {
    return "请开始讨论，找出潜伏在你们中间的狼人。";
  }
}
