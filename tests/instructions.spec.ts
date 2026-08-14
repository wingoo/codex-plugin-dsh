import { describe, expect, it } from 'vitest'
import { CODEX_APP_SERVER_DEVELOPER_INSTRUCTIONS } from '../src/adapter.ts'

describe('Codex App Server developer instructions', () => {
  it('keeps DSH skill loading separate from Codex image generation', () => {
    expect(CODEX_APP_SERVER_DEVELOPER_INSTRUCTIONS).toContain(
      'The dsh skill tool loads only names listed in the DSH <available_skills> catalog',
    )
    expect(CODEX_APP_SERVER_DEVELOPER_INSTRUCTIONS).toContain(
      'never call the dsh skill tool with the name imagegen',
    )
  })
})
