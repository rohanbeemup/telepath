import { test, expect, describe } from 'bun:test'
import { mediaKind, fallsBackToDocument, inboundMediaNotice, inboundFileName, MAX_DOWNLOAD_BYTES, type InboundKind } from './media'

describe('mediaKind (outbound routing)', () => {
  test('images route to image', () => {
    for (const p of ['a.png', 'b.jpg', 'c.jpeg', 'd.JPG', 'e.webp', 'f.bmp']) {
      expect(mediaKind(p)).toBe('image')
    }
  })

  test('videos route to video', () => {
    for (const p of ['a.mp4', 'b.MOV', 'c.mov', 'd.m4v', 'e.webm', 'f.mkv']) {
      expect(mediaKind(p)).toBe('video')
    }
  })

  test('gif routes to animation, not image (precedence over the image regex)', () => {
    expect(mediaKind('loop.gif')).toBe('animation')
    expect(mediaKind('LOOP.GIF')).toBe('animation')
  })

  test('audio routes to audio', () => {
    for (const p of ['a.mp3', 'b.m4a', 'c.aac', 'd.flac', 'e.wav', 'f.ogg', 'g.oga', 'h.opus', 'i.weba']) {
      expect(mediaKind(p)).toBe('audio')
    }
  })

  test('everything else routes to document', () => {
    for (const p of ['a.pdf', 'b.txt', 'c.zip', 'd.bin', 'e.json', 'README', 'notes.md']) {
      expect(mediaKind(p)).toBe('document')
    }
  })

  test('only the final extension decides', () => {
    expect(mediaKind('clip.final.mp4')).toBe('video')
    expect(mediaKind('archive.mp4.zip')).toBe('document')
    expect(mediaKind('/abs/path/to/shot.PNG')).toBe('image')
  })
})

describe('inboundMediaNotice', () => {
  const kinds: InboundKind[] = ['video', 'animation', 'video_note', 'voice', 'audio']

  test('every kind returns an ack and a prompt that carries the saved path', () => {
    for (const k of kinds) {
      const n = inboundMediaNotice(k, { path: `/inbox/${k}.file` })
      expect(n.ack.length).toBeGreaterThan(0)
      expect(n.prompt).toContain(`/inbox/${k}.file`)
    }
  })

  test('video: names the medium, carries metadata, hints at frame extraction', () => {
    const n = inboundMediaNotice('video', { path: '/inbox/v.mp4', mime: 'video/mp4', duration: 12 })
    expect(n.ack.toLowerCase()).toContain('video')
    expect(n.prompt).toContain('/inbox/v.mp4')
    expect(n.prompt).toContain('video/mp4')
    expect(n.prompt).toContain('12s')
    expect(n.prompt.toLowerCase()).toContain('frame')
  })

  test('voice: hints at transcription and treating the transcript as the message', () => {
    const n = inboundMediaNotice('voice', { path: '/inbox/v.ogg', duration: 5 })
    expect(n.ack.toLowerCase()).toContain('voice')
    expect(n.prompt.toLowerCase()).toContain('transcrib')
    expect(n.prompt).toContain('/inbox/v.ogg')
    expect(n.prompt).toContain('5s')
  })

  test('audio: includes the file name when present and hints at transcription', () => {
    const n = inboundMediaNotice('audio', { path: '/inbox/song.mp3', name: 'song.mp3', mime: 'audio/mpeg' })
    expect(n.ack.toLowerCase()).toContain('audio')
    expect(n.prompt).toContain('song.mp3')
    expect(n.prompt.toLowerCase()).toContain('transcrib')
  })

  test('animation: names a GIF and hints at reading a frame', () => {
    const n = inboundMediaNotice('animation', { path: '/inbox/a.mp4' })
    expect(n.ack).toContain('GIF')
    expect(n.prompt.toLowerCase()).toContain('frame')
  })

  test('video_note: names it a note', () => {
    const n = inboundMediaNotice('video_note', { path: '/inbox/n.mp4', duration: 8 })
    expect(n.ack.toLowerCase()).toContain('note')
    expect(n.prompt).toContain('8s')
  })

  test('a caption is passed through to the prompt', () => {
    const n = inboundMediaNotice('video', { path: '/inbox/v.mp4', caption: 'watch this' })
    expect(n.prompt).toContain('watch this')
    expect(n.prompt).toContain('Caption')
  })

  test('no metadata: prompt still well-formed, no empty parens or stray markers', () => {
    const n = inboundMediaNotice('video', { path: '/inbox/v.mp4' })
    expect(n.prompt).toContain('/inbox/v.mp4')
    expect(n.prompt).not.toContain('()')
    expect(n.prompt).not.toContain('undefined')
  })
})

describe('fallsBackToDocument (recover from a rejected typed send)', () => {
  test('typed inline sends fall back so a rejected format is still delivered', () => {
    // Telegram documents MP3/M4A for sendAudio and MPEG4 for sendVideo; other formats
    // (wav/flac/ogg, mkv/mov/webm) may be rejected and must not get stuck in the outbox.
    expect(fallsBackToDocument('video')).toBe(true)
    expect(fallsBackToDocument('animation')).toBe(true)
    expect(fallsBackToDocument('audio')).toBe(true)
  })

  test('image keeps its existing behaviour and document is already the fallback', () => {
    expect(fallsBackToDocument('image')).toBe(false)
    expect(fallsBackToDocument('document')).toBe(false)
  })
})

describe('inboundFileName', () => {
  test('a Telegram-supplied file name is used verbatim', () => {
    expect(inboundFileName('audio', { file_name: 'track.flac', file_unique_id: 'u1' })).toBe('track.flac')
    expect(inboundFileName('video', { file_name: 'clip.mp4', file_unique_id: 'u2' })).toBe('clip.mp4')
  })

  test('voice without a name falls back to <unique-id>.ogg', () => {
    expect(inboundFileName('voice', { file_unique_id: 'abc' })).toBe('abc.ogg')
  })

  test('video / animation / video_note without a name fall back to .mp4', () => {
    expect(inboundFileName('video', { file_unique_id: 'v' })).toBe('v.mp4')
    expect(inboundFileName('animation', { file_unique_id: 'a' })).toBe('a.mp4')
    expect(inboundFileName('video_note', { file_unique_id: 'n' })).toBe('n.mp4')
  })

  test('extension is taken from the mime type when no name is given', () => {
    expect(inboundFileName('audio', { file_unique_id: 'm', mime_type: 'audio/mpeg' })).toBe('m.mp3')
    expect(inboundFileName('animation', { file_unique_id: 'g', mime_type: 'image/gif' })).toBe('g.gif')
    expect(inboundFileName('video', { file_unique_id: 'w', mime_type: 'video/webm' })).toBe('w.webm')
  })
})

describe('MAX_DOWNLOAD_BYTES', () => {
  test('matches Telegram bot download cap of 20 MB', () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(20 * 1024 * 1024)
  })
})
