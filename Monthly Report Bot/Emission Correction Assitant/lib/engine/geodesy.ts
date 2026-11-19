// Geodesic distance on the WGS-84 ellipsoid (Vincenty's inverse formula). This is the SHORTEST possible path
// between two reported positions, a lower bound on the sailed distance, never the sailed distance itself.

const A = 6_378_137.0
const F = 1 / 298.257223563
const B = A * (1 - F)
const METRES_PER_NM = 1852

export function geodesicNm(lat1: number, lon1: number, lat2: number, lon2: number): number | null {
  if (lat1 === lat2 && lon1 === lon2) return 0
  const rad = Math.PI / 180
  const L = (lon2 - lon1) * rad
  const U1 = Math.atan((1 - F) * Math.tan(lat1 * rad))
  const U2 = Math.atan((1 - F) * Math.tan(lat2 * rad))
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1), sinU2 = Math.sin(U2), cosU2 = Math.cos(U2)
  let lambda = L
  let sinSigma = 0, cosSigma = 0, sigma = 0, cosSqAlpha = 0, cos2SigmaM = 0
  for (let iteration = 0; iteration < 200; iteration += 1) {
    const sinLambda = Math.sin(lambda), cosLambda = Math.cos(lambda)
    sinSigma = Math.sqrt((cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2)
    if (sinSigma === 0) return 0
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda
    sigma = Math.atan2(sinSigma, cosSigma)
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma
    cosSqAlpha = 1 - sinAlpha ** 2
    cos2SigmaM = cosSqAlpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha : 0
    const C = (F / 16) * cosSqAlpha * (4 + F * (4 - 3 * cosSqAlpha))
    const previous = lambda
    lambda = L + (1 - C) * F * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)))
    if (Math.abs(lambda - previous) < 1e-12) {
      const uSq = (cosSqAlpha * (A ** 2 - B ** 2)) / B ** 2
      const bigA = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)))
      const bigB = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)))
      const deltaSigma = bigB * sinSigma * (cos2SigmaM + (bigB / 4) * (cosSigma * (-1 + 2 * cos2SigmaM ** 2) - (bigB / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)))
      return (B * bigA * (sigma - deltaSigma)) / METRES_PER_NM
    }
  }
  return null // nearly antipodal points: no convergence; the caller reports "not evaluated"
}
