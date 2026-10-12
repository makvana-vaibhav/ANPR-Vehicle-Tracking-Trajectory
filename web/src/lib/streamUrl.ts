/**
 * Splitting a camera's login out of a pasted stream URL.
 *
 * A camera usually arrives as one string copied from an NVR's web page or a
 * phone app: `rtsp://admin:Secret1@192.168.1.64:554/Streaming/Channels/101`.
 * The registry never stores a URL with a login in it, so the onboarding form
 * takes it apart the moment it is pasted — the URL keeps host, port and path
 * exactly as typed, and the username and password move into their own fields,
 * from where the API seals the password into the encrypted credential store.
 * The API does the same split itself, so a URL that bypasses the form is
 * handled identically; doing it here as well is what lets the form *show* the
 * operator what happened before anything is sent.
 */

/** Schemes whose URLs carry `user:password@`. Anything else is left as typed. */
const CREDENTIAL_SCHEMES = new Set(['rtsp', 'rtsps', 'rtmp', 'rtmps', 'http', 'https'])

export interface SplitStreamUrl {
  /** The URL without its login, otherwise exactly as typed. */
  url: string
  /** Percent-decoded, as the camera expects it. Null when there was none. */
  username: string | null
  password: string | null
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    // A stray `%` in a password is a character, not an escape.
    return value
  }
}

export function splitStreamCredentials(raw: string): SplitStreamUrl {
  const none: SplitStreamUrl = { url: raw, username: null, password: null }
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/is.exec(raw.trim())
  if (!match) return none
  const [, scheme = '', authority = '', rest = ''] = match
  if (!CREDENTIAL_SCHEMES.has(scheme.toLowerCase())) return none
  // The last `@` ends the login, so an unescaped `@` inside a password stays
  // part of the password rather than being read as the host.
  const at = authority.lastIndexOf('@')
  if (at < 0) return none
  const userinfo = authority.slice(0, at)
  const colon = userinfo.indexOf(':')
  const rawUser = colon < 0 ? userinfo : userinfo.slice(0, colon)
  const rawPassword = colon < 0 ? null : userinfo.slice(colon + 1)
  return {
    url: `${scheme}://${authority.slice(at + 1)}${rest}`,
    username: rawUser ? decode(rawUser) : null,
    password: rawPassword === null ? null : decode(rawPassword),
  }
}
