import type { ImageRef } from '@shared/protocol'
import type { DraftImage } from '@/components/composer/draft-images'

/** History keeps a picture as a URL; a send needs its bytes. */
export async function withBytes(img: ImageRef): Promise<ImageRef> {
  if (img.dataBase64 || !img.url) return { mediaType: img.mediaType, dataBase64: img.dataBase64, name: img.name }
  const res = await fetch(img.url)
  if (!res.ok) throw new Error(`a picture could not be loaded (${res.status})`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { mediaType: img.mediaType, dataBase64: btoa(bin), name: img.name }
}

/** The message's pictures as a box holds them. */
export async function boxImages(images: ImageRef[] = []): Promise<DraftImage[]> {
  const refs = images.length ? await Promise.all(images.map(withBytes)) : []
  return refs.flatMap(({ name, mediaType, dataBase64 }) =>
    dataBase64 ? [{ id: crypto.randomUUID(), name: name ?? 'Image', mediaType, dataBase64, url: `data:${mediaType};base64,${dataBase64}` }] : []
  )
}
