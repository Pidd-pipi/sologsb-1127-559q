import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudUploadOutlined,
  DownloadOutlined,
  FileSearchOutlined,
  InboxOutlined,
  ReloadOutlined,
  WifiOutlined,
} from '@ant-design/icons';
import { usePointStore } from '../stores/pointStore';
import { useRouteStore } from '../stores/routeStore';
import type {
  ConflictChoice,
  EntityMergePlan,
  MergePreview,
  PackageRecord,
} from '../types/sync';
import type { EntityKind } from '../types/sync';
import {
  applyStaged,
  downloadJson,
  exportPackage,
  intakePackage,
  listStaged,
  parsePackage,
  previewStaged,
  removeStaged,
  retryStaged,
  saveResolutions,
  sealReturnPackage,
} from '../sync/packageService';
import type { OfflinePackage, PackagePayload } from '../types/sync';
import EmptyState from '../components/common/EmptyState';

const KIND_TEXT: Record<EntityKind, string> = {
  point: '点位',
  inspection: '核验记录',
  rectify: '整改条目',
};

const STATUS_TEXT: Record<PackageRecord['status'], { text: string; color: string }> = {
  pending: { text: '待应用（留待重试）', color: 'orange' },
  conflict: { text: '待并排裁决', color: 'red' },
  applying: { text: '应用中', color: 'processing' },
  applied: { text: '已应用', color: 'green' },
  failed: { text: '应用失败（留待重试）', color: 'red' },
};

function displayValue(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—';
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}

interface ReviewState {
  recordId: string;
  fileName: string;
  preview: MergePreview;
  resolutions: Record<string, Record<string, ConflictChoice>>;
}

export default function OfflineSync() {
  const { message, modal } = App.useApp();
  const points = usePointStore((s) => s.points);
  const inspections = usePointStore((s) => s.inspections);
  const rectifies = usePointStore((s) => s.rectifies);
  const reloadPoints = usePointStore((s) => s.reloadAll);
  const loadRoutes = useRouteStore((s) => s.load);

  const [selectedPointIds, setSelectedPointIds] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [exporting, setExporting] = useState(false);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [applying, setApplying] = useState(false);
  const [staged, setStaged] = useState<PackageRecord[]>([]);
  const [tab, setTab] = useState('export');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importFileName, setImportFileName] = useState('');
  const [intakeWarnings, setIntakeWarnings] = useState<string[]>([]);
  const [intakeErrors, setIntakeErrors] = useState<string[]>([]);

  const refreshStaged = async () => setStaged(await listStaged());
  useEffect(() => {
    void refreshStaged();
  }, []);

  const pointName = (id: string) => points.find((p) => p.id === id)?.name ?? id;

  const statsOf = useMemo(() => {
    const idSet = new Set(selectedPointIds);
    return {
      points: selectedPointIds.length,
      inspections: inspections.filter((i) => idSet.has(i.pointId)).length,
      rectifies: rectifies.filter((r) => idSet.has(r.pointId)).length,
    };
  }, [selectedPointIds, inspections, rectifies]);

  const handleExport = async () => {
    if (!selectedPointIds.length) {
      message.warning('请先勾选要导出的点位');
      return;
    }
    setExporting(true);
    try {
      const pkg = await exportPackage(selectedPointIds, note.trim() || undefined);
      downloadJson(pkg);
      message.success(`已导出离线包：${selectedPointIds.length} 个点位及相关核验/整改记录`);
    } catch (e) {
      message.error(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  };

  const resolveReviewPlans = (
    preview: MergePreview,
    resolutions: Record<string, Record<string, ConflictChoice>>,
  ) => preview.plans.map((p) => ({ ...p, resolutions: resolutions[p.id] ?? p.resolutions }));

  const conflictPlans = (r: ReviewState): EntityMergePlan[] =>
    resolveReviewPlans(r.preview, r.resolutions).filter((p) => p.fields.some((f) => f.conflict));

  const unresolvedTotal = (r: ReviewState): number =>
    conflictPlans(r).reduce(
      (n, p) => n + p.fields.filter((f) => f.conflict && !p.resolutions[f.field]).length,
      0,
    );

  const choose = (entityId: string, field: string, choice: ConflictChoice) => {
    setReview((cur) => {
      if (!cur) return cur;
      const next: ReviewState = {
        ...cur,
        resolutions: {
          ...cur.resolutions,
          [entityId]: { ...(cur.resolutions[entityId] ?? {}), [field]: choice },
        },
      };
      return next;
    });
  };

  const openPreview = (recordId: string, fileName: string, preview: MergePreview, saved?: ReviewState['resolutions']) => {
    setReview({ recordId, fileName, preview, resolutions: saved ?? {} });
    setTab('import');
  };

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const text = String(reader.result ?? '');
        const pkg = parsePackage(text);
        const res = await intakePackage(pkg, file.name);
        await refreshStaged();
        setImportFileName(file.name);
        setIntakeErrors(res.preflightErrors);
        setIntakeWarnings(res.preflightWarnings);
        if (res.outcome === 'applied-before') {
          message.warning('该回传包此前已应用，本次重复回传已整包跳过，未重复写入');
          setReview(null);
          return;
        }
        if (!res.preview) {
          // 预检失败：整包已留待重试
          message.error('导入预检未通过：整包已原样留存在「暂存与重试」，未写入任何数据');
          setReview(null);
          return;
        }
        openPreview(res.record.id, file.name, res.preview);
        if (res.conflictCount > 0) {
          message.warning(`发现 ${res.conflictCount} 个字段两边都改过，请并排裁决后再应用`);
        } else {
          message.success('预检通过，无冲突；确认后即可应用整包');
        }
      } catch (e) {
        message.error(`离线包解析失败：${e instanceof Error ? e.message : String(e)}`);
      }
    };
    reader.readAsText(file);
    return false; // 阻止 antd 自动上传
  };

  const handleApply = async () => {
    if (!review) return;
    const remaining = unresolvedTotal(review);
    if (remaining > 0) {
      message.warning(`还有 ${remaining} 个冲突字段未裁决`);
      return;
    }
    setApplying(true);
    try {
      await saveResolutions(review.recordId, review.resolutions);
      const result = await applyStaged(review.recordId, review.resolutions);
      await reloadPoints();
      await loadRoutes();
      await refreshStaged();
      Modal.success({
        title: '离线包已合并应用',
        content: (
          <Space direction="vertical" size={4}>
            <Typography.Text>
              点位 {result.applied.points} 条 · 核验 {result.applied.inspections} 条 · 整改{' '}
              {result.applied.rectifies} 条
            </Typography.Text>
            {result.skippedDuplicateInspections > 0 && (
              <Typography.Text type="warning">
                重复核验 {result.skippedDuplicateInspections} 条只补一次，已自动跳过
              </Typography.Text>
            )}
            <Typography.Text type={result.invalidatedSegmentIds.length ? 'danger' : 'secondary'}>
              {result.invalidatedSegmentIds.length
                ? `相关变化已使 ${result.invalidatedSegmentIds.length} 个路线段立即失效并完成重算，旧全线结论已停止展示`
                : '无受影响路线段'}
            </Typography.Text>
          </Space>
        ),
      });
      setReview(null);
      setIntakeErrors([]);
      setIntakeWarnings([]);
    } catch (e) {
      message.error(`应用失败（整包已留待重试，未破坏数据）：${e instanceof Error ? e.message : String(e)}`);
      await refreshStaged();
    } finally {
      setApplying(false);
    }
  };

  const handleContinue = async (rec: PackageRecord) => {
    const preview = await previewStaged(rec.id);
    if (!preview) {
      message.error('暂存包内容缺失');
      return;
    }
    openPreview(rec.id, rec.fileName, preview, rec.resolutions);
  };

  const handleRetry = async (rec: PackageRecord) => {
    try {
      const result = await retryStaged(rec.id);
      await reloadPoints();
      await loadRoutes();
      await refreshStaged();
      message.success(
        `重试成功：点位 ${result.applied.points} / 核验 ${result.applied.inspections} / 整改 ${result.applied.rectifies}；失效路段 ${result.invalidatedSegmentIds.length} 段`,
      );
    } catch (e) {
      message.error(`重试仍未成功，整包继续留存：${e instanceof Error ? e.message : String(e)}`);
      await refreshStaged();
    }
  };

  const pointColumns: ColumnsType<(typeof points)[number]> = [
    { title: '点位编号', dataIndex: 'code', width: 140 },
    { title: '名称', dataIndex: 'name' },
    { title: '设施类型', dataIndex: 'facilityType', width: 130 },
    { title: '行政区', dataIndex: 'district', width: 100 },
    {
      title: '修订号',
      dataIndex: 'rev',
      width: 90,
      render: (v: number) => <Tag>r{v}</Tag>,
    },
  ];

  const stagedColumns: ColumnsType<PackageRecord> = [
    {
      title: '状态',
      dataIndex: 'status',
      width: 160,
      render: (s: PackageRecord['status']) => (
        <Badge status={s === 'applied' ? 'success' : s === 'conflict' ? 'error' : 'warning'} text={STATUS_TEXT[s].text} />
      ),
    },
    { title: '文件', dataIndex: 'fileName', ellipsis: true },
    {
      title: '类型',
      dataIndex: 'kind',
      width: 100,
      render: (k: string) => (k === 'return' ? '回传包' : '下发包'),
    },
    {
      title: '点位',
      dataIndex: 'payload',
      width: 160,
      render: (p: OfflinePackage) =>
        `${p.entities.points.length} 点位 / ${p.entities.inspections.length} 核验 / ${p.entities.rectifies.length} 整改`,
    },
    {
      title: '备注 / 错误',
      width: 240,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          {r.note && <Typography.Text type="secondary">{r.note}</Typography.Text>}
          {r.error && <Typography.Text type="danger" style={{ fontSize: 12 }}>{r.error}</Typography.Text>}
        </Space>
      ),
    },
    {
      title: '操作',
      width: 230,
      render: (_, r) => (
        <Space size={4}>
          {r.status === 'conflict' && (
            <Button size="small" type="primary" ghost onClick={() => handleContinue(r)}>
              继续裁决
            </Button>
          )}
          {r.status !== 'applied' && (
            <Button size="small" icon={<ReloadOutlined />} onClick={() => handleRetry(r)}>
              整包重试
            </Button>
          )}
          <Button
            size="small"
            danger
            onClick={() => {
              modal.confirm({
                title: '放弃该暂存包？',
                content: '删除后需要重新导入原始离线包文件。',
                onOk: async () => {
                  await removeStaged(r.id);
                  await refreshStaged();
                  if (review?.recordId === r.id) setReview(null);
                },
              });
            }}
          >
            放弃
          </Button>
        </Space>
      ),
    },
  ];

  const renderConflictPanel = () => {
    if (!review) {
      return (
        <EmptyState
          title="尚未选择回传包"
          description="选择现场督导员回传的 .json 离线核验包；点位不足时整包自动留待重试，不会写入半截数据"
          compact
        />
      );
    }
    const plans = resolveReviewPlans(review.preview, review.resolutions);
    const creates = plans.filter((p) => p.status === 'create');
    const updates = plans.filter((p) => p.status === 'update');
    const conflicts = conflictPlans(review);
    const remaining = unresolvedTotal(review);
    return (
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message={`回传文件：${review.fileName}`}
          description={
            <Space direction="vertical" size={2}>
              <Typography.Text>
                新建 {creates.length} 条 · 更新 {updates.length + conflicts.length} 条 · 字段冲突{' '}
                {review.preview.conflictCount} 个
                {review.preview.duplicateInspections.length > 0 &&
                  ` · 重复核验 ${review.preview.duplicateInspections.length} 条（只补一次，将跳过）`}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                合并按逐字段修订号进行：只有一侧改过自动并入；两边都改成不同值时以下方并排裁决为准，晚到的一份不会按时间覆盖。
              </Typography.Text>
            </Space>
          }
        />
        {conflicts.length > 0 && (
          <Card
            size="small"
            title={
              <Space>
                <span>并排裁决（两边都改过）</span>
                <Tag color={remaining ? 'red' : 'green'}>
                  {remaining ? `待裁决 ${remaining}` : '已全部裁决'}
                </Tag>
              </Space>
            }
          >
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              {conflicts.map((plan) => {
                const pid =
                  (plan.remote as unknown as { pointId?: string })?.pointId ??
                  (plan.local as unknown as { pointId?: string })?.pointId;
                return (
                  <Card
                    key={plan.id}
                    type="inner"
                    size="small"
                    data-testid={`conflict-${plan.id}`}
                    title={
                      <Space wrap>
                        <Tag color="blue">{KIND_TEXT[plan.kind]}</Tag>
                        <Typography.Text strong>
                          {plan.kind === 'point'
                            ? displayValue(
                                (plan.remote ?? plan.local)?.name,
                              )
                            : `${pointName(pid ?? '')} 的${KIND_TEXT[plan.kind]}`}
                        </Typography.Text>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          id {plan.id}
                        </Typography.Text>
                      </Space>
                    }
                  >
                    <Table
                      rowKey="field"
                      size="small"
                      pagination={false}
                      dataSource={plan.fields.filter((f) => f.conflict)}
                      columns={[
                        { title: '字段', dataIndex: 'label', width: 130 },
                        {
                          title: '基线（导出时）',
                          width: 170,
                          render: (_, f) => (
                            <Typography.Text type="secondary">{displayValue(f.baseValue)}</Typography.Text>
                          ),
                        },
                        {
                          title: '本地（办公室）',
                          width: 200,
                          render: (_, f) => (
                            <Space direction="vertical" size={0}>
                              <Typography.Text
                                strong={plan.resolutions[f.field] === 'local'}
                                type={plan.resolutions[f.field] === 'local' ? 'success' : undefined}
                              >
                                {displayValue(f.localValue)}
                              </Typography.Text>
                              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                                字段修订 r{f.localRev}
                              </Typography.Text>
                            </Space>
                          ),
                        },
                        {
                          title: '现场（回传）',
                          width: 200,
                          render: (_, f) => (
                            <Space direction="vertical" size={0}>
                              <Typography.Text
                                strong={plan.resolutions[f.field] === 'remote'}
                                type={plan.resolutions[f.field] === 'remote' ? 'success' : undefined}
                              >
                                {displayValue(f.remoteValue)}
                              </Typography.Text>
                              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                                字段修订 r{f.remoteRev}
                              </Typography.Text>
                            </Space>
                          ),
                        },
                        {
                          title: '裁决',
                          width: 200,
                          render: (_, f) => (
                            <Radio.Group
                              optionType="button"
                              size="small"
                              value={plan.resolutions[f.field]}
                              onChange={(e) => choose(plan.id, f.field, e.target.value as ConflictChoice)}
                              data-testid={`choose-${plan.id}-${f.field}`}
                              options={[
                                { value: 'local', label: '取本地' },
                                { value: 'remote', label: '取现场' },
                              ]}
                            />
                          ),
                        },
                      ]}
                    />
                  </Card>
                );
              })}
            </Space>
          </Card>
        )}
        {creates.length > 0 && (
          <Card size="small" title={`现场新建（${creates.length}）`}>
            {creates.map((p) => (
              <Tag key={p.id} color="green" style={{ marginBottom: 4 }}>
                {KIND_TEXT[p.kind]}：{displayValue((p.remote as Record<string, unknown>)?.name ?? (p.remote as Record<string, unknown>)?.requirement ?? p.id)}
              </Tag>
            ))}
          </Card>
        )}
        <Space>
          <Button
            type="primary"
            icon={<CloudUploadOutlined />}
            loading={applying}
            disabled={remaining > 0}
            onClick={handleApply}
            data-testid="apply-package"
          >
            {remaining ? `先裁决剩余 ${remaining} 项` : '应用整包合并'}
          </Button>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            应用是单一大事务：任何一步失败整包回滚并继续留存在暂存区，可随时重试且不会重复补录。
          </Typography.Text>
        </Space>
      </Space>
    );
  };

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h1 className="gb-page-title">离线核验包</h1>
          <Typography.Text type="secondary">
            现场督导员断网改、回传后按修订号逐字段合并点位、核验记录与整改条目；冲突并排裁决，路线段随最新结论即时失效重算。
          </Typography.Text>
        </div>
      </div>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'export',
            label: (
              <span>
                <DownloadOutlined /> 导出核验包
              </span>
            ),
            children: (
              <Row gutter={[16, 16]}>
                <Col xs={24} lg={16}>
                  <Card
                    title="选择要下发的点位"
                    size="small"
                    extra={
                      <Space>
                        <Button size="small" onClick={() => setSelectedPointIds(points.map((p) => p.id))}>
                          全选
                        </Button>
                        <Button size="small" onClick={() => setSelectedPointIds([])}>
                          清空
                        </Button>
                      </Space>
                    }
                  >
                    <Table
                      rowKey="id"
                      size="small"
                      pagination={{ pageSize: 8, hideOnSinglePage: true }}
                      dataSource={points}
                      columns={pointColumns}
                      rowSelection={{
                        selectedRowKeys: selectedPointIds,
                        onChange: (keys) => setSelectedPointIds(keys.map(String)),
                      }}
                    />
                  </Card>
                </Col>
                <Col xs={24} lg={8}>
                  <Card title="导出内容" size="small">
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      <Form layout="vertical">
                        <Form.Item label="备注（督导员 / 片区）">
                          <Input
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            placeholder="如：李维 / 东城区东单片区"
                          />
                        </Form.Item>
                      </Form>
                      <Tag color="blue">点位 {statsOf.points}</Tag>
                      <Tag color="cyan">核验记录 {statsOf.inspections}</Tag>
                      <Tag color="orange">整改条目 {statsOf.rectifies}</Tag>
                      <Alert
                        type="info"
                        showIcon
                        style={{ marginTop: 4 }}
                        message="包内含导出时基线快照"
                        description="回传后以基线做三路对比：办公室与现场各自改了哪些字段一目了然，不依赖时间戳定胜负。"
                      />
                      <Button
                        type="primary"
                        icon={<DownloadOutlined />}
                        loading={exporting}
                        onClick={handleExport}
                        data-testid="export-package"
                        block
                      >
                        导出选中点位离线包
                      </Button>
                    </Space>
                  </Card>
                </Col>
              </Row>
            ),
          },
          {
            key: 'import',
            label: (
              <span>
                <InboxOutlined /> 回传导入与裁决
              </span>
            ),
            children: (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <Card size="small">
                  <Space direction="vertical" size={10} style={{ width: '100%' }}>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="application/json,.json"
                      style={{ display: 'none' }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) {
                          void handleFile(f);
                        }
                        e.target.value = '';
                      }}
                    />
                    <Button
                      icon={<InboxOutlined />}
                      type="primary"
                      onClick={() => fileInputRef.current?.click()}
                      data-testid="pick-return-file"
                    >
                      选择回传包文件（.json）
                    </Button>
                    {importFileName && (
                      <Typography.Text type="secondary">
                        当前文件：{importFileName}
                      </Typography.Text>
                    )}
                    {intakeErrors.map((err) => (
                      <Alert key={err} type="error" showIcon message={err} />
                    ))}
                    {intakeWarnings.map((w) => (
                      <Alert key={w} type="warning" showIcon message={w} />
                    ))}
                  </Space>
                </Card>
                {renderConflictPanel()}
              </Space>
            ),
          },
          {
            key: 'staged',
            label: (
              <span>
                <ReloadOutlined /> 暂存与重试{' '}
                {staged.filter((s) => s.status !== 'applied').length > 0 && (
                  <Badge
                    count={staged.filter((s) => s.status !== 'applied').length}
                    size="small"
                    offset={[4, -2]}
                  />
                )}
              </span>
            ),
            children: staged.length ? (
              <Table rowKey="id" size="small" pagination={false} dataSource={staged} columns={stagedColumns} />
            ) : (
              <Empty description="暂无暂存包：导入中断、点位不足或待裁决的整包都会原样留存在这里" />
            ),
          },
          {
            key: 'field',
            label: (
              <span>
                <WifiOutlined /> 现场端断网模拟
              </span>
            ),
            children: <FieldWorkbench onSealed={refreshStaged} />,
          },
        ]}
      />
    </div>
  );
}

/**
 * 现场端断网模拟：读入下发包 → 离线修改点位/核验字段 → 封存为回传包下载。
 * 真实部署中该能力运行在督导员手持设备；此处便于在单设备内演练冲突与去重全链路。
 */
function FieldWorkbench({ onSealed }: { onSealed: () => void }) {
  const { message } = App.useApp();
  const [pkg, setPkg] = useState<OfflinePackage | null>(null);
  const [edited, setEdited] = useState<PackagePayload | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const loadExport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = parsePackage(String(reader.result ?? ''));
        if (parsed.kind !== 'export') throw new Error('请选择导出的下发包');
        setPkg(parsed);
        setEdited(JSON.parse(JSON.stringify(parsed.entities)) as PackagePayload);
        message.success(`已载入下发包：${parsed.entities.points.length} 个点位，可离线修改`);
      } catch (e) {
        message.error(`载入失败：${e instanceof Error ? e.message : String(e)}`);
      }
    };
    reader.readAsText(file);
  };

  const bump = (kind: EntityKind, id: string, field: string, value: unknown) => {
    setEdited((cur) => {
      if (!cur) return cur;
      const key =
        kind === 'point' ? 'points' : kind === 'inspection' ? 'inspections' : 'rectifies';
      const rows = cur[key].map((r) => {
        if (r.id !== id) return r;
        const nextRev = (r.rev ?? 1) + 1;
        return {
          ...r,
          [field]: value,
          rev: nextRev,
          fieldRev: { ...r.fieldRev, [field]: nextRev },
          deviceId: 'field-device',
          syncedAt: new Date().toISOString(),
        };
      });
      return { ...cur, [key]: rows };
    });
  };

  if (!pkg || !edited) {
    return (
      <Card size="small">
        <Space direction="vertical">
          <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) loadExport(f);
              e.target.value = '';
            }}
          />
          <Button icon={<FileSearchOutlined />} type="primary" onClick={() => inputRef.current?.click()}>
            载入导出的下发包
          </Button>
          <Typography.Text type="secondary">
            载入后可模拟断网修改点位属性与核验实测值；保存时会封存为回传包，回到「回传导入与裁决」验证合并。
          </Typography.Text>
        </Space>
      </Card>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert type="info" showIcon message={`已载入下发包 ${pkg.packageId}，以下修改仅存在于本地模拟现场端`} />
      {edited.points.map((p) => (
        <Card key={p.id} size="small" title={`点位 · ${p.name}（r${p.rev}）`}>
          <Row gutter={12}>
            <Col xs={12} md={6}>
              <label className="gb-muted">点位名称</label>
              <Input value={p.name} onChange={(e) => bump('point', p.id, 'name', e.target.value)} />
            </Col>
            <Col xs={12} md={6}>
              <label className="gb-muted">养护单位</label>
              <Input
                value={p.maintainUnit}
                onChange={(e) => bump('point', p.id, 'maintainUnit', e.target.value)}
              />
            </Col>
            <Col xs={12} md={6}>
              <label className="gb-muted">经度</label>
              <InputNumber
                style={{ width: '100%' }}
                value={p.lng}
                onChange={(v) => bump('point', p.id, 'lng', Number(v ?? 0))}
              />
            </Col>
            <Col xs={12} md={6}>
              <label className="gb-muted">纬度</label>
              <InputNumber
                style={{ width: '100%' }}
                value={p.lat}
                onChange={(v) => bump('point', p.id, 'lat', Number(v ?? 0))}
              />
            </Col>
          </Row>
        </Card>
      ))}
      {edited.inspections.map((ins) => (
        <Card
          key={ins.id}
          size="small"
          title={`核验 · ${ins.date} ${ins.inspector}（r${ins.rev}）`}
        >
          <Row gutter={12}>
            <Col xs={12} md={6}>
              <label className="gb-muted">坡度 %</label>
              <InputNumber
                style={{ width: '100%' }}
                value={ins.slope}
                onChange={(v) => {
                  const slope = Number(v ?? 0);
                  bump('inspection', ins.id, 'slope', slope);
                }}
              />
            </Col>
            <Col xs={12} md={6}>
              <label className="gb-muted">净宽 cm</label>
              <InputNumber
                style={{ width: '100%' }}
                value={ins.clearWidth}
                onChange={(v) => bump('inspection', ins.id, 'clearWidth', Number(v ?? 0))}
              />
            </Col>
            <Col xs={12} md={6}>
              <label className="gb-muted">占用情况</label>
              <Select
                style={{ width: '100%' }}
                value={ins.occupied}
                onChange={(v) => bump('inspection', ins.id, 'occupied', v)}
                options={['无', '临时占用', '长期占用'].map((o) => ({ value: o, label: o }))}
              />
            </Col>
            <Col xs={12} md={6}>
              <label className="gb-muted">核验结论</label>
              <Select
                style={{ width: '100%' }}
                value={ins.conclusion}
                onChange={(v) => bump('inspection', ins.id, 'conclusion', v)}
                options={['合格', '限期整改', '不合格'].map((o) => ({ value: o, label: o }))}
              />
            </Col>
          </Row>
        </Card>
      ))}
      <Space>
        <Button
          type="primary"
          icon={<WifiOutlined />}
          onClick={() => {
            const sealed = sealReturnPackage(pkg, edited, 'field-device-demo', '现场断网回传');
            downloadJson(sealed);
            message.success('已封存回传包并下载，可到「回传导入与裁决」页签导入');
            void onSealed();
          }}
          data-testid="seal-return"
        >
          封存回传包并下载
        </Button>
        <Typography.Text type="secondary" className="gb-muted">
          每次修改字段修订号自增，回传后办公室同字段的不同改动将进入并排裁决。
        </Typography.Text>
      </Space>
    </Space>
  );
}
