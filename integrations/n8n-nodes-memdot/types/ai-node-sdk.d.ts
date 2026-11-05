// The part of n8n's AI node SDK this package uses. n8n supplies the real one when it loads the node,
// so installing it here would only add hundreds of packages for these few signatures.
declare module "@n8n/ai-node-sdk" {
  import type { ISupplyDataFunctions, SupplyData } from "n8n-workflow";

  export type MessageRole = "system" | "user" | "assistant" | "tool";
  export type MessageContent = { type: "text"; text: string } | { type: string };

  export interface Message {
    role: MessageRole;
    content: MessageContent[];
  }

  export interface ChatHistory {
    getMessages(): Promise<Message[]>;
    addMessage(message: Message): Promise<void>;
    addMessages(messages: Message[]): Promise<void>;
    clear(): Promise<void>;
  }

  export interface ChatMemory {
    loadMessages(): Promise<Message[]>;
    saveTurn(input: string, output: string): Promise<void>;
    clear(): Promise<void>;
    readonly chatHistory: ChatHistory;
  }

  export function supplyMemory(context: ISupplyDataFunctions, memory: ChatMemory): SupplyData;
}
