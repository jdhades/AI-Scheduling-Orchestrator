/**
 * Pure timeclock evaluation — no Nest, no IO. Validates a GPS punch against
 * the branch geofence and classifies anomalies. The server is authoritative;
 * the client runs the same logic only for UX.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface GeofenceConfig extends LatLng {
  radiusM: number;
}

export interface GpsClockInput extends LatLng {
  /** Reported horizontal accuracy in meters. */
  accuracy: number;
}

export type ClockAnomaly = 'outside_geofence' | 'low_accuracy' | null;

export interface ClockEvaluation {
  validationStatus: 'valid' | 'pending_review';
  anomalyReason: ClockAnomaly;
  /** Distance to the geofence center in meters (null when no geofence). */
  distanceM: number | null;
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in meters between two coordinates. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * TODO(hardcode): required GPS accuracy (50 m) is a sensible default but should
 * come from CompanyPolicy per tenant. Passed as a param so the call site can
 * override once policy wiring exists.
 */
export const DEFAULT_REQUIRED_ACCURACY_M = 50;

/**
 * Classifies a GPS punch:
 *  - accuracy worse than required → pending_review (low_accuracy)
 *  - outside the geofence radius  → pending_review (outside_geofence)
 *  - otherwise (or no geofence)   → valid
 * A punch is never rejected — anomalies are recorded for manager review so an
 * offline/edge clock-in is never lost.
 */
export function evaluateGpsClock(
  input: GpsClockInput,
  geofence: GeofenceConfig | null,
  requiredAccuracyM: number = DEFAULT_REQUIRED_ACCURACY_M,
): ClockEvaluation {
  if (input.accuracy > requiredAccuracyM) {
    return { validationStatus: 'pending_review', anomalyReason: 'low_accuracy', distanceM: null };
  }
  if (!geofence) {
    return { validationStatus: 'valid', anomalyReason: null, distanceM: null };
  }
  const distanceM = haversineMeters(input, geofence);
  if (distanceM > geofence.radiusM) {
    return { validationStatus: 'pending_review', anomalyReason: 'outside_geofence', distanceM };
  }
  return { validationStatus: 'valid', anomalyReason: null, distanceM };
}
