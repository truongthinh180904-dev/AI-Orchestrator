/**
 * Dựng args cho agy: lọc -p/--print khỏi AGY_ARGS rồi thêm đúng một cặp `-p <prompt>` ở cuối.
 */
export function buildAgyArgs(agyArgs: string | undefined, prompt: string): string[] {
  const extra = (agyArgs ?? '')
    .split(/\s+/)
    .filter((a) => a.length > 0 && a !== '-p' && a !== '--print' && a !== '--prompt');
  return [...extra, '-p', prompt];
}
