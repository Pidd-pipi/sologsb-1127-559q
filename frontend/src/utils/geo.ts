/** 经纬度坐标 */
export interface LngLat {
  lng: number;
  lat: number;
}

export interface Bounds {
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
}

const EARTH_RADIUS_M = 6371008.8;
const RAD = Math.PI / 180;

/** 两点间大圆距离（米） */
export function haversineMeters(a: LngLat, b: LngLat): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const lat1 = a.lat * RAD;
  const lat2 = b.lat * RAD;
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_M * c;
}

/** 依次串联多个坐标点，累加路段长度（米） */
export function accumulateLength(points: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += haversineMeters(points[i - 1], points[i]);
  }
  return total;
}

/** 单段长度，保留一位小数 */
export function segmentLength(a: LngLat, b: LngLat): number {
  return Math.round(haversineMeters(a, b) * 10) / 10;
}

/** 计算点位集合的外接矩形，集合为空时返回北京市中心附近的默认范围 */
export function boundsOf(points: LngLat[]): Bounds {
  if (!points.length) {
    return { minLng: 116.28, maxLng: 116.52, minLat: 39.83, maxLat: 40.02 };
  }
  let minLng = points[0].lng;
  let maxLng = points[0].lng;
  let minLat = points[0].lat;
  let maxLat = points[0].lat;
  for (const p of points) {
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  // 单点时给出一个最小跨度，避免除零
  if (maxLng - minLng < 0.004) {
    const mid = (maxLng + minLng) / 2;
    minLng = mid - 0.002;
    maxLng = mid + 0.002;
  }
  if (maxLat - minLat < 0.004) {
    const mid = (maxLat + minLat) / 2;
    minLat = mid - 0.002;
    maxLat = mid + 0.002;
  }
  const padLng = (maxLng - minLng) * 0.08;
  const padLat = (maxLat - minLat) * 0.08;
  return {
    minLng: minLng - padLng,
    maxLng: maxLng + padLng,
    minLat: minLat - padLat,
    maxLat: maxLat + padLat,
  };
}

/**
 * 经纬度 → SVG 网格坐标换算（降级视图使用）。
 * 纬度与 lng 均为线性映射，y 轴翻转以符合屏幕坐标。
 */
export function toGridXY(
  p: LngLat,
  bounds: Bounds,
  width: number,
  height: number,
): { x: number; y: number } {
  const lngSpan = bounds.maxLng - bounds.minLng || 1;
  const latSpan = bounds.maxLat - bounds.minLat || 1;
  const x = ((p.lng - bounds.minLng) / lngSpan) * width;
  const y = height - ((p.lat - bounds.minLat) / latSpan) * height;
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}

/** 网格视图的参考比例尺（1 像素约等于多少米） */
export function metersPerPixel(bounds: Bounds, width: number): number {
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const widthMeters = haversineMeters(
    { lng: bounds.minLng, lat: midLat },
    { lng: bounds.maxLng, lat: midLat },
  );
  return Math.round((widthMeters / (width || 1)) * 10) / 10;
}
