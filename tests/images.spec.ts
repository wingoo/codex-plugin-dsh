import {
  AttachmentId,
  type ImageAttachmentRef,
  type SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { describe, expect, it, vi } from 'vitest'
import { attachmentDataUrl, generatedImageBlock } from '../src/images.ts'

const imageRef: ImageAttachmentRef = {
  attachmentId: AttachmentId('image-1'),
  mediaType: 'image/png',
  bytes: 3,
  width: 1,
  height: 1,
  name: 'pixel.png',
}

describe('Codex image translation', () => {
  it('reads and inlines a verified DSH attachment', async () => {
    const signal = AbortSignal.timeout(1_000)
    const readImage = vi.fn(async () => ({ ref: imageRef, data: Uint8Array.from([1, 2, 3]) }))

    await expect(attachmentDataUrl({ readImage }, imageRef, signal)).resolves.toBe(
      'data:image/png;base64,AQID',
    )
    expect(readImage).toHaveBeenCalledWith(imageRef, signal)
  })

  it('persists completed App Server PNG output as a DSH image block', async () => {
    const saved: SaveImageAttachment[] = []
    const saveImage = vi.fn(async (input: SaveImageAttachment) => {
      saved.push(input)
      return imageRef
    })

    await expect(generatedImageBlock({ saveImage }, {
      type: 'imageGeneration',
      id: 'image-item-1',
      status: 'completed',
      result: 'AQID',
    })).resolves.toEqual({ type: 'image', attachment: imageRef })
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ mediaType: 'image/png', name: 'codex-generated.png' })
    expect([...saved[0]!.data]).toEqual([1, 2, 3])
  })

  it('ignores failed image-generation items', async () => {
    const saveImage = vi.fn()

    await expect(generatedImageBlock({ saveImage }, {
      type: 'imageGeneration',
      id: 'image-item-1',
      status: 'failed',
      result: 'AQID',
    })).resolves.toBeUndefined()
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('rejects malformed generated-image base64 before persistence', async () => {
    const saveImage = vi.fn()

    await expect(generatedImageBlock({ saveImage }, {
      type: 'imageGeneration',
      id: 'image-item-1',
      status: 'completed',
      result: 'not-base64!',
    })).rejects.toThrow('invalid generated-image base64')
    expect(saveImage).not.toHaveBeenCalled()
  })
})
