import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { MayraMood } from "../types";

interface AuraGlowProps {
  mood: MayraMood;
}

export default function AuraGlow({ mood }: AuraGlowProps) {
  const [colorClass, setColorClass] = useState("from-cyan-500/20 to-blue-400/5");

  useEffect(() => {
    switch (mood) {
      case "excited":
        setColorClass("from-cyan-500/25 via-blue-500/10 to-transparent");
        break;
      case "sarcastic":
        setColorClass("from-lime-500/20 via-emerald-600/5 to-transparent");
        break;
      case "stubborn":
        setColorClass("from-amber-600/20 via-orange-600/5 to-transparent");
        break;
      case "mummy_fury":
        setColorClass("from-red-600/35 via-rose-700/10 to-transparent");
        break;
      default:
        setColorClass("from-cyan-500/20 via-blue-400/5 to-transparent");
    }
  }, [mood]);

  const getDurationScale = () => {
    if (mood === "mummy_fury") return 1.5;
    if (mood === "sarcastic") return 3.2;
    if (mood === "stubborn") return 4.5;
    return 2.5; // excited / normal
  };

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none z-0 flex items-center justify-center">
      <AnimatePresence mode="wait">
        <motion.div
          key={mood}
          initial={{ opacity: 0, scale: 0.82 }}
          animate={{ 
            opacity: [0.35, 0.65, 0.35], 
            scale: [1, 1.12, 1],
          }}
          exit={{ opacity: 0, scale: 1.18 }}
          transition={{
            opacity: {
              repeat: Infinity,
              duration: getDurationScale(),
              ease: "easeInOut",
            },
            scale: {
              repeat: Infinity,
              duration: getDurationScale() * 1.25,
              ease: "easeInOut",
            }
          }}
          className={`absolute w-[200vw] h-[200vw] sm:w-[120vw] sm:h-[120vw] rounded-full bg-gradient-to-r ${colorClass} blur-3xl`}
        />
      </AnimatePresence>
    </div>
  );
}
