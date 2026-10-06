import { useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { Space, Tag, Typography } from 'antd';
import type { AccessPoint } from '../../types/point';
import { FACILITY_COLORS } from './FacilityIcon';
import { boundsOf, metersPerPixel, toGridXY } from '../../utils/geo';
import { useAmapLoader } from '../../hooks/useAmapLoader';
import { truncate } from '../../utils/format';

interface MapPanelProps {
  points: AccessPoint[];
  selectedId?: string;
  onSelect?: (point: AccessPoint) => void;
  /** 允许在网格视图上直接打点选坐标 */
  onPick?: (lngLat: { lng: number; lat: number }) => void;
  height?: number;
  title?: string;
  showLegend?: boolean;
  /** 点位补充说明（如核验结论），显示在标记提示里 */
  noteOf?: (point: AccessPoint) => string;
}

const VIEW_W = 800;

/**
 * 地图容器：封装高德 JS API 与本地 SVG 网格降级两种模式。
 * VITE_AMAP_KEY 为空时不发起任何网络请求，直接渲染 SVG 网格视图。
 */
export default function MapPanel({
  points,
  selectedId,
  onSelect,
  onPick,
  height = 360,
  title = '设施点位分布',
  showLegend = true,
  noteOf,
}: MapPanelProps) {
  const { status, amap, error, usingFallback } = useAmapLoader();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<unknown>(null);

  const bounds = useMemo(() => boundsOf(points.map((p) => ({ lng: p.lng, lat: p.lat }))), [points]);
  const viewH = Math.max(240, height - 56);
  const scale = useMemo(() => metersPerPixel(bounds, VIEW_W), [bounds]);

  // 高德模式：初始化地图并着色渲染点位
  useEffect(() => {
    if (usingFallback || status !== 'ready' || !amap || !containerRef.current) return;
    const container = containerRef.current;

    if (!mapRef.current) {
      const center: [number, number] = [
        (bounds.minLng + bounds.maxLng) / 2,
        (bounds.minLat + bounds.maxLat) / 2,
      ];
      const instance = new amap.Map(container, { zoom: 14, center });
      mapRef.current = instance;
    }
    const instance = mapRef.current as {
      add: (o: unknown) => void;
      remove: (o: unknown) => void;
      setCenter: (c: [number, number]) => void;
      destroy: () => void;
    };
    instance.setCenter([
      (bounds.minLng + bounds.maxLng) / 2,
      (bounds.minLat + bounds.maxLat) / 2,
    ]);

    const markers = points.map((p) => {
      const marker = new amap.Marker({
        position: [p.lng, p.lat],
        title: p.name,
        content: `<div style="padding:4px 8px;border-radius:10px;background:${FACILITY_COLORS[p.facilityType]};color:#fff;font-size:12px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.3)">${p.facilityType}·${p.name}</div>`,
      });
      return marker;
    });
    markers.forEach((m) => instance.add(m));
    return () => {
      markers.forEach((m) => instance.remove(m));
    };
  }, [amap, status, usingFallback, points, bounds]);

  useEffect(
    () => () => {
      const instance = mapRef.current as { destroy?: () => void } | null;
      if (instance && typeof instance.destroy === 'function') instance.destroy();
      mapRef.current = null;
    },
    [],
  );

  const handleGridClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    if (!onPick) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * VIEW_W;
    const y = ((event.clientY - rect.top) / rect.height) * viewH;
    const lngSpan = bounds.maxLng - bounds.minLng;
    const latSpan = bounds.maxLat - bounds.minLat;
    const lng = bounds.minLng + (x / VIEW_W) * lngSpan;
    const lat = bounds.minLat + ((viewH - y) / viewH) * latSpan;
    onPick({ lng: Math.round(lng * 1e6) / 1e6, lat: Math.round(lat * 1e6) / 1e6 });
  };

  const gridLines = useMemo(() => {
    const vertical: number[] = [];
    const horizontal: number[] = [];
    for (let x = 0; x <= VIEW_W; x += 50) vertical.push(x);
    for (let y = 0; y <= viewH; y += 50) horizontal.push(y);
    return { vertical, horizontal };
  }, [viewH]);

  const legendTypes = useMemo(
    () => Array.from(new Set(points.map((p) => p.facilityType))),
    [points],
  );

  /** 标记位置与标签避让：相邻点位标签交错排布，避免文字互相压盖 */
  const placed = useMemo(() => {
    const list = points.map((p) => ({
      point: p,
      ...toGridXY({ lng: p.lng, lat: p.lat }, bounds, VIEW_W, viewH),
    }));
    const labelY: Record<string, number> = {};
    list.forEach((item, i) => {
      let y = -14;
      for (let j = 0; j < i; j += 1) {
        const dx = Math.abs(item.x - list[j].x);
        const dy = Math.abs(item.y - list[j].y);
        if (dx < 70 && dy < 30) y = -34;
        if (dx < 70 && dy < 12) y = 30;
      }
      labelY[item.point.id] = y;
    });
    return { list, labelY };
  }, [points, bounds, viewH]);

  return (
    <div
      data-testid="map-panel"
      data-mode={usingFallback ? 'fallback-svg' : status}
      style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', background: '#fff' }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid #f0f0f0',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <Space size={8} align="center">
          <Typography.Text strong>{title}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            共 {points.length} 个点位
          </Typography.Text>
        </Space>
        <Space size={8} align="center">
          <Tag color={usingFallback ? 'default' : 'blue'} data-testid="map-mode">
            {usingFallback ? '本地 SVG 网格视图' : status === 'loading' ? '高德地图加载中' : '高德地图 JS API'}
          </Tag>
          {usingFallback ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {error || '未配置 VITE_AMAP_KEY'}
            </Typography.Text>
          ) : null}
        </Space>
      </div>

      {usingFallback ? (
        <div>
          <svg
            data-testid="map-grid"
            viewBox={`0 0 ${VIEW_W} ${viewH}`}
            width="100%"
            height={viewH}
            role="img"
            aria-label="设施点位网格视图"
            onClick={handleGridClick}
            style={{ display: 'block', background: '#f8fafc', cursor: onPick ? 'crosshair' : 'default' }}
          >
            <defs>
              <pattern id="gb-grid-small" width="25" height="25" patternUnits="userSpaceOnUse">
                <path d="M25 0 L0 0 0 25" fill="none" stroke="#e6eef7" strokeWidth="1" />
              </pattern>
            </defs>
            <rect x="0" y="0" width={VIEW_W} height={viewH} fill="url(#gb-grid-small)" />
            {gridLines.vertical.map((x) => (
              <line key={`v${x}`} x1={x} y1={0} x2={x} y2={viewH} stroke="#dbe7f3" strokeWidth="1" />
            ))}
            {gridLines.horizontal.map((y) => (
              <line key={`h${y}`} x1={0} y1={y} x2={VIEW_W} y2={y} stroke="#dbe7f3" strokeWidth="1" />
            ))}

            {placed.list.map(({ point: p, x, y }) => {
              const color = FACILITY_COLORS[p.facilityType] ?? '#1668dc';
              const active = p.id === selectedId;
              const note = noteOf ? noteOf(p) : '';
              const labelY = placed.labelY[p.id] ?? -14;
              const below = labelY > 0;
              return (
                <g
                  key={p.id}
                  data-testid={`map-marker-${p.id}`}
                  transform={`translate(${x},${y})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect?.(p);
                  }}
                  style={{ cursor: onSelect ? 'pointer' : 'default' }}
                >
                  {active ? <circle r={16} fill={color} opacity={0.22} /> : null}
                  <circle r={active ? 10 : 8} fill={color} stroke="#fff" strokeWidth={2} />
                  <text x={0} y={4} textAnchor="middle" fontSize="9" fill="#fff" fontWeight="600">
                    {p.code.slice(-3)}
                  </text>
                  <text x={0} y={labelY} textAnchor="middle" fontSize="11" fill="#1f2937">
                    {truncate(p.name, 10)}
                  </text>
                  {note ? (
                    <text
                      x={0}
                      y={below ? labelY + 13 : labelY - 12}
                      textAnchor="middle"
                      fontSize="10"
                      fill="#6b7280"
                    >
                      {note}
                    </text>
                  ) : null}
                </g>
              );
            })}

            <text x={8} y={viewH - 8} fontSize="11" fill="#94a3b8">
              经度 {bounds.minLng.toFixed(4)} ~ {bounds.maxLng.toFixed(4)} · 纬度{' '}
              {bounds.minLat.toFixed(4)} ~ {bounds.maxLat.toFixed(4)}
            </text>
            <g transform={`translate(${VIEW_W - 150},${viewH - 20})`}>
              <line x1={0} y1={0} x2={100} y2={0} stroke="#64748b" strokeWidth="2" />
              <line x1={0} y1={-4} x2={0} y2={4} stroke="#64748b" strokeWidth="2" />
              <line x1={100} y1={-4} x2={100} y2={4} stroke="#64748b" strokeWidth="2" />
              <text x={50} y={-6} textAnchor="middle" fontSize="10" fill="#64748b">
                {(scale * 100).toFixed(0)} m
              </text>
            </g>
          </svg>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              padding: '8px 12px',
              borderTop: '1px solid #f0f0f0',
            }}
          >
            {showLegend
              ? legendTypes.map((t) => (
                  <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 5,
                        background: FACILITY_COLORS[t],
                        display: 'inline-block',
                      }}
                    />
                    {t}
                  </span>
                ))
              : null}
            {onPick ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                在网格上点击可直接取经纬度
              </Typography.Text>
            ) : null}
          </div>
        </div>
      ) : (
        <div
          ref={containerRef}
          data-testid="map-amap"
          style={{ width: '100%', height: viewH, background: '#eef2f7' }}
        />
      )}
    </div>
  );
}
