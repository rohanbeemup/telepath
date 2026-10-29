/**
 * Media classification and the per-kind notices telepath attaches to inbound uploads.
 * This is the deciding layer for attachments; src/bot.ts is the thin Telegram edge that
 * calls these and keeps no policy of its own, so every routing choice is unit-tested here.
 */
import { isImage } from './files'

export type OutboundKind = 'image' | 'video' | 'animation' | 'audio' | 'document'
/** Inbound kinds handled as files to Read. Voice and audio are transcribed instead (src/voice.ts). */
export type InboundKind = 'video' | 'animation' | 'video_note'

/** Telegram caps a bot's file downloads at 20 MB; a larger upload cannot be fetched. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024

const VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv)$/i
const ANIM_RE = /\.gif$/i
const AUDIO_RE = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|weba)$/i

/**
 * How an outbox file should be delivered. Checked in precedence order so a `.gif` becomes
 * an animation rather than a static photo, even though it also matches the image set.
 */
export function mediaKind(path: string): OutboundKind {
  if (VIDEO_RE.test(path)) return 'video'
  if (ANIM_RE.test(path)) return 'animation'
  if (AUDIO_RE.test(path)) return 'audio'
  if (isImage(path)) return 'image'
  return 'document'
}

/**
 * Whether a typed inline send should fall back to a plain document on failure. Telegram
 * documents MP3/M4A for sendAudio and MPEG4 for sendVideo, and rejects other formats
 * (wav/flac/ogg, mkv/mov/webm); without a fallback those would stay stuck in the outbox,
 * retried every turn, whereas before they were delivered as documents. image keeps its
 * prior no-fallback behaviour; document is already the fallback.
 */
export function fallsBackToDocument(kind: OutboundKind): boolean {
  return kind === 'video' || kind === 'animation' || kind === 'audio'
}

const MIME_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'image/gif': 'gif',
}

const DEFAULT_EXT: Record<InboundKind, string> = {
  video: 'mp4',
  animation: 'mp4',
  video_note: 'mp4',
}

/**
 * A filename for a saved upload. Telegram supplies one for documents, videos, animations
 * and audio; voice notes and round video notes have none, so fall back to the stable
 * file_unique_id with an extension from the mime type (or a per-kind default).
 */
export function inboundFileName(
  kind: InboundKind,
  src: { file_name?: string; file_unique_id: string; mime_type?: string },
): string {
  if (src.file_name) return src.file_name
  const ext = (src.mime_type && MIME_EXT[src.mime_type]) || DEFAULT_EXT[kind]
  return `${src.file_unique_id}.${ext}`
}

export interface IncomingMedia {
  /** Absolute path the upload was saved to, for the session to Read / transcribe. */
  path: string
  name?: string
  mime?: string
  /** Seconds, when Telegram reports it (video / audio / voice / note). */
  duration?: number
  caption?: string
}

/** A `(mime, 12s)` suffix, dropping whichever parts are absent; '' when neither is present. */
function meta(info: IncomingMedia): string {
  const parts: string[] = []
  if (info.mime) parts.push(info.mime)
  if (info.duration) parts.push(`${info.duration}s`)
  return parts.length ? ` (${parts.join(', ')})` : ''
}

function captionLine(info: IncomingMedia): string {
  const c = info.caption?.trim()
  return c ? `\nCaption: ${c}` : ''
}

/**
 * The acknowledgement shown in the topic and the prompt handed to the session for an
 * inbound upload. The prompt always names the saved path; video hints at frame extraction
 * and voice/audio at transcription, because the Read tool cannot open those formats.
 */
export function inboundMediaNotice(kind: InboundKind, info: IncomingMedia): { ack: string; prompt: string } {
  const at = `, saved at ${info.path}`
  const cap = captionLine(info)
  switch (kind) {
    case 'video':
      return {
        ack: '🎥 video received',
        prompt:
          `The user sent a video${meta(info)}${at}. To see it, extract frames with ffmpeg and Read them, ` +
          `and/or transcribe its audio.${cap}`,
      }
    case 'video_note':
      return {
        ack: '🎥 video note received',
        prompt:
          `The user sent a round video note${meta(info)}${at}. To see it, extract frames with ffmpeg and Read them, ` +
          `and/or transcribe its audio.${cap}`,
      }
    case 'animation':
      return {
        ack: '🎞️ GIF received',
        prompt: `The user sent an animation (GIF)${meta(info)}${at}. Extract a frame with ffmpeg and Read it to see it.${cap}`,
      }
  }
}
