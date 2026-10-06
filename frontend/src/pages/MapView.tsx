import { useMemo, useState } from 'react';
import { Button, Card, Col, Descriptions, Drawer, List, Row, Select, Space, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';
import MapPanel from '../components/common/MapPanel';
import FacilityIcon from '../components/common/FacilityIcon';
import StatusBadge from '../components/common/StatusBadge';
import EmptyState from '../components/common/EmptyState';
import { usePointStore } from '../stores/pointStore';
import { useUiStore } from '../stores/uiStore';
import { FACILITY_TYPES, type AccessPoint } from '../types/point';
import { isOverdue } from '../utils/format';

export default function MapView() {
  const points = usePointStore((s) => s.points);
  const inspections = usePointStore((s) => s.inspections);
  const rectifies = usePointStore((s) => s.rectifies);
  const typeFilter = useUiStore((s) => s.mapFacilityFilter);
  const setTypeFilter = useUiStore((s) => s.setMapFacilityFilter);
  const [activeId, setActiveId] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);

  const visible = useMemo(
    () => (typeFilter ? points.filter((p) => p.facilityType === typeFilter) : points),
    [points, typeFilter],
  );

  const latestOf = (pointId: string) =>
    inspections
      .filter((i) => i.pointId === pointId)
      .sort((a, b) => (a.date < b.date ? 1 : -1))[0];

  const active = points.find((p) => p.id === activeId);
  const activeInspections = active
    ? inspections.filter((i) => i.pointId === active.id).sort((a, b) => (a.date < b.date ? 1 : -1))
    : [];
  const activePlans = active ? rectifies.filter((r) => r.pointId === active.id) : [];

  const noteOf = (p: AccessPoint) => latestOf(p.id)?.conclusion ?? '未核验';

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h1 className="gb-page-title">设施地图</h1>
          <Typography.Text type="secondary">
            按设施类型着色渲染点位，点选标记查看核验摘要；未配置 VITE_AMAP_KEY 时自动使用本地 SVG 网格视图。
          </Typography.Text>
        </div>
        <Space wrap>
          <Select
            placeholder="按设施类型过滤"
            style={{ width: 180 }}
            allowClear
            value={typeFilter || undefined}
            onChange={(v) => setTypeFilter(v ?? '')}
            options={FACILITY_TYPES.map((t) => ({ value: t, label: t }))}
          />
          <Tag color="blue" data-testid="map-visible-count">
            可见 {visible.length}
          </Tag>
        </Space>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={17}>
          <MapPanel
            points={visible}
            selectedId={activeId}
            onSelect={(p) => {
              setActiveId(p.id);
              setDrawerOpen(true);
            }}
            height={560}
            title="设施点位分布（点选查看核验摘要）"
            noteOf={noteOf}
          />
        </Col>
        <Col xs={24} lg={7}>
          <Card title="点位列表" size="small" style={{ maxHeight: 620, overflow: 'auto' }}>
            {visible.length ? (
              <List
                size="small"
                dataSource={visible}
                renderItem={(p) => {
                  const latest = latestOf(p.id);
                  return (
                    <List.Item
                      style={{ cursor: 'pointer' }}
                      onClick={() => {
                        setActiveId(p.id);
                        setDrawerOpen(true);
                      }}
                      actions={[<StatusBadge key="s" value={latest?.conclusion ?? '未核验'} kind="conclusion" />]}
                    >
                      <List.Item.Meta
                        avatar={<FacilityIcon type={p.facilityType} size={22} />}
                        title={p.name}
                        description={
                          <span
                            style={{
                              display: 'block',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {p.code} · {p.district}
                          </span>
                        }
                      />
                    </List.Item>
                  );
                }}
              />
            ) : (
              <EmptyState title="没有符合条件的点位" description="清除设施类型筛选后再试" compact />
            )}
          </Card>
        </Col>
      </Row>

      <Drawer
        title={active ? `${active.name} · 核验摘要` : '核验摘要'}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={420}
        data-testid="inspection-drawer"
      >
        {active ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="点位编号">{active.code}</Descriptions.Item>
              <Descriptions.Item label="设施类型">
                <FacilityIcon type={active.facilityType} withLabel />
              </Descriptions.Item>
              <Descriptions.Item label="行政区">{active.district}</Descriptions.Item>
              <Descriptions.Item label="位置">{active.location || '—'}</Descriptions.Item>
              <Descriptions.Item label="养护单位">{active.maintainUnit}</Descriptions.Item>
              <Descriptions.Item label="经纬度">
                {active.lng.toFixed(6)}, {active.lat.toFixed(6)}
              </Descriptions.Item>
            </Descriptions>

            <Card size="small" title={`核验历史（${activeInspections.length} 条）`}>
              {activeInspections.length ? (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {activeInspections.slice(0, 4).map((i) => (
                    <div key={i.id}>
                      <Space size={8} wrap>
                        <Typography.Text strong>{i.date}</Typography.Text>
                        <StatusBadge value={i.conclusion} kind="conclusion" />
                        <Tag>坡度 {i.slope}%</Tag>
                        <Tag>净宽 {i.clearWidth}cm</Tag>
                        {i.occupied !== '无' ? <Tag color="orange">{i.occupied}</Tag> : null}
                      </Space>
                      {i.problem ? (
                        <div className="gb-muted" style={{ marginTop: 2 }}>
                          {i.problem}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </Space>
              ) : (
                <EmptyState title="暂无核验记录" compact />
              )}
            </Card>

            <Card size="small" title={`整改跟踪（${activePlans.length} 条）`}>
              {activePlans.length ? (
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {activePlans.map((r) => (
                    <div key={r.id}>
                      <Space size={8} wrap>
                        <StatusBadge value={r.status} kind="rectify" />
                        {isOverdue(r.deadline, r.status) ? <Tag color="error">已逾期</Tag> : null}
                        <Typography.Text type="secondary" className="gb-muted">
                          期限 {r.deadline}
                        </Typography.Text>
                      </Space>
                      <div>{r.requirement}</div>
                    </div>
                  ))}
                </Space>
              ) : (
                <EmptyState title="暂无整改条目" compact />
              )}
            </Card>

            <Link to={`/points/${active.id}`}>
              <Button type="primary" block data-testid="drawer-to-detail">
                进入点位详情
              </Button>
            </Link>
          </Space>
        ) : (
          <EmptyState title="请在地图上点选一个点位" />
        )}
      </Drawer>
    </div>
  );
}
