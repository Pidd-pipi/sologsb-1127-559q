import { Tag } from 'antd';

export type BadgeKind = 'conclusion' | 'rectify' | 'route' | 'generic';

interface StatusBadgeProps {
  /** 结论文本：合格 / 限期整改 / 不合格 / 待整改 / 已整改 / 复发 / 可通行 / 不可通行 */
  value: string;
  kind?: BadgeKind;
  /** 是否附带边框（默认无边框的浅色标签） */
  bordered?: boolean;
}

const COLOR_MAP: Record<string, string> = {
  合格: 'success',
  限期整改: 'warning',
  不合格: 'error',
  待整改: 'warning',
  已整改: 'success',
  复发: 'error',
  可通行: 'success',
  不可通行: 'error',
  未核验: 'default',
};

export function badgeColor(value: string): string {
  return COLOR_MAP[value] ?? 'default';
}

/** 核验结论与整改状态标签 */
export default function StatusBadge({ value, kind = 'generic', bordered = false }: StatusBadgeProps) {
  const text = value || '未核验';
  return (
    <Tag
      color={badgeColor(text)}
      bordered={bordered}
      data-kind={kind}
      data-status={text}
      style={{ marginInlineEnd: 0 }}
    >
      {text}
    </Tag>
  );
}
