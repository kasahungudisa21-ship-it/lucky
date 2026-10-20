import type { CSSProperties } from "react";
import { ballTones } from "@/lib/ball";

/**
 * A drawn or held number, painted as a ball. `medal` replaces the number's own hue with the
 * gold/silver/bronze of the place it finished in.
 */
export function Ball({ n, medal, size }: { n: number; medal?: number; size?: "sm" | "lg" }) {
  const tone = ballTones(n);
  const cls = size === "lg" ? "ball ball--lg" : size === "sm" ? "ball ball--sm" : "ball";

  return (
    <span
      className={cls}
      data-medal={medal}
      style={{ "--ball": tone.solid, "--ball-soft": tone.soft } as CSSProperties}
    >
      {n}
    </span>
  );
}
