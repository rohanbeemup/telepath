// Renders one message, off the daemon's thread, so a pathological parse can be
// killed by deadline instead of stalling every topic. See renderWithDeadline.
import { mdToTelegramHtml } from './markdown'

declare const self: Worker
self.onmessage = (e: MessageEvent) => {
  try {
    postMessage({ html: mdToTelegramHtml(String(e.data)) })
  } catch {
    postMessage({ html: null })
  }
}
