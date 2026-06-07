import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  Heart, 
  Volume2, 
  VolumeX, 
  Power, 
  Sparkles, 
  X, 
  ExternalLink, 
  Compass, 
  AlertCircle, 
  Clock 
} from "lucide-react";
import { MayraMood, ConnectionStatus } from "./types";
import AuraGlow from "./components/AuraGlow";
import MayraOrb from "./components/MayraOrb";

export default function App() {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [mood, setMood] = useState<MayraMood>("excited");
  const [isMuted, setIsMuted] = useState(false);
  const [transcript, setTranscript] = useState<string>("");
  const [systemMessage, setSystemMessage] = useState<string>("");
  const [openUrl, setOpenUrl] = useState<string | null>(null);

  // Real-time voice amplitude state fed into Orb
  const [voiceVolume, setVoiceVolume] = useState<number>(0);

  // Audio recording & playback context refs to prevent React state re-render lags
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const speakerAnalyserRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micProcessorRef = useRef<ScriptProcessorNode | null>(null);

  // Gapless audio playback scheduling refs
  const nextPlayTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const isMutedRef = useRef<boolean>(false);

  // Subtitle timeout ref to clear text after Mayra stops speaking
  const subtitleTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Sync isMuted state to ref for callback context accessibility
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  // Clean-up refs on unmount
  useEffect(() => {
    return () => {
      terminateAudioSession();
    };
  }, []);

  // Helper converter: convert float32 to PCM 16-bit
  const convertFloat32ToPCM16 = (buffer: Float32Array): ArrayBuffer => {
    const arrBuffer = new ArrayBuffer(buffer.length * 2);
    const view = new DataView(arrBuffer);
    for (let i = 0; i < buffer.length; i++) {
      const s = Math.max(-1, Math.min(1, buffer[i]));
      const val = s < 0 ? s * 0x8000 : s * 0x7fff;
      view.setInt16(i * 2, val, true);
    }
    return arrBuffer;
  };

  // Helper resampler downsampling from device rate (usually 44.1k/48k) to 16kHz
  const downsampleBuffer = (
    buffer: Float32Array,
    inputRate: number,
    outputRate: number = 16000
  ): Float32Array => {
    if (outputRate === inputRate) return buffer;
    const ratio = inputRate / outputRate;
    const length = Math.round(buffer.length / ratio);
    const result = new Float32Array(length);
    let offsetResult = 0;
    let offsetInput = 0;
    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetInput; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetInput = nextOffsetBuffer;
    }
    return result;
  };

  // Helper converter: base64 back to PCM Uint8 and decode Float32 for playback
  const convertPCM16ToFloat32 = (pcm16Bytes: Uint8Array): Float32Array => {
    const int16 = new Int16Array(pcm16Bytes.buffer, pcm16Bytes.byteOffset, pcm16Bytes.byteLength / 2);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / (int16[i] < 0 ? 32768 : 32767);
    }
    return float32;
  };

  // Trigger immediate voice interruption & clear playing audio queue
  const handleImmediateInterruption = () => {
    console.log("MAX interrupted! Clearing all voice buffers.");
    activeSourcesRef.current.forEach((src) => {
      try {
        src.stop();
      } catch (e) {
        // Source already completed or not started
      }
    });
    activeSourcesRef.current = [];
    nextPlayTimeRef.current = 0;
    setVoiceVolume(0);
  };

  const playVoiceChunk = (base64PCM: string) => {
    // Skip audio playback if client is muted
    if (isMutedRef.current) return;

    const audioCtx = audioCtxRef.current;
    if (!audioCtx) return;

    // Convert Base64 to ArrayBuffer bytes
    const rawBinary = atob(base64PCM);
    const bytes = new Uint8Array(rawBinary.length);
    for (let i = 0; i < rawBinary.length; i++) {
      bytes[i] = rawBinary.charCodeAt(i);
    }

    const float32Data = convertPCM16ToFloat32(bytes);
    
    // Create new buffer at 24000Hz output (Multimodal Live API default speaker rate)
    const buffer = audioCtx.createBuffer(1, float32Data.length, 24000);
    buffer.copyToChannel(float32Data, 0, 0);

    const sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = buffer;

    // Hook Analyser to extract real-time model output speaking volume
    if (speakerAnalyserRef.current) {
      sourceNode.connect(speakerAnalyserRef.current);
    } else {
      sourceNode.connect(audioCtx.destination);
    }

    // Schedule gapless playback
    const currentTime = audioCtx.currentTime;
    if (nextPlayTimeRef.current < currentTime) {
      // Small safety latency spacer for network packets
      nextPlayTimeRef.current = currentTime + 0.04;
    }

    sourceNode.start(nextPlayTimeRef.current);
    nextPlayTimeRef.current += buffer.duration;

    // Track active sources to enable real-time speaker interruption
    activeSourcesRef.current.push(sourceNode);
    sourceNode.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter((item) => item !== sourceNode);
    };

    setStatus("speaking");
  };

  // Initialize Mic stream capture and connection to Socket Server
  const startMayraSession = async () => {
    if (status !== "disconnected") return;

    setStatus("connecting");
    setSystemMessage("Establishing voice uplink to MAX...");
    
    try {
      // 1. Initialize AudioContext
      const AudioCtxConstructor = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioCtxConstructor();
      audioCtxRef.current = audioCtx;

      // 2. Request mic permission
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = micStream;

      // 3. Create Web Audio Nodes
      const micSource = audioCtx.createMediaStreamSource(micStream);
      
      const micAnalyser = audioCtx.createAnalyser();
      micAnalyser.fftSize = 64;
      micAnalyserRef.current = micAnalyser;
      micSource.connect(micAnalyser);

      const speakerAnalyser = audioCtx.createAnalyser();
      speakerAnalyser.fftSize = 64;
      speakerAnalyser.connect(audioCtx.destination);
      speakerAnalyserRef.current = speakerAnalyser;

      // Create legacy buffer reader processor node (16384 for stability, 1 channel)
      const bufferSize = 4096;
      const processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
      micProcessorRef.current = processor;
      micSource.connect(processor);
      
      // Must connect legacy processors to destination to trigger events
      processor.connect(audioCtx.destination);

      // 4. WebSocket setup
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws/live`;
      console.log("Connecting WebSocket down-channel:", wsUrl);
      
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      // Periodically probe amplitude for visuals
      const amplitudeCheckInterval = setInterval(() => {
        if (!audioCtxRef.current) {
          clearInterval(amplitudeCheckInterval);
          return;
        }

        // speaking visualizer mapping
        if (activeSourcesRef.current.length > 0 && speakerAnalyserRef.current) {
          const dataArray = new Uint8Array(speakerAnalyserRef.current.frequencyBinCount);
          speakerAnalyserRef.current.getByteFrequencyData(dataArray);
          const sum = dataArray.reduce((src, val) => src + val, 0);
          const avg = sum / dataArray.length;
          setVoiceVolume(Math.min(1, avg / 120)); // scale
        } 
        // listening visualizer mapping
        else if (status === "listening" && micAnalyserRef.current) {
          const dataArray = new Uint8Array(micAnalyserRef.current.frequencyBinCount);
          micAnalyserRef.current.getByteFrequencyData(dataArray);
          const sum = dataArray.reduce((src, val) => src + val, 0);
          const avg = sum / dataArray.length;
          setVoiceVolume(Math.min(1, avg / 100)); // scale
        } else {
          setVoiceVolume(0);
        }
      }, 50);

      // Handle raw mic recording buffers converting float32 blocks on-the-fly
      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (isMutedRef.current) return;

        const inputChannelData = e.inputBuffer.getChannelData(0);
        const deviceRate = audioCtx.sampleRate;
        
        // 16kHz PCM downsampler
        const downsampled = downsampleBuffer(inputChannelData, deviceRate, 16000);
        const pcm16Buffer = convertFloat32ToPCM16(downsampled);

        // Convert bytearray buffer chunk to Base64
        const uint8 = new Uint8Array(pcm16Buffer);
        let binaryStr = "";
        for (let i = 0; i < uint8.length; i++) {
          binaryStr += String.fromCharCode(uint8[i]);
        }
        const base64PCM = btoa(binaryStr);

        // Pipe to secure backend live API proxy
        ws.send(JSON.stringify({ type: "audio", data: base64PCM }));
      };

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);

        if (message.type === "status") {
          setStatus(message.status);
          if (message.status === "connected") {
            setSystemMessage("Connected with MAX.");
            setStatus("listening");
          } else if (message.status === "connecting") {
            setSystemMessage("Coupling holographic gateway...");
          } else if (message.status === "error") {
            setSystemMessage(`Connection failed: ${message.message}`);
            setStatus("error");
          } else if (message.status === "disconnected") {
            if (message.reason) {
              setSystemMessage(`Offline: ${message.reason} (Code: ${message.code || 'unknown'})`);
            } else {
              setSystemMessage("Session ended.");
            }
          }
        }

        else if (message.type === "audio") {
          playVoiceChunk(message.data);
        }

        else if (message.type === "interrupted") {
          handleImmediateInterruption();
          setStatus("listening");
        }

        else if (message.type === "transcription") {
          // Clear any pending subtitle clear triggers
          if (subtitleTimeoutRef.current) {
            clearTimeout(subtitleTimeoutRef.current);
          }

          // Output spoken feedback
          setTranscript((prev) => {
            const joined = prev ? (prev + " " + message.text) : message.text;
            // Cap subtitle length to prevent wall of text
            return joined.slice(-180);
          });

          // Trigger fading subtitles when speaking completes
          subtitleTimeoutRef.current = setTimeout(() => {
            setTranscript("");
          }, 4500);
        }

        else if (message.type === "mood") {
          console.log(`Mood transitioned: ${message.mood}`);
          setMood(message.mood);
        }

        else if (message.type === "toolCall") {
          if (message.name === "openWebsite" && message.args?.url) {
            console.log("MAX requested displaying URL in drawer frame:", message.args.url);
            setOpenUrl(message.args.url);
          }
        }
      };

      ws.onerror = (err) => {
        console.error("Hologram Socket Error:", err);
        setSystemMessage("Secure link offline.");
        setStatus("error");
      };

      ws.onclose = () => {
        console.log("WebSocket connection closed by proxy deck.");
        setStatus("disconnected");
        setSystemMessage("Session ended.");
        terminateAudioSession();
      };

    } catch (e: any) {
      console.error("Audio recording initialize block failed:", e);
      setSystemMessage(`Mic initialization failed: ${e.message}`);
      setStatus("error");
    }
  };

  const terminateAudioSession = () => {
    // 1. Close Web Socket
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.close();
      }
      wsRef.current = null;
    }

    // 2. Shut off Mic MediaStream track readers
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop());
      micStreamRef.current = null;
    }

    // 3. Clear ScriptProcessors
    if (micProcessorRef.current) {
      micProcessorRef.current.disconnect();
      micProcessorRef.current = null;
    }

    // 4. Close AudioContext
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }

    // 5. Clean scheduled source lists
    activeSourcesRef.current = [];
    nextPlayTimeRef.current = 0;
    setVoiceVolume(0);
    setTranscript("");
    setStatus("disconnected");
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
  };

  return (
    <main className="relative min-h-screen w-full flex flex-col justify-between bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-950 via-zinc-950 to-neutral-950 text-neutral-100 font-sans p-6 overflow-hidden select-none">
      
      {/* 3D Radiant Ambient Glow */}
      <AuraGlow mood={mood} />

      {/* Decorative High-Contrast Grid Backdrop */}
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff03_1px,transparent_1px),linear-gradient(to_bottom,#ffffff03_1px,transparent_1px)] bg-[size:32px_32px] pointer-events-none z-0" />

      {/* HEADER BAR */}
      <header className="relative w-full flex items-center justify-between pointer-events-auto z-20">
        <div className="flex items-center gap-3">
          <div className="relative">
            <span className={`block w-2.5 h-2.5 rounded-full ${
              status === "listening" ? "bg-green-400 animate-pulse" :
              status === "speaking" ? "bg-cyan-400 animate-pulse" :
              status === "connecting" ? "bg-amber-400 animate-bounce" :
              status === "error" ? "bg-red-500" : "bg-neutral-600"
            }`} />
            {status !== "disconnected" && status !== "error" && (
              <span className="absolute -inset-0.5 rounded-full bg-current opacity-75 animate-ping" />
            )}
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-wide text-neutral-100 uppercase">
              MAX Live <span className="text-cyan-400 lowercase font-mono text-xs">v3.1-live</span>
            </h1>
            <p className="text-[10px] text-neutral-400 font-mono tracking-wider">
              {status === "disconnected" ? "CHANNELS OFFLINE" : status.toUpperCase()}
            </p>
          </div>
        </div>

        {/* Dynamic Vibe / Mood Badge Indicator */}
        <AnimatePresence mode="wait">
          <motion.div
            key={mood}
            initial={{ y: -10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 10, opacity: 0 }}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium font-mono border backdrop-blur-md ${
              mood === "excited" 
                ? "bg-cyan-500/10 text-cyan-300 border-cyan-500/20" 
                : mood === "sarcastic"
                ? "bg-lime-500/10 text-lime-300 border-lime-500/25"
                : mood === "stubborn"
                ? "bg-amber-500/10 text-amber-300 border-amber-500/25"
                : "bg-red-500/10 text-red-400 border-red-500/30 animate-pulse"
            }`}
          >
            <Heart className={`w-3 h-3 ${mood === "mummy_fury" ? "fill-red-400 text-red-500 animate-ping" : "fill-current text-current"}`} />
            {mood === "excited" && "Happy & Excited"}
            {mood === "sarcastic" && "Sarcastic / Roast"}
            {mood === "stubborn" && "Stubborn / Complaints"}
            {mood === "mummy_fury" && "Mummy Anger Mode 😤"}
          </motion.div>
        </AnimatePresence>
      </header>

      {/* CENTRAL CORE ENGINE AND LOGIC */}
      <section className="relative flex-1 flex flex-col items-center justify-center z-10 w-full max-w-lg mx-auto">
        <div id="mayra_orb_viewport" className="relative flex flex-col items-center justify-center cursor-pointer">
          <MayraOrb mood={mood} status={status} volume={voiceVolume} />

          {/* Connection Trigger Splash when Offline */}
          <AnimatePresence>
            {status === "disconnected" && (
              <motion.button
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={startMayraSession}
                id="ignition_start_button"
                className="absolute flex flex-col items-center justify-center gap-2 px-6 py-4 rounded-2xl bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/35 shadow-[0_0_30px_rgba(6,182,212,0.15)] backdrop-blur-xl transition-all"
              >
                <Power className="w-8 h-8 text-cyan-400 animate-pulse" />
                <span className="text-sm font-semibold tracking-widest uppercase text-cyan-300">
                  Wake Up MAX
                </span>
                <span className="text-[10px] text-neutral-400 font-mono">
                  TAP TO UPLINK
                </span>
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {/* Dynamic Telemetry Status line */}
        <div className="text-center mt-4 min-h-[20px] max-w-sm">
          {systemMessage && (
            <p className="text-xs font-mono text-neutral-400 tracking-wide animate-fade-in flex items-center justify-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              {systemMessage}
            </p>
          )}

          {mood === "mummy_fury" && (
            <p className="text-xs font-mono text-red-400 mt-2 tracking-wide font-semibold">
              ⚠️ Warning: MAX is channeling Krishna's angry Indian mother! Study call active.
            </p>
          )}
        </div>
      </section>

      {/* LOWER DECK - SUBTITLES & CONTROLS */}
      <footer className="relative w-full max-w-xl mx-auto flex flex-col items-center gap-6 z-20 pointer-events-auto">
        
        {/* Sleek Subtitle Banner (No history text logs, pure real-time sensory overlays) */}
        <div className="w-full min-h-[48px] max-h-[80px] flex items-center justify-center overflow-hidden">
          <AnimatePresence mode="wait">
            {transcript && (
              <motion.div
                key={transcript}
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -15 }}
                className="text-center bg-black/40 border border-neutral-800/50 backdrop-blur-md px-5 py-2.5 rounded-xl rounded-b-none border-b-2 border-b-cyan-500/40 text-sm sm:text-base text-neutral-100 max-w-md shadow-2xl tracking-wide leading-relaxed font-sans"
              >
                {transcript}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Operational buttons Bar */}
        <div className="flex items-center justify-center gap-5 pb-4">
          
          {/* Mute toggle button */}
          <button
            onClick={toggleMute}
            disabled={status === "disconnected"}
            className={`p-4 rounded-full border transition-all ${
              isMuted 
                ? "bg-red-500/20 text-red-400 border-red-500/40 shadow-lg" 
                : "bg-neutral-900 hover:bg-neutral-800 text-neutral-400 hover:text-neutral-100 border-neutral-800 disabled:opacity-30 disabled:pointer-events-none"
            }`}
            title={isMuted ? "Unmute Microphone" : "Mute Microphone"}
          >
            {isMuted ? <VolumeX className="w-5.5 h-5.5" /> : <Volume2 className="w-5.5 h-5.5" />}
          </button>

          {/* Core disconnection toggle button */}
          <button
            onClick={status !== "disconnected" ? terminateAudioSession : startMayraSession}
            id="session_toggle_button"
            className={`p-5 rounded-full transition-all duration-300 transform hover:scale-105 ${
              status !== "disconnected"
                ? "bg-red-600 hover:bg-red-500 text-white shadow-[0_0_20px_rgba(220,38,38,0.4)]"
                : "bg-cyan-500 hover:bg-cyan-400 text-neutral-950 shadow-[0_0_25px_rgba(6,182,212,0.3)]"
            }`}
          >
            <Power className="w-6 h-6 shrink-0" />
          </button>

          {/* Compass Decorative Panel of Origin */}
          <button
            onClick={() => {
              setSystemMessage("Created with devotion by Krishna Sir for Google AI Studio.");
              setTimeout(() => setSystemMessage(""), 4000);
            }}
            className="p-4 rounded-full bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 text-neutral-400 hover:text-neutral-100 transition-all"
            title="Assitstance Intelligence Origin Specs"
          >
            <Compass className="w-5.5 h-5.5" />
          </button>
        </div>

        {/* Humanized Humble Attribution footer */}
        <div className="flex items-center gap-1.5 text-[10px] text-neutral-500 font-mono tracking-widest uppercase">
          <span>CREATOR: KRISHNA SIR</span>
          <span className="text-cyan-500/40">•</span>
          <span>DEDICATED CYBER INTERFACE</span>
        </div>
      </footer>

      {/* FLOATING DRAWERS - SEAMLESS WEBSITE BROWSER COMPONENT */}
      <AnimatePresence>
        {openUrl && (
          <motion.div
            initial={{ opacity: 0, y: "100%" }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 180 }}
            className="absolute bottom-0 inset-x-0 h-[85vh] bg-zinc-950 rounded-t-3xl border-t border-neutral-800 shadow-[0_-20px_50px_rgba(0,0,0,0.8)] z-50 flex flex-col pointer-events-auto"
          >
            {/* Slide Bar Header */}
            <div className="flex items-center justify-between px-6 py-4.5 border-b border-neutral-900 bg-zinc-900/60 rounded-t-3xl">
              <div className="flex items-center gap-2 max-w-[70%]">
                <span className="flex w-2.5 h-2.5 rounded-full bg-cyan-500 animate-pulse" />
                <span className="text-xs font-mono font-semibold tracking-wide uppercase text-cyan-400">
                  Portal Link:
                </span>
                <span className="text-xs font-mono text-neutral-400 truncate tracking-wide">
                  {openUrl}
                </span>
              </div>
              
              <div className="flex items-center gap-3">
                <a 
                  href={openUrl} 
                  target="_blank" 
                  rel="noreferrer"
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20 text-cyan-300 text-xs transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Open in Tab</span>
                </a>
                <button
                  onClick={() => setOpenUrl(null)}
                  className="p-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-neutral-100 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Sandbox Iframe Port or Fallback Panel */}
            <div className="flex-1 w-full bg-zinc-950 relative">
              <iframe
                src={openUrl}
                title="MAX Opened Portal Website"
                className="w-full h-full border-0 rounded-b-xl"
                sandbox="allow-scripts allow-same-origin allow-popups allowance-forms"
              />
              {/* Overlapping Info bubble in case some secure websites block frames */}
              <div className="absolute bottom-4 left-4 right-4 bg-zinc-900/90 border border-neutral-800/60 px-4 py-3 rounded-xl flex items-start gap-2.5 shadow-2xl pointer-events-auto max-w-md mx-auto">
                <AlertCircle className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-xs font-semibold text-neutral-100 tracking-wide">
                    Hologram IFrame restriction
                  </h4>
                  <p className="text-[10px] text-neutral-400 mt-1 leading-normal font-sans">
                    Some high-security websites (like Google, YouTube) restrict embedding inside apps. If the screen is blank, use the <strong className="text-cyan-300">"Open in Tab"</strong> button above to load it securely.
                  </p>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

    </main>
  );
}
