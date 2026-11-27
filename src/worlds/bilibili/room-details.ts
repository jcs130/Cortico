/** Public, plain-text presentation facts returned by Room/get_info. */
export interface LiveRoomDetails {
  title: string | null;
  description: string | null;
  category: string | null;
  observedAt: string;
}

const entity: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

function plain(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.slice(0, 12_000)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/gi, (_, name: string) => entity[name.toLowerCase()]!)
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
  return Array.from(cleaned).slice(0, limit).join('') || null;
}

export function readLiveRoomDetails(room: Record<string, unknown>, now = Date.now()): LiveRoomDetails | null {
  if (typeof room.title !== 'string' && typeof room.description !== 'string' && typeof room.area_name !== 'string') return null;
  return {
    title: plain(room.title, 160), description: plain(room.description, 480), category: plain(room.area_name, 48),
    observedAt: new Date(now).toISOString(),
  };
}
