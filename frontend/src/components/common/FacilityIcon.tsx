import type { FacilityType } from '../../types/point';

/** 各设施类型的主题色，地图着色与图例共用 */
export const FACILITY_COLORS: Record<FacilityType, string> = {
  缘石坡道: '#1668dc',
  盲道: '#d48806',
  无障碍电梯: '#531dab',
  轮椅坡道: '#08979c',
  无障碍卫生间: '#c41d7f',
  低位服务台: '#389e0d',
};

interface FacilityIconProps {
  type: FacilityType;
  size?: number;
  /** 是否显示文字标签 */
  withLabel?: boolean;
}

/** 设施类型图标：纯内联 SVG，不依赖远程图标资源 */
export default function FacilityIcon({ type, size = 20, withLabel = false }: FacilityIconProps) {
  const color = FACILITY_COLORS[type] ?? '#1668dc';
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    xmlns: 'http://www.w3.org/2000/svg',
    'aria-label': type,
    role: 'img' as const,
  };

  const glyph = (() => {
    switch (type) {
      case '缘石坡道':
        return (
          <path
            d="M3 18h8l4-6h6"
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      case '盲道':
        return (
          <>
            <path d="M6 20V8" stroke={color} strokeWidth="2" strokeLinecap="round" />
            <path d="M12 20V8" stroke={color} strokeWidth="2" strokeLinecap="round" />
            <path d="M18 20V8" stroke={color} strokeWidth="2" strokeLinecap="round" />
            <circle cx="12" cy="4.5" r="2" fill={color} />
          </>
        );
      case '无障碍电梯':
        return (
          <>
            <rect x="4" y="3" width="16" height="18" rx="2" fill="none" stroke={color} strokeWidth="2" />
            <path d="M9.5 10l2-3 2 3M9.5 15l2 3 2-3" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
          </>
        );
      case '轮椅坡道':
        return (
          <>
            <circle cx="10" cy="6" r="2.2" fill={color} />
            <path d="M10 9v5h5l3 6" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
            <circle cx="10" cy="15" r="5" fill="none" stroke={color} strokeWidth="2" />
          </>
        );
      case '无障碍卫生间':
        return (
          <>
            <circle cx="8" cy="5" r="2" fill={color} />
            <path d="M8 8v6m0 0v7m0-7h4" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
            <circle cx="17" cy="5" r="2" fill="none" stroke={color} strokeWidth="2" />
            <path d="M17 8v6m0 0l-2.5 7m2.5-7l2.5 7" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" />
          </>
        );
      case '低位服务台':
      default:
        return (
          <>
            <rect x="3" y="12" width="18" height="3" rx="1.2" fill={color} />
            <path d="M6 15v5M18 15v5" stroke={color} strokeWidth="2" strokeLinecap="round" />
            <circle cx="16" cy="6" r="2.2" fill="none" stroke={color} strokeWidth="2" />
            <path d="M12 8h4" stroke={color} strokeWidth="2" strokeLinecap="round" />
          </>
        );
    }
  })();

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, lineHeight: 1 }}>
      <svg {...common}>{glyph}</svg>
      {withLabel ? <span style={{ color }}>{type}</span> : null}
    </span>
  );
}
