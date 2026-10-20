// Twelve hues stepped around the wheel. A ball set in a real draw is never one colour, and
// spreading the hues this way means two neighbouring numbers on the board never match.
const PALETTE = [
  "#b8352c",
  "#d9761b",
  "#caa014",
  "#6b9a1e",
  "#1e9a63",
  "#0e8fa6",
  "#2f6fb5",
  "#5b52b8",
  "#8f45a8",
  "#b53f86",
  "#8a5a2b",
  "#5a6b8c",
];

export function ballTones(number: number): { solid: string; soft: string } {
  const solid = PALETTE[(number * 7) % PALETTE.length];
  // an unclaimed seat shows the same hue, only as a rim of light — the colour belongs to the
  // number, the finish belongs to the status
  return { solid, soft: `${solid}40` };
}
