import { useMemo } from 'react';
import {
  Button,
  Card,
  Col,
  DatePicker,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined, AimOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import dayjs from 'dayjs';
import { useInspectionFilter } from '../hooks/useInspectionFilter';
import { useUiStore } from '../stores/uiStore';
import { DISTRICTS, FACILITY_TYPES, type AccessPoint } from '../types/point';
import { CONCLUSIONS } from '../types/inspection';
import type { RectifyPlan } from '../types/rectify';
import StatusBadge from '../components/common/StatusBadge';
import FacilityIcon from '../components/common/FacilityIcon';
import EmptyState from '../components/common/EmptyState';
import { isOverdue, percent } from '../utils/format';

interface GroupRow {
  key: string;
  name: string;
  total: number;
  pass: number;
  passRate: number;
  pending: number;
}

export default function Overview() {
  const {
    filter,
    setFilter,
    resetFilter,
    filteredPoints,
    filteredInspections,
    pendingRectifies,
    latestByPoint,
    passRate,
  } = useInspectionFilter();
  const drill = useUiStore((s) => s.drill);
  const setDrill = useUiStore((s) => s.setDrill);

  const districtRows = useMemo<GroupRow[]>(
    () =>
      DISTRICTS.map((d) => {
        const list = filteredPoints.filter((p) => p.district === d);
        const pass = list.filter((p) => latestByPoint.get(p.id)?.conclusion === '合格').length;
        return {
          key: d,
          name: d,
          total: list.length,
          pass,
          passRate: percent(pass, list.length),
          pending: pendingRectifies.filter((r) => list.some((p) => p.id === r.pointId)).length,
        };
      }).filter((r) => r.total > 0),
    [filteredPoints, latestByPoint, pendingRectifies],
  );

  const typeRows = useMemo<GroupRow[]>(
    () =>
      FACILITY_TYPES.map((t) => {
        const list = filteredPoints.filter((p) => p.facilityType === t);
        const pass = list.filter((p) => latestByPoint.get(p.id)?.conclusion === '合格').length;
        return {
          key: t,
          name: t,
          total: list.length,
          pass,
          passRate: percent(pass, list.length),
          pending: pendingRectifies.filter((r) => list.some((p) => p.id === r.pointId)).length,
        };
      }).filter((r) => r.total > 0),
    [filteredPoints, latestByPoint, pendingRectifies],
  );

  const drillPoints = useMemo(() => {
    if (drill.kind === 'district') return filteredPoints.filter((p) => p.district === drill.value);
    if (drill.kind === 'facilityType')
      return filteredPoints.filter((p) => p.facilityType === drill.value);
    return filteredPoints;
  }, [drill, filteredPoints]);

  const pointColumns: ColumnsType<AccessPoint> = [
    { title: '点位编号', dataIndex: 'code', width: 130 },
    {
      title: '名称',
      dataIndex: 'name',
      render: (name: string, row) => <Link to={`/points/${row.id}`}>{name}</Link>,
    },
    {
      title: '设施类型',
      dataIndex: 'facilityType',
      width: 150,
      render: (t: AccessPoint['facilityType']) => <FacilityIcon type={t} withLabel />,
    },
    { title: '行政区', dataIndex: 'district', width: 100 },
    {
      title: '最新结论',
      width: 110,
      render: (_, row) => <StatusBadge value={latestByPoint.get(row.id)?.conclusion ?? '未核验'} kind="conclusion" />,
    },
    {
      title: '核验次数',
      width: 90,
      render: (_, row) => filteredInspections.filter((i) => i.pointId === row.id).length,
    },
  ];

  const rectifyColumns: ColumnsType<RectifyPlan> = [
    {
      title: '点位',
      render: (_, row) => (
        <Link to={`/points/${row.pointId}`}>
          {filteredPoints.find((p) => p.id === row.pointId)?.name ?? row.pointId}
        </Link>
      ),
    },
    { title: '整改要求', dataIndex: 'requirement', ellipsis: true },
    { title: '责任单位', dataIndex: 'unit', width: 170 },
    {
      title: '整改期限',
      dataIndex: 'deadline',
      width: 130,
      render: (d: string, row) =>
        isOverdue(d, row.status) ? (
          <Space size={4}>
            {d}
            <Tag color="error">逾期</Tag>
          </Space>
        ) : (
          d
        ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => <StatusBadge value={s} kind="rectify" />,
    },
  ];

  const drillTitle =
    drill.kind === 'district'
      ? `${drill.value} · 点位清单`
      : drill.kind === 'facilityType'
        ? `${drill.value} · 点位清单`
        : drill.kind === 'pending'
          ? '待整改条目'
          : '全部点位清单';

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h1 className="gb-page-title">核验总览</h1>
          <Typography.Text type="secondary">
            按行政区与设施类型汇总点位数、合格率与待整改数，点击统计块或分组行下钻清单。
          </Typography.Text>
        </div>
        <Space wrap>
          <Select
            placeholder="行政区"
            style={{ width: 130 }}
            allowClear
            value={filter.district || undefined}
            onChange={(v) => setFilter({ district: v ?? '' })}
            options={DISTRICTS.map((d) => ({ value: d, label: d }))}
          />
          <Select
            placeholder="设施类型"
            style={{ width: 150 }}
            allowClear
            value={filter.facilityType || undefined}
            onChange={(v) => setFilter({ facilityType: v ?? '' })}
            options={FACILITY_TYPES.map((t) => ({ value: t, label: t }))}
          />
          <Select
            placeholder="核验结论"
            style={{ width: 130 }}
            allowClear
            value={filter.conclusion || undefined}
            onChange={(v) => setFilter({ conclusion: v ?? '' })}
            options={CONCLUSIONS.map((c) => ({ value: c, label: c }))}
          />
          <DatePicker
            placeholder="起始日期"
            value={filter.fromDate ? dayjs(filter.fromDate) : null}
            onChange={(d) => setFilter({ fromDate: d ? d.format('YYYY-MM-DD') : '' })}
          />
          <DatePicker
            placeholder="截止日期"
            value={filter.toDate ? dayjs(filter.toDate) : null}
            onChange={(d) => setFilter({ toDate: d ? d.format('YYYY-MM-DD') : '' })}
          />
          <Button icon={<ReloadOutlined />} onClick={resetFilter}>
            重置
          </Button>
        </Space>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card
            className={`gb-stat-card ${drill.kind === '' ? 'gb-stat-card-active' : ''}`}
            onClick={() => setDrill('', '')}
            data-testid="stat-total"
          >
            <Statistic title="点位数" value={filteredPoints.length} suffix="处" />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="gb-stat-card" data-testid="stat-passrate">
            <Statistic title="合格率（按最新结论）" value={passRate} suffix="%" precision={1} />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card
            className={`gb-stat-card ${drill.kind === 'pending' ? 'gb-stat-card-active' : ''}`}
            onClick={() => setDrill('pending', '待整改')}
            data-testid="stat-pending"
          >
            <Statistic
              title="待整改数"
              value={pendingRectifies.length}
              suffix="条"
              valueStyle={{ color: pendingRectifies.length ? '#cf1322' : undefined }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="gb-stat-card" data-testid="stat-inspections">
            <Statistic title="核验记录" value={filteredInspections.length} suffix="次" />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card title="按行政区汇总" size="small">
            <Table<GroupRow>
              rowKey="key"
              size="small"
              pagination={false}
              dataSource={districtRows}
              locale={{ emptyText: <EmptyState title="暂无行政区数据" compact /> }}
              onRow={(row) => ({
                onClick: () => setDrill('district', row.name),
                style: { cursor: 'pointer' },
              })}
              columns={[
                { title: '行政区', dataIndex: 'name' },
                { title: '点位数', dataIndex: 'total', width: 80 },
                { title: '合格', dataIndex: 'pass', width: 70 },
                {
                  title: '合格率',
                  dataIndex: 'passRate',
                  width: 90,
                  render: (v: number) => `${v}%`,
                },
                { title: '待整改', dataIndex: 'pending', width: 80 },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="按设施类型汇总" size="small">
            <Table<GroupRow>
              rowKey="key"
              size="small"
              pagination={false}
              dataSource={typeRows}
              locale={{ emptyText: <EmptyState title="暂无设施类型数据" compact /> }}
              onRow={(row) => ({
                onClick: () => setDrill('facilityType', row.name),
                style: { cursor: 'pointer' },
              })}
              columns={[
                {
                  title: '设施类型',
                  dataIndex: 'name',
                  render: (v: string) => <FacilityIcon type={v as AccessPoint['facilityType']} withLabel />,
                },
                { title: '点位数', dataIndex: 'total', width: 80 },
                { title: '合格', dataIndex: 'pass', width: 70 },
                { title: '合格率', dataIndex: 'passRate', width: 90, render: (v: number) => `${v}%` },
                { title: '待整改', dataIndex: 'pending', width: 80 },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <Card
        title={
          <Space size={8}>
            <AimOutlined />
            <span data-testid="drill-title">{drillTitle}</span>
          </Space>
        }
        size="small"
        style={{ marginTop: 16 }}
      >
        {drill.kind === 'pending' ? (
          pendingRectifies.length ? (
            <Table<RectifyPlan>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={pendingRectifies}
              columns={rectifyColumns}
            />
          ) : (
            <EmptyState title="没有待整改条目" description="全部设施均已整改完成" />
          )
        ) : drillPoints.length ? (
          <Table<AccessPoint>
            rowKey="id"
            size="small"
            pagination={{ pageSize: 8, hideOnSinglePage: true }}
            dataSource={drillPoints}
            columns={pointColumns}
          />
        ) : (
          <EmptyState title="没有匹配的点位" description="调整行政区、设施类型或日期筛选后再试" />
        )}
      </Card>
    </div>
  );
}
