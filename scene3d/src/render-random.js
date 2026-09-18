// Presentation-only randomness. Never seed from, call, or replace the host Math.random.
// Not cryptographically secure; this sequence must never be used for game rules or secrets.
let state;
let calls = 0;
function seedFromCrypto() {
  const words = new Uint32Array(1);
  if (!globalThis.crypto?.getRandomValues) throw new Error('RENDER_RANDOM_CRYPTO_UNAVAILABLE');
  globalThis.crypto.getRandomValues(words);
  return words[0];
}
export function setRenderRandomSeed(seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new TypeError('Expected uint32 presentation seed');
  state = seed >>> 0; calls = 0;
}
export function renderRandom() {
  state ??= seedFromCrypto();
  state = (state + 0x6d2b79f5) >>> 0;
  let value = state;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  calls++;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}
export function getRenderRandomStats() { return Object.freeze({ calls }); }
// Layout owns a separate deterministic stream, independent of UUID/render call counts.
export function createLayoutRandom(layoutKey) {
  let seed = 2166136261;
  for (const character of String(layoutKey)) seed = Math.imul(seed ^ character.codePointAt(0), 16777619) >>> 0;
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let value = Math.imul(seed ^ (seed >>> 15), seed | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
