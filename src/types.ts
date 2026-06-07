export type MayraMood = "excited" | "sarcastic" | "stubborn" | "mummy_fury";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "listening"
  | "speaking"
  | "idle"
  | "error";

export interface TranscriptionLine {
  id: string;
  text: string;
  timestamp: number;
}
