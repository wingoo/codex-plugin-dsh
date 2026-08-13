/** Image translation between durable DSH attachments and Codex App Server payloads. */

import type {
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'

/** Attachment operations required by the Codex image bridge. */
export interface CodexImageAttachments {
  /** Read and verify an existing durable image. */
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>
  /** Validate and persist a generated image. */
  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>
}

/** Convert a verified DSH image reference to an inline App Server image URL. */
export async function attachmentDataUrl(
  attachments: Pick<CodexImageAttachments, 'readImage'>,
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
): Promise<string> {
  const stored = await attachments.readImage(ref, signal)
  return `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
}

function decodePngBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string') {
    throw new Error('codex-plugin-dsh: completed App Server image generation has no base64 result')
  }
  const encoded = value.trim()
  const base64 = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !base64.test(encoded)) {
    throw new Error('codex-plugin-dsh: App Server returned invalid generated-image base64')
  }
  return Uint8Array.from(Buffer.from(encoded, 'base64'))
}

/** Persist one completed App Server image-generation item as a DSH image block. */
export async function generatedImageBlock(
  attachments: Pick<CodexImageAttachments, 'saveImage'>,
  item: Record<string, unknown>,
): Promise<ImageBlock | undefined> {
  if (item.status !== 'completed') return undefined
  const attachment = await attachments.saveImage({
    data: decodePngBase64(item.result),
    mediaType: 'image/png',
    name: 'codex-generated.png',
  })
  return { type: 'image', attachment }
}
