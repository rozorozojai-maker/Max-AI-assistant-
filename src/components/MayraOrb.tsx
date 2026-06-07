import { useEffect, useRef } from "react";
import { MayraMood, ConnectionStatus } from "../types";

interface MayraOrbProps {
  mood: MayraMood;
  status: ConnectionStatus;
  volume: number; // Amplitude mapped between 0 and 1
}

export default function MayraOrb({ mood, status, volume }: MayraOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const timeRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Set high-DPI scaling
    const resizeCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    };

    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);

    // Dynamic wave equation drawing loop
    const render = () => {
      const width = canvas.width / (window.devicePixelRatio || 1);
      const height = canvas.height / (window.devicePixelRatio || 1);
      const centerX = width / 2;
      const centerY = height / 2;

      ctx.clearRect(0, 0, width, height);

      // 1. Advance time based on state
      let speed = 0.02;
      if (status === "listening") speed = 0.05 + volume * 0.05;
      if (status === "speaking") speed = 0.04 + volume * 0.08;
      timeRef.current += speed;
      const time = timeRef.current;

      // 2. Select visual themes/colors based on mood
      let glowColor = "rgba(6, 182, 212, 0.6)"; // Default Cyan
      let fillGradient: CanvasGradient;

      fillGradient = ctx.createRadialGradient(
        centerX,
        centerY,
        10,
        centerX,
        centerY,
        120 + volume * 20
      );

      if (mood === "excited") {
        glowColor = "rgba(6, 182, 212, 0.7)";
        fillGradient.addColorStop(0, "rgba(34, 211, 238, 0.8)"); // Cyan
        fillGradient.addColorStop(0.5, "rgba(59, 130, 246, 0.45)"); // Indigo/Blue
        fillGradient.addColorStop(1, "rgba(59, 130, 246, 0)");
      } else if (mood === "sarcastic") {
        glowColor = "rgba(132, 204, 22, 0.7)"; // Lime
        fillGradient.addColorStop(0, "rgba(163, 230, 53, 0.8)"); // Light Lime
        fillGradient.addColorStop(0.5, "rgba(16, 185, 129, 0.45)"); // Emerald
        fillGradient.addColorStop(1, "rgba(16, 185, 129, 0)");
      } else if (mood === "stubborn") {
        glowColor = "rgba(245, 158, 11, 0.7)"; // Amber
        fillGradient.addColorStop(0, "rgba(251, 191, 36, 0.8)"); // Amber 
        fillGradient.addColorStop(0.5, "rgba(249, 115, 22, 0.45)"); // Orange
        fillGradient.addColorStop(1, "rgba(249, 115, 22, 0)");
      } else if (mood === "mummy_fury") {
        glowColor = "rgba(239, 68, 68, 0.85)"; // Red
        fillGradient.addColorStop(0, "rgba(244, 63, 94, 0.85)"); // Rose
        fillGradient.addColorStop(0.5, "rgba(220, 38, 38, 0.4)"); // Crimson
        fillGradient.addColorStop(1, "rgba(220, 38, 38, 0)");
      }

      // 3. Render Aura Glow Blur layer in canvas (as fallback / enhancer)
      ctx.save();
      ctx.shadowBlur = 45 + volume * 35;
      ctx.shadowColor = glowColor;

      // Draw standard glowing visual core
      const getOrbStyleRadius = () => {
        const base = 70;
        if (status === "idle") {
          // Slow breathing
          return base + Math.sin(time * 1.5) * 4;
        }
        if (status === "listening") {
          // Active listening spikes
          return base + Math.cos(time * 3) * 2 + volume * 25;
        }
        if (status === "speaking") {
          // Heartbeat wave
          return base + volume * 45;
        }
        return base;
      };

      const coreRadius = getOrbStyleRadius();

      // Outer rings / liquid wave curves (multi-layered organic fluids)
      const layers = status === "speaking" ? 4 : status === "listening" ? 3 : 2;
      for (let layer = 0; layer < layers; layer++) {
        ctx.beginPath();
        const layerPhase = (layer * Math.PI) / 3;
        const radiusMultiplier = 1 + layer * 0.12;

        for (let angle = 0; angle <= Math.PI * 2 + 0.1; angle += 0.04) {
          // Beautiful fluid math calculations
          let wave1 = 0;
          let wave2 = 0;

          if (status === "idle") {
            wave1 = Math.sin(angle * 4 + time + layerPhase) * 4;
            wave2 = Math.cos(angle * 2 - time * 0.8) * 2;
          } else if (status === "listening") {
            // High frequency jagged ripples like mic input
            wave1 = Math.sin(angle * 8 + time * 2.5 + layerPhase) * (2 + volume * 15);
            wave2 = Math.cos(angle * 4 - time * 1.5) * (1 + volume * 8);
          } else if (status === "speaking") {
            // Fluid volumetric swelling Waves
            wave1 = Math.sin(angle * 3.5 + time * 2 + layerPhase) * (5 + volume * 35);
            wave2 = Math.cos(angle * 2 - time * 1.1) * (3 + volume * 18);
          }

          const r = coreRadius * radiusMultiplier + wave1 + wave2;
          const x = centerX + Math.cos(angle) * r;
          const y = centerY + Math.sin(angle) * r;

          if (angle === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }

        ctx.closePath();
        
        // Define stroke and translucent styles based on depth
        if (layer === 0) {
          ctx.fillStyle = fillGradient;
          ctx.fill();
        } else {
          ctx.strokeStyle = glowColor.replace("0.7", `${0.4 - layer * 0.08}`).replace("0.8", `${0.35 - layer * 0.08}`);
          ctx.lineWidth = status === "speaking" ? 2.5 : 1.5;
          ctx.stroke();
        }
      }

      // Draw highly expressive inner audio particle points for speaking/listening
      if (status === "listening" || status === "speaking") {
        const particlesCount = 8;
        for (let i = 0; i < particlesCount; i++) {
          const pAngle = (i * Math.PI * 2) / particlesCount + time * 0.5;
          const pDist = coreRadius * (0.45 + Math.sin(time + i) * 0.15) + (status === "speaking" ? volume * 20 : 0);
          const px = centerX + Math.cos(pAngle) * pDist;
          const py = centerY + Math.sin(pAngle) * pDist;
          ctx.beginPath();
          ctx.arc(px, py, 2.5 + (status === "speaking" ? volume * 4 : 0), 0, Math.PI * 2);
          ctx.fillStyle = mood === "mummy_fury" ? "rgba(254, 226, 226, 0.9)" : "rgba(255, 255, 255, 0.95)";
          ctx.fill();
        }
      }

      ctx.restore();

      animationFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      window.removeEventListener("resize", resizeCanvas);
    };
  }, [mood, status, volume]);

  return (
    <div id="mayra_core_orb_wrapper" className="relative w-72 h-72 sm:w-80 sm:h-80 mx-auto flex items-center justify-center z-10 select-none">
      <canvas
        ref={canvasRef}
        id="mayra_core_orb_canvas"
        className="w-full h-full"
        style={{ filter: "drop-shadow(0 0 15px rgba(6, 182, 212, 0.2))" }}
      />
    </div>
  );
}
