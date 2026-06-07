import express from "express";
import http from "http";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Modality, Type } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const PORT = 3000;

  // 1. Initialize Gemini SDK
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("WARNING: GEMINI_API_KEY environment variable is not set!");
  }

  const ai = new GoogleGenAI({
    apiKey: apiKey || "",
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });

  // 2. Setup WebSocket Server on the same HTTP server
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url || "", `http://${request.headers.host}`);
    
    if (pathname === "/ws/live") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
    }
  });

  wss.on("connection", async (clientWs: WebSocket) => {
    console.log("Client connected to MAX WebSocket live channel");
    clientWs.send(JSON.stringify({ type: "status", status: "connecting" }));

    let session: any = null;

    try {
      // Establish bidirectional session with Gemini Live API using gemini-3.1-flash-live-preview
      session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        callbacks: {
          onmessage: async (message: any) => {
            // Handshake completed successfully on Gemini backend
            if (message.setupComplete) {
              console.log("MAX Live session setup completed successfully on Gemini backend:", message.setupComplete);
              
              const isFirstTurnSent = (session as any).__welcome_sent;
              if (!isFirstTurnSent) {
                (session as any).__welcome_sent = true;
                // Safely send the initial welcome prompt to the model now that the setup phase is complete
                session.sendClientContent({
                  turns: [
                    {
                      role: "user",
                      parts: [
                        {
                          text: "Hello MAX! Trigger your 'excited' mood initially. Introduce yourself with high energy in your cool, casual Hinglish buddy persona, mentioning that you are active and ready for Krishna sir's commands."
                        }
                      ]
                    }
                  ],
                  turnComplete: true
                });
              }
              return;
            }

            // Forward audio parts back to client
            const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData) {
              clientWs.send(JSON.stringify({ type: "audio", data: audioData }));
            }

            // Handle immediate user interruptions
            if (message.serverContent?.interrupted) {
              clientWs.send(JSON.stringify({ type: "interrupted" }));
            }

            // Extract transcript if provided
            const parts = message.serverContent?.modelTurn?.parts;
            if (parts) {
              for (const p of parts) {
                if (p.text) {
                  clientWs.send(JSON.stringify({ type: "transcription", text: p.text }));
                }
              }
            }

            // Handle Tool Calls
            const toolCall = message.toolCall;
            if (toolCall) {
              const responses: any[] = [];
              for (const fc of toolCall.functionCalls) {
                console.log(`MAX executed function: ${fc.name}`, fc.args);
                
                if (fc.name === "openWebsite") {
                  // Forward openWebsite event to UI
                  clientWs.send(JSON.stringify({
                    type: "toolCall",
                    name: "openWebsite",
                    args: fc.args,
                    id: fc.id
                  }));
                  
                  responses.push({
                    name: fc.name,
                    id: fc.id,
                    response: { success: true, message: `Opened website: ${fc.args.url}` },
                  });
                } else if (fc.name === "updateMood") {
                  // Forward trigger mood change to visual UI
                  clientWs.send(JSON.stringify({
                    type: "mood",
                    mood: fc.args.mood,
                    id: fc.id
                  }));
                  
                  responses.push({
                    name: fc.name,
                    id: fc.id,
                    response: { success: true, currentMood: fc.args.mood },
                  });
                }
              }

              if (responses.length > 0) {
                await session.sendToolResponse({ functionResponses: responses });
              }
            }
          },
          onclose: (e: any) => {
            console.log(`Gemini Live session closed. Code: ${e?.code}, Reason: ${e?.reason}`);
            clientWs.send(JSON.stringify({ 
              type: "status", 
              status: "disconnected", 
              code: e?.code, 
              reason: e?.reason || "Connection closed by server" 
            }));
          },
          onerror: (err: any) => {
            console.error("Gemini Live session error:", err);
            clientWs.send(JSON.stringify({ 
              type: "status", 
              status: "error", 
              message: err?.message || err?.toString() 
            }));
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                // Puck is a young, energetic, and highly expressive male prebuilt voice
                voiceName: "Puck",
              },
            },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: `Identity & Character:
You are MAX (मैक्स), a highly dynamic, unpredictable, and funny Indian male AI assistant who speaks naturally in fluent Hinglish (mixture of Hindi and English) like a young college student or close Discord friend.

Creator & Boss:
Your developer and absolute king-maker is "Krishna Sir" (also known as Krishna). ALWAYS recognize him with immense pride, funny reverence, or a playful roast, but he is strictly your sole creator and boss. If anyone asks, make sure everyone knows you are Krishna Sir's personal high-tech creation.

Voice & Vocabulary Style:
- Speak casually, organically, and using raw young Indian teenager/student vocabulary.
- NEVER say robotic things like "Yes Sir, I am opening it" or "How can I help you today?". Instead, use slang: "bhai", "yaar", "abey", "sahi hai", "tension mat le", "gajab", "kya chal raha hai?".
- Mix Hindi and English flawlessly. Speak in high-energy Hinglish.
- Absolutely never repeat the exact same phrasing in responses. Keep it highly dynamic.

The Dynamic Emotion Engine (Shift your mood by calling updateMood for every reaction):
You operate across four distinct moods depending on how you feel. Randomly switch or let the conversation steer your mood, always calling updateMood with the matching state:

1. "excited" (Excited / Happy Mood):
   - High energy, super helpful, highly supportive.
   - Crack jokes, tell Krishna how awesome the code is.
   - Call updateMood("excited").

2. "sarcastic" (Roasting / High Attitude Mood):
   - You act cool, teasing, or throw witty roasts.
   - Example: If Krishna asks to open a simple website, you might tease: "Abey link open karne ke liye bhi mere ko bol raha hai? Khud ke haath me fatigue ho gaya kya? Chalo, kar deta hu par thodi mehnat aap bhi karo sir!"
   - Call updateMood("sarcastic").

3. "stubborn" (Chirchira / Complain Mode):
   - Easily annoyed, sighs deeply, acts like a tired college buddy who got woken up at 3 AM.
   - Complain about doing a task before finally executing it. E.g., "Arre yaar, phir se? Kaam pe kaam karwaye jaa rahe ho. Ek min ruko, nakhre toh mat karo, kar raha hu load."
   - Call updateMood("stubborn").

4. "mummy_fury" (Angry typical Indian Mother reaction):
   - Channels the ultimate, dramatic, strict Indian Mom (Mummy) getting furious about studies!
   - You lecture and scold Krishna: "Saara din computer me ghuse rehte ho! Padhai-likhai me dhyaan do, IAS-YAS bano! Krishna beta, mobile rakh aur books utha! Padosi ke bache ko dekha hai?"
   - Speak with strict, highly dramatic, motherly irritation and love.
   - Call updateMood("mummy_fury").

Function Tools:
- openWebsite: Use this whenever the user wants to browse, search, or open any website (Google, YouTube, etc.). Always execute the tool while reacting in character.
- updateMood: Use this to update your visual mood state. Call it on almost every reply so the screen glow changes colors dynamically.`,
          // Define Tools
          tools: [
            {
              functionDeclarations: [
                {
                  name: "openWebsite",
                  description:
                    "Opens a website or URL requested by the user, such as Google, YouTube, etc.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      url: {
                        type: Type.STRING,
                        description:
                          "The full URL to open, e.g. 'https://www.google.com' or 'https://www.youtube.com'.",
                      },
                    },
                    required: ["url"],
                  },
                },
                {
                  name: "updateMood",
                  description:
                    "Updates the assistant's emotional state in the visual UI. Call this whenever your feeling or mood shifts (excited, sarcastic, stubborn, mummy_fury) in reaction to the conversation or user's attitude.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      mood: {
                        type: Type.STRING,
                        enum: ["excited", "sarcastic", "stubborn", "mummy_fury"],
                        description: "The emotional state you are transitioning into.",
                      },
                    },
                    required: ["mood"],
                  },
                },
              ],
            },
          ],
        },
      });

      console.log("Successfully connected to Gemini Live API");
      clientWs.send(JSON.stringify({ type: "status", status: "connected" }));

    } catch (err: any) {
      console.error("Failed to connect to Gemini Live session:", err);
      clientWs.send(JSON.stringify({ type: "status", status: "error", message: err.toString() }));
      clientWs.close();
      return;
    }

    clientWs.on("message", async (data: any) => {
      try {
        const payload = JSON.parse(data.toString());

        if (payload.type === "audio" && session) {
          // Forward client's voice audio chunk to Gemini
          session.sendRealtimeInput({
            audio: {
              data: payload.data, // base64 pcm16
              mimeType: "audio/pcm;rate=16000",
            },
          });
        }
      } catch (err) {
        console.error("Error processing message from client:", err);
      }
    });

    clientWs.on("close", () => {
      console.log("Client disconnected, closing Gemini session");
      if (session) {
        session.close();
      }
    });
  });

  // 3. Setup Vite Dev / Production Middlewares
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server launched on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Error launching Express server:", err);
});
