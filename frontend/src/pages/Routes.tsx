import { useMemo, useState } from 'react';
import {
  App,
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, NodeIndexOutlined, SaveOutlined, ThunderboltOutlined, ReloadOutlined } from '@ant-design/icons';
import StatusBadge from '../components/common/StatusBadge';
import EmptyState from '../components/common/EmptyState';
import { usePointStore } from '../stores/pointStore';
import { useRouteStore, type DraftSegment } from '../stores/routeStore';
import type { RouteSegment } from '../types/route';
import { buildRouteVerdicts, judgeSegment, CURB_FAIL, CURB_PASS } from '../utils/routeCheck';
import { invalidateAndRebuild } from '../sync/syncService';

export default function Routes() {
  const { message } = App.useApp();
  const points = usePointStore((s) => s.points);
  const inspections = usePointStore((s) => s.inspections);
  const loadRoutes = useRouteStore((s) => s.load);
  const {
    segments,
    draftName,
    chain,
    draftSegments,
    verdict,
    setDraftName,
    setChain,
    buildChainSegments,
    updateDraftSegment,
    removeDraftSegment,
    computeVerdict,
    saveRoute,
    resetDraft,
  } = useRouteStore();
  const [saving, setSaving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  const pointOptions = useMemo(
    () => points.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` })),
    [points],
  );
  const nameOf = (id: string) => points.find((p) => p.id === id)?.name ?? id;

  const draftVerdict = verdict ?? null;

  const handleBuild = () => {
    if (chain.length < 2) {
      message.warning('请至少选择起点与终点两个点位');
      return;
    }
    buildChainSegments(points);
    message.success(`已自动串联 ${chain.length - 1} 段路段`);
  };

  const handleSave = async () => {
    if (!draftSegments.length) {
      message.warning('请先串联路段');
      return;
    }
    setSaving(true);
    try {
      const n = await saveRoute();
      message.success(`已保存 ${n} 段路线`);
      resetDraft();
    } catch (e) {
      message.error(`路线保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const draftColumns: ColumnsType<DraftSegment> = [
    { title: '段序', dataIndex: 'order', width: 60 },
    { title: '起点', dataIndex: 'fromPointId', render: (v: string) => nameOf(v) },
    { title: '终点', dataIndex: 'toPointId', render: (v: string) => nameOf(v) },
    {
      title: '长度(m)',
      dataIndex: 'length',
      width: 110,
      render: (v: number, row) => (
        <InputNumber
          aria-label={`长度-${row.order}`}
          min={1}
          max={100000}
          value={v}
          onChange={(nv) => updateDraftSegment(row.key, { length: Number(nv ?? 0) })}
          style={{ width: 100 }}
        />
      ),
    },
    {
      title: '沿途障碍数',
      dataIndex: 'obstacleCount',
      width: 120,
      render: (v: number, row) => (
        <InputNumber
          aria-label={`障碍数-${row.order}`}
          min={0}
          max={50}
          value={v}
          onChange={(nv) => updateDraftSegment(row.key, { obstacleCount: Number(nv ?? 0) })}
          style={{ width: 100 }}
        />
      ),
    },
    {
      title: '台阶数',
      dataIndex: 'stepCount',
      width: 110,
      render: (v: number, row) => (
        <InputNumber
          aria-label={`台阶数-${row.order}`}
          min={0}
          max={50}
          value={v}
          onChange={(nv) => updateDraftSegment(row.key, { stepCount: Number(nv ?? 0) })}
          style={{ width: 100 }}
        />
      ),
    },
    {
      title: '路缘高差(cm)',
      dataIndex: 'curbHeight',
      width: 130,
      render: (v: number, row) => (
        <InputNumber
          aria-label={`路缘高差-${row.order}`}
          min={0}
          max={60}
          step={0.5}
          value={v}
          onChange={(nv) => updateDraftSegment(row.key, { curbHeight: Number(nv ?? 0) })}
          style={{ width: 110 }}
        />
      ),
    },
    {
      title: '段判定',
      width: 110,
      render: (_, row) => (
        <StatusBadge value={judgeSegment(row).passable ? '可通行' : '不可通行'} kind="route" />
      ),
    },
    {
      title: '操作',
      width: 80,
      render: (_, row) => (
        <Button
          size="small"
          danger
          icon={<DeleteOutlined />}
          onClick={() => removeDraftSegment(row.key)}
          data-testid={`remove-segment-${row.order}`}
        />
      ),
    },
  ];

  const savedColumns: ColumnsType<RouteSegment> = [
    { title: '路线名称', dataIndex: 'routeName', width: 200 },
    { title: '段序', dataIndex: 'order', width: 70 },
    { title: '起点', dataIndex: 'fromPointId', render: (v: string) => nameOf(v) },
    { title: '终点', dataIndex: 'toPointId', render: (v: string) => nameOf(v) },
    { title: '长度(m)', dataIndex: 'length', width: 100 },
    { title: '障碍数', dataIndex: 'obstacleCount', width: 90 },
    { title: '台阶数', dataIndex: 'stepCount', width: 90 },
    { title: '路缘高差(cm)', dataIndex: 'curbHeight', width: 120 },
    {
      title: '可轮椅通行',
      dataIndex: 'wheelchairPassable',
      width: 120,
      render: (v: boolean, row) =>
        row.state === '失效' ? (
          <StatusBadge value="不可通行" kind="route" />
        ) : (
          <StatusBadge value={v ? '可通行' : '不可通行'} kind="route" />
        ),
    },
    {
      title: '状态',
      dataIndex: 'state',
      width: 90,
      render: (v: string) =>
        v === '失效' ? <Tag color="error">已失效</Tag> : <Tag color="success">有效</Tag>,
    },
    {
      title: '失效原因',
      dataIndex: 'stateReason',
      ellipsis: true,
      render: (v: string) => v || <Typography.Text type="secondary">—</Typography.Text>,
    },
  ];

  /** 已保存路线的全线判定：始终按当前点位与最新核验结论实时计算，失效路线不显示旧结论 */
  const savedVerdicts = useMemo(() => {
    const map = buildRouteVerdicts(segments, points, inspections);
    return [...map.values()];
  }, [segments, points, inspections]);

  const invalidSegmentCount = segments.filter((s) => s.state === '失效').length;

  const handleRebuild = async () => {
    setRebuilding(true);
    try {
      const affected = new Set(
        segments.flatMap((s) => (s.state === '失效' ? [s.fromPointId, s.toPointId] : [])),
      );
      const n = await invalidateAndRebuild(affected);
      await loadRoutes();
      message.success(n ? `已重算 ${n} 个相关路线段` : '没有需要重算的路段');
    } catch (e) {
      message.error(`重算失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRebuilding(false);
    }
  };

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h1 className="gb-page-title">通行路线编制</h1>
          <Typography.Text type="secondary">
            选择起点与途经点位后自动串联路段，逐段录入障碍数、台阶数与路缘高差，输出全线判定。
          </Typography.Text>
        </div>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card title="路线编制" size="small">
            <Form layout="vertical">
              <Row gutter={12}>
                <Col xs={24} md={10}>
                  <Form.Item label="路线名称">
                    <Input
                      id="routeName"
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      placeholder="如 东单—王府井轮椅通道"
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={14}>
                  <Form.Item label="按顺序选择点位（起点 → 途经 → 终点）">
                    <Select
                      id="chain"
                      mode="multiple"
                      value={chain}
                      onChange={(v) => setChain(v)}
                      options={pointOptions}
                      placeholder="先选起点，再依次选择终点"
                      style={{ width: '100%' }}
                      maxTagCount={3}
                    />
                  </Form.Item>
                </Col>
              </Row>
              <Space wrap>
                <Button
                  type="primary"
                  icon={<NodeIndexOutlined />}
                  onClick={handleBuild}
                  data-testid="build-route"
                >
                  自动串联路段
                </Button>
                <Button
                  icon={<ThunderboltOutlined />}
                  onClick={() => {
                    if (!draftSegments.length) {
                      message.warning('请先串联路段');
                      return;
                    }
                    computeVerdict();
                  }}
                  data-testid="compute-verdict"
                >
                  输出全线判定
                </Button>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={saving}
                  onClick={handleSave}
                  data-testid="save-route"
                >
                  保存路线
                </Button>
                <Button onClick={resetDraft} data-testid="reset-route">
                  清空编制
                </Button>
              </Space>
            </Form>

            <div style={{ marginTop: 16 }} data-testid="draft-segments">
              {draftSegments.length ? (
                <Table<DraftSegment>
                  rowKey="key"
                  size="small"
                  pagination={false}
                  dataSource={draftSegments}
                  columns={draftColumns}
                />
              ) : (
                <EmptyState
                  title="尚未串联路段"
                  description="选择至少两个点位后点击「自动串联路段」"
                  compact
                />
              )}
            </div>
          </Card>
        </Col>

        <Col xs={24} lg={10}>
          <Card title="全线判定" size="small" data-testid="verdict-card">
            {draftVerdict ? (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Space size={8} wrap>
                  <StatusBadge
                    value={draftVerdict.passable ? '可通行' : '不可通行'}
                    kind="route"
                    bordered
                  />
                  <Typography.Text strong data-testid="verdict-name">
                    {draftVerdict.routeName}
                  </Typography.Text>
                </Space>
                <Row gutter={12}>
                  <Col span={12}>
                    <Statistic title="全线长度" value={draftVerdict.totalLength} suffix="m" />
                  </Col>
                  <Col span={12}>
                    <Statistic title="沿途障碍" value={draftVerdict.totalObstacles} suffix="处" />
                  </Col>
                  <Col span={12}>
                    <Statistic title="台阶总数" value={draftVerdict.totalSteps} suffix="级" />
                  </Col>
                  <Col span={12}>
                    <Statistic title="最大路缘高差" value={draftVerdict.maxCurbHeight} suffix="cm" />
                  </Col>
                </Row>
                {draftVerdict.passable ? (
                  <Alert type="success" showIcon message="全线满足轮椅通行条件" />
                ) : (
                  <Alert
                    type="warning"
                    showIcon
                    message="存在不可通行路段"
                    description={
                      <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                        {draftVerdict.reasons.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    }
                  />
                )}
                <Typography.Text type="secondary" className="gb-muted">
                  判定阈值：路缘高差 ≤ {CURB_PASS}cm 可通行，&gt; {CURB_FAIL}cm 判定不可通行；存在台阶即需绕行。
                </Typography.Text>
              </Space>
            ) : (
              <EmptyState
                title="尚未输出判定"
                description="串联路段并填写实测值后点击「输出全线判定」"
                compact
              />
            )}
          </Card>

          <Card
            title="已编制路线判定"
            size="small"
            style={{ marginTop: 16 }}
            extra={
              <Space size={4}>
                {invalidSegmentCount > 0 ? <Tag color="error">{invalidSegmentCount} 段失效</Tag> : null}
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  loading={rebuilding}
                  onClick={handleRebuild}
                  data-testid="rebuild-routes"
                >
                  立即重算
                </Button>
              </Space>
            }
          >
            {invalidSegmentCount > 0 ? (
              <Alert
                type="error"
                showIcon
                style={{ marginBottom: 8 }}
                message="最新核验结论或点位发生变化，相关路线段已立即失效，旧全线结论不再显示"
                description="点击「立即重算」按最新点位与核验结论重新判定；缺少端点点位的路段补齐点位后才可重算。"
              />
            ) : null}
            {savedVerdicts.length ? (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {savedVerdicts.map((v) =>
                  v.valid ? (
                    <div key={v.routeName}>
                      <Space size={8} wrap>
                        <StatusBadge value={v.passable ? '可通行' : '不可通行'} kind="route" />
                        <Typography.Text>{v.routeName}</Typography.Text>
                        <Tag>{v.totalLength} m</Tag>
                        <Tag>台阶 {v.totalSteps}</Tag>
                        <Tag>障碍 {v.totalObstacles}</Tag>
                      </Space>
                      {v.gateNotes.length ? (
                        <div style={{ marginTop: 2 }}>
                          {v.gateNotes.map((g) => (
                            <Tag key={g} color="warning">
                              {g}
                            </Tag>
                          ))}
                        </div>
                      ) : null}
                      {!v.passable && v.reasons.length ? (
                        <Typography.Paragraph type="warning" style={{ marginTop: 4, marginBottom: 0 }}>
                          {v.reasons.join('；')}
                        </Typography.Paragraph>
                      ) : null}
                    </div>
                  ) : (
                    <Alert
                      key={v.routeName}
                      type="error"
                      showIcon
                      message={`路线「${v.routeName}」已失效（${v.invalidCount} 段）`}
                      description="端点点位或最新核验结论已变化，旧全线结论不能继续显示，请立即重算。"
                    />
                  ),
                )}
              </Space>
            ) : (
              <EmptyState title="暂无已保存路线" compact />
            )}
          </Card>
        </Col>
      </Row>

      <Card title="已保存路段明细" size="small" style={{ marginTop: 16 }}>
        {segments.length ? (
          <Table<RouteSegment>
            rowKey="id"
            size="small"
            pagination={{ pageSize: 8, hideOnSinglePage: true }}
            dataSource={segments}
            columns={savedColumns}
          />
        ) : (
          <EmptyState title="暂无路段记录" description="编制并保存后在此查看" compact />
        )}
      </Card>
    </div>
  );
}
