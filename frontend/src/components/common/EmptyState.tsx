import type { ReactNode } from 'react';
import { Empty, Typography } from 'antd';

interface EmptyStateProps {
  title: string;
  description?: string;
  extra?: ReactNode;
  compact?: boolean;
}

/** 列表 / 表格 / 地图的空态展示 */
export default function EmptyState({ title, description, extra, compact = false }: EmptyStateProps) {
  return (
    <div
      data-testid="empty-state"
      style={{
        padding: compact ? '16px 8px' : '32px 16px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span>
            <Typography.Text strong>{title}</Typography.Text>
            {description ? (
              <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0' }}>
                {description}
              </Typography.Paragraph>
            ) : null}
          </span>
        }
      />
      {extra}
    </div>
  );
}
