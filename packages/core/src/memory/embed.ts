export const EMBEDDING_DIM = 64

/**
 * Локальный детерминированный хэш-эмбеддинг через символьные 3-граммы.
 * Не требует внешних нейросетей или загрузки ONNX-моделей.
 * Возвращает квантованный L2-нормализованный Int8Array фиксированной длины 64.
 */
export function hashEmbed(text: string): Int8Array {
  const result = new Int8Array(EMBEDDING_DIM)
  if (!text || text.trim().length === 0) {
    return result
  }
  const normalized = "  " + text.toLowerCase().trim() + "  "
  if (normalized.length < 3) {
    return result
  }

  const floatVec = new Float32Array(EMBEDDING_DIM)
  for (let i = 0; i <= normalized.length - 3; i++) {
    const c0 = normalized.charCodeAt(i)
    const c1 = normalized.charCodeAt(i + 1)
    const c2 = normalized.charCodeAt(i + 2)

    // Быстрый FNV-1a хэш для триграммы символов
    let h = 0x811c9dc5
    h ^= c0
    h = Math.imul(h, 0x01000193)
    h ^= c1
    h = Math.imul(h, 0x01000193)
    h ^= c2
    h = Math.imul(h, 0x01000193)

    const bucket = (h >>> 0) % EMBEDDING_DIM
    const sign = ((h >>> 16) & 1) === 1 ? 1 : -1
    floatVec[bucket] += sign
  }

  let sumSq = 0
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    sumSq += floatVec[i] * floatVec[i]
  }
  const norm = Math.sqrt(sumSq)
  if (norm === 0) {
    return result
  }

  for (let i = 0; i < EMBEDDING_DIM; i++) {
    result[i] = Math.round((floatVec[i] / norm) * 127)
  }
  return result
}

/**
 * Косинусное сходство между двумя векторами (в диапазоне [0, 1]).
 */
export function cosineSimilarity(a: Int8Array | Uint8Array, b: Int8Array | Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let sumA = 0
  let sumB = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]
    const bi = b[i]
    dot += ai * bi
    sumA += ai * ai
    sumB += bi * bi
  }
  if (sumA === 0 || sumB === 0) return 0
  const sim = dot / (Math.sqrt(sumA) * Math.sqrt(sumB))
  return Math.max(0, sim)
}
