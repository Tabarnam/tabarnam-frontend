import { useMemo } from "react";
import { motion } from "framer-motion";

/**
 * A single digit drum/wheel. Shows digits 0-9 stacked vertically in a
 * clipped window; framer-motion animates translateY to scroll the target
 * digit into view — like a classic mechanical click counter.
 */
function TallyDigit({ digit, delay = 0 }) {
  const y = -(digit * 100); // percentage offset within the drum

  return (
    <div className="tally-digit-window">
      <motion.div
        className="tally-digit-drum"
        animate={{ y: `${y}%` }}
        transition={{
          type: "spring",
          stiffness: 80,
          damping: 14,
          delay,
        }}
      >
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
          <div key={d} className="tally-digit-face">
            {d}
          </div>
        ))}
      </motion.div>
    </div>
  );
}

/**
 * Mechanical tally counter / odometer display.
 * Digits roll from 0 to the target value on mount, and animate between
 * values when the count changes.
 *
 * @param {{ value: number | null, label?: string }} props
 */
export default function TallyCounter({ value, label = "Published" }) {
  const digits = useMemo(() => {
    if (value == null || value < 0) return [];
    const str = String(Math.floor(value)).padStart(4, "0");
    return str.split("").map(Number);
  }, [value]);

  if (value == null) return null;

  return (
    <div className="tally-counter-container">
      <div className="tally-counter-frame">
        {digits.map((d, i) => (
          <TallyDigit
            key={`pos-${digits.length - i}`}
            digit={d}
            delay={i * 0.08}
          />
        ))}
      </div>
      {label && <span className="tally-counter-label">{label}</span>}
    </div>
  );
}
