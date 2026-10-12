import { describe, expect, it } from 'vitest'

import { splitStreamCredentials } from '@/lib/streamUrl'

describe('splitStreamCredentials', () => {
  it('takes a Hikvision login out of the URL', () => {
    expect(
      splitStreamCredentials('rtsp://admin:Secret1@192.168.1.64:554/Streaming/Channels/101'),
    ).toEqual({
      url: 'rtsp://192.168.1.64:554/Streaming/Channels/101',
      username: 'admin',
      password: 'Secret1',
    })
  })

  it('keeps a Dahua query string verbatim', () => {
    const split = splitStreamCredentials(
      'rtsp://admin:pw@10.0.0.9:554/cam/realmonitor?channel=1&subtype=0',
    )
    expect(split.url).toBe('rtsp://10.0.0.9:554/cam/realmonitor?channel=1&subtype=0')
  })

  it('decodes percent-escapes in the login', () => {
    expect(splitStreamCredentials('rtsp://jury%2Dadmin:Pa%3Ass%40w0rd@h/x')).toEqual({
      url: 'rtsp://h/x',
      username: 'jury-admin',
      password: 'Pa:ss@w0rd',
    })
  })

  it('reads the last @ as the end of the login', () => {
    expect(splitStreamCredentials('rtsp://admin:p@ss@10.0.0.5/live')).toEqual({
      url: 'rtsp://10.0.0.5/live',
      username: 'admin',
      password: 'p@ss',
    })
  })

  it('handles a username with no password', () => {
    expect(splitStreamCredentials('rtsp://viewer@cam.local/live')).toEqual({
      url: 'rtsp://cam.local/live',
      username: 'viewer',
      password: null,
    })
  })

  it('leaves a URL without a login alone', () => {
    const url = 'rtsp://jury-cam:8554/live'
    expect(splitStreamCredentials(url)).toEqual({ url, username: null, password: null })
  })

  it('does not mistake an @ in the path for a login', () => {
    const url = 'rtsp://10.0.0.5/stream@main'
    expect(splitStreamCredentials(url).username).toBeNull()
  })

  it('leaves other schemes alone', () => {
    const url = 'file://user:pw@host/clip.mp4'
    expect(splitStreamCredentials(url)).toEqual({ url, username: null, password: null })
  })
})
