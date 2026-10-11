/** A registry camera for tests, shaped like the API's `CameraOut`. */

import type { Camera } from '@/lib/types'

export function camera(code: string, overrides: Partial<Camera> = {}): Camera {
  return {
    id: `id-${code}`,
    camera_code: code,
    name: `${code} name`,
    department_code: null,
    department_name: null,
    vms_name: 'Hosted Camera Grid',
    vms_vendor: 'hosted_grid',
    corridor: null,
    district: 'Ahmadabad',
    city: 'Ahmedabad',
    junction: `${code} junction`,
    address: null,
    lat: 23.0225,
    lon: 72.5714,
    heading_deg: null,
    camera_type: 'fixed',
    protocol: 'rtsp',
    resolution: null,
    fps: null,
    anpr_enabled: true,
    status: 'unknown',
    installed_on: null,
    tags: ['sandbox', 'placement:city'],
    has_stream: true,
    source_file: null,
    created_at: '2026-10-11T00:00:00Z',
    updated_at: '2026-10-11T00:00:00Z',
    ...overrides,
  }
}

/** The recorded demonstration camera, placed at its junction. */
export const DEMO = camera('CAM-DEMO-01', {
  name: 'Paldi — Ashram Road',
  junction: 'Ashram Road @ Paldi',
  district: 'Sabarmati',
  lat: 23.00937,
  lon: 72.56212,
  status: 'online',
  vms_name: 'Ahmedabad City ANPR Grid (simulated)',
  vms_vendor: 'simulated',
  department_code: 'MUNICIPAL',
  department_name: 'Urban Development & Urban Housing (Municipal)',
  tags: ['demo', 'recorded-footage', 'not-a-real-camera'],
  has_stream: false,
})

/** A grid camera with no position: parked at the state centroid. */
export function unplaced(code: string, overrides: Partial<Camera> = {}): Camera {
  return camera(code, {
    city: null,
    district: null,
    junction: code,
    lat: 22.2587,
    lon: 71.1924,
    tags: ['sandbox', 'placement:unknown'],
    ...overrides,
  })
}
