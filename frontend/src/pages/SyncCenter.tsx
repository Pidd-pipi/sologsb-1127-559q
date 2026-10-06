import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Modal,
  Radio,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { UploadRequestOption } from 'rc-upload/lib/interface';
import {
  CloudUploadOutlined,
  DownloadOutlined,
  FileSearchOutlined,
  RetweetOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import EmptyState from '../components/common/EmptyState';
import StatusBadge from '../components/common/StatusBadge';
import { usePointStore } from '../stores/pointStore';
import { useRouteStore } from '../stores/routeStore';
import { useSyncInbox } from '../hooks/useSyncInbox';
import { downloadPackage, exportOfflinePackage } from '../sync/package';
import {
  applyPackage,
  enqueueInbound,
  ignoreInbound,
  parsePackage,
  previewPackage,
  retryInbound,
} from '../sync/syncService';
import { FIELD_LABELS } from '../sync/fields';
import { unresolvedConflicts } from '../sync/package';
import type { AccessPoint } from '../types/point';
import type { FieldConflict, InboundPackage, MergeOutcome, OfflinePackage } from '../types/sync';

function fmtValue(v: unknown): string {
  if (v === '' || v === undefined || v === null) return '—';
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}

export default function SyncCenter() {
  const { message } = App.useApp();
  const points = usePointStore((s) => s.points);
  const inspectionsAll = usePointStore((s) => s.inspections);
  const rectifiesAll = usePointStore((s) => s.rectifies);
  const loadPoints = usePointStore((s) => s.load);
  const loadRoutes = useRouteStore((s) => s.load);
  const { inbox, ledger, loading, refresh } = useSyncInbox();

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState(false);

  const [preview, setPreview] = useState<{ pkg: OfflinePackage; outcome: MergeOutcome } | null>(null);
  const [adjudication, setAdjudication] = useState<Record<string, 'local' | 'remote'>>({});
  const [importError, setImportError] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);

  const pointColumns: ColumnsType<AccessPoint> = [
    { title: '点位编号', dataIndex: 'code', width: 140 },
    { title: '名称', dataIndex: 'name' },
    { title: '行政区', dataIndex: 'district', width: 100 },
    { title: '养护单位', dataIndex: 'maintainUnit', width: 180 },
  ];

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const relatedCounts = useMemo(() => {
    const map = new Map<string, { insp: number; rect: number }>();
    for (const i of inspectionsAll)
      map.set(i.pointId, { insp: (map.get(i.pointId)?.insp ?? 0) + 1, rect: map.get(i.pointId)?.rect ?? 0 });
    for (const r of rectifiesAll)
      map.set(r.pointId, { insp: map.get(r.pointId)?.insp ?? 0, rect: (map.get(r.pointId)?.rect ?? 0) + 1 });
    return map;
  }, [inspectionsAll, rectifiesAll]);

  const handleExport = async () => {
    if (!selectedIds.length) {
      message.warning('请先勾选要带给现场督导员的点位');
      return;
    }
    setExporting(true);
    try {
      const pkg = await exportOfflinePackage({ pointIds: selectedIds, exportedBy: '内业值班席' });
      downloadPackage(pkg);
      message.success(`已导出 ${selectedIds.length} 个点位的离线核验包（${pkg.packageId}）`);
    } catch (e) {
      message.error(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  };

  const readFile = async (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'));
      reader.readAsText(file);
    });

  const beforeUpload = async (option: UploadRequestOption): Promise<void> => {
    const file = option.file as File;
    setImportError('');
    try {
      const text = await readFile(file);
      const pkg = parsePackage(text);
      // 已应用过的核验包：同一核验重复回传只补一次，整包不再写入
      const existed = ledger.find((l) => l.id === pkg.packageId);
      if (existed) {
        message.info(`核验包 ${pkg.packageId} 已应用过，重复回传不会重复补录`);
        return;
      }
      const outcome = await previewPackage(pkg, adjudication);
      if (outcome.missingPointIds.length) {
        await enqueueInbound(pkg, '待重试', `点位不足，缺少 ${outcome.missingPointIds.join('、')}`);
        message.warning(`点位不足（${outcome.missingPointIds.join('、')}），整包已留待重试，暂不写入`);
        await refresh();
        return;
      }
      setPreview({ pkg, outcome });
      setAdjudication({});
      setPendingId(null);
    } catch (e) {
      setImportError(e instanceof Error ? e.message : String(e));
    }
  };

  const unresolved = preview ? unresolvedConflicts(preview.outcome.conflicts, adjudication) : [];

  // 裁决选项变化后重新预检：未裁决实体始终保持「不落库」
  useEffect(() => {
    if (!preview) return;
    let cancelled = false;
    void previewPackage(preview.pkg, adjudication).then((outcome) => {
      if (!cancelled) setPreview({ pkg: preview.pkg, outcome });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adjudication, preview?.pkg.packageId]);

  const handleApply = async () => {
    if (!preview) return;
    if (unresolved.length) {
      message.warning('还有字段未完成并排裁决');
      return;
    }
    setBusy(true);
    try {
      await applyPackage(preview.pkg, adjudication);
      message.success('核验包已合入：点位、核验记录、整改条目按修订号逐字段合并，路线段已失效重算');
      setPreview(null);
      setAdjudication({});
      await loadPoints();
      await loadRoutes();
      await refresh();
    } catch (e) {
      message.error(`导入中断，整包已留待重试：${e instanceof Error ? e.message : String(e)}`);
      setPreview(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const conflictColumns: ColumnsType<FieldConflict> = [
    {
      title: '记录',
      dataIndex: 'entityLabel',
      width: 200,
    },
    {
      title: '字段',
      dataIndex: 'field',
      width: 130,
      render: (f: string, row) => FIELD_LABELS[row.kind][f] ?? f,
    },
    {
      title: '基线（导出时）',
      dataIndex: 'baseValue',
      width: 140,
      render: (v: unknown) => (v === undefined ? '—' : fmtValue(v)),
    },
    {
      title: '本机值',
      dataIndex: 'localValue',
      render: (v: unknown) => <Typography.Text strong>{fmtValue(v)}</Typography.Text>,
    },
    {
      title: '现场值（晚到）',
      dataIndex: 'remoteValue',
      render: (v: unknown) => <Typography.Text type="warning">{fmtValue(v)}</Typography.Text>,
    },
    {
      title: '裁决',
      width: 200,
      render: (_, row) => (
        <Radio.Group
          size="small"
          value={adjudication[row.key]}
          onChange={(e) => setAdjudication((cur) => ({ ...cur, [row.key]: e.target.value }))}
        >
          <Radio.Button value="local">保留本机</Radio.Button>
          <Radio.Button value="remote">采用现场</Radio.Button>
        </Radio.Group>
      ),
    },
  ];

  const inboxColumns: ColumnsType<InboundPackage> = [
    { title: '核验包', dataIndex: 'id', width: 220, render: (v: string) => <code>{v}</code> },
    { title: '督导员', render: (_, row) => row.payload.exportedBy, width: 130 },
    { title: '导出时间', dataIndex: 'payload.exportedAt', width: 190, render: (_, row) => row.payload.exportedAt.replace('T', ' ').slice(0, 19) },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: string) =>
        v === '待重试' ? (
          <Tag icon={<WarningOutlined />} color="error">
            待重试
          </Tag>
        ) : v === '待裁决' ? (
          <Tag color="processing">待裁决</Tag>
        ) : v === '已忽略' ? (
          <Tag>已忽略</Tag>
        ) : (
          <StatusBadge value="已整改" kind="rectify" />
        ),
    },
    { title: '原因', dataIndex: 'error', ellipsis: true },
    {
      title: '尝试次数',
      dataIndex: 'attempts',
      width: 90,
    },
    {
      title: '操作',
      width: 200,
      render: (_, row) => (
        <Space size={4}>
          <Button
            size="small"
            type="primary"
            ghost
            icon={<RetweetOutlined />}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                if (row.status === '待裁决') {
                  const outcome = await previewPackage(row.payload, {});
                  setPreview({ pkg: row.payload, outcome });
                  setPendingId(row.id);
                  return;
                }
                await retryInbound(row.id, {});
                message.success('已重试导入');
                await loadPoints();
                await loadRoutes();
                await refresh();
              } catch (e) {
                message.error(`重试失败，整包继续留待：${e instanceof Error ? e.message : String(e)}`);
                await refresh();
              } finally {
                setBusy(false);
              }
            }}
            data-testid={`retry-inbound-${row.id}`}
          >
            {row.status === '待裁决' ? '打开裁决' : '重试'}
          </Button>
          <Button size="small" onClick={() => ignoreInbound(row.id).then(refresh)}>
            忽略
          </Button>
        </Space>
      ),
    },
  ];

  const outcome = preview?.outcome;
  const counter = (c?: MergeOutcome['points']) =>
    c ? (
      <Space size={4}>
        <Tag color="blue">新增 {c.added}</Tag>
        <Tag color="green">更新 {c.updated}</Tag>
        <Tag>跳过 {c.skipped}</Tag>
      </Space>
    ) : null;

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h1 className="gb-page-title">离线核验包</h1>
          <Typography.Text type="secondary">
            督导员断网修改点位、核验与整改，回传后按修订号逐字段合并；两边都改的字段并排裁决，晚到的一份不覆盖。
          </Typography.Text>
        </div>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={13}>
          <Card
            title="① 选择点位导出"
            size="small"
            extra={
              <Space>
                <Typography.Text type="secondary">已选 {selectedIds.length}</Typography.Text>
                <Button
                  type="primary"
                  icon={<DownloadOutlined />}
                  loading={exporting}
                  onClick={handleExport}
                  data-testid="export-package"
                >
                  导出核验包
                </Button>
              </Space>
            }
          >
            <Table<AccessPoint>
              rowKey="id"
              size="small"
              pagination={{ pageSize: 6 }}
              dataSource={points}
              columns={[
                ...pointColumns,
                {
                  title: '相关记录',
                  width: 140,
                  render: (_, row) => {
                    const c = relatedCounts.get(row.id);
                    return (
                      <Space size={4}>
                        <Tag>核验 {c?.insp ?? 0}</Tag>
                        <Tag>整改 {c?.rect ?? 0}</Tag>
                      </Space>
                    );
                  },
                },
              ]}
              rowSelection={{
                selectedRowKeys: selectedIds,
                onChange: (keys) => setSelectedIds(keys.map(String)),
              }}
            />
            <Typography.Paragraph type="secondary" className="gb-muted" style={{ marginTop: 8, marginBottom: 0 }}>
              核验包自动附带选中点位的核验记录、整改条目，以及与这些点位相邻的路线段。
            </Typography.Paragraph>
          </Card>
        </Col>

        <Col xs={24} lg={11}>
          <Card title="② 回传导入" size="small">
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Upload.Dragger
                accept=".json,.gbapkg"
                maxCount={1}
                showUploadList={false}
                customRequest={(opt) => {
                  void beforeUpload(opt);
                }}
                data-testid="import-package"
              >
                <p className="ant-upload-drag-icon">
                  <CloudUploadOutlined />
                </p>
                <p className="ant-upload-text">点击或拖入督导员回传的 .gbapkg.json 核验包</p>
                <p className="ant-upload-hint">
                  导入先预检：点位不足整包留待重试、不写半批；字段冲突需逐字段并排裁决
                </p>
              </Upload.Dragger>
              {importError ? <Alert type="error" showIcon message={importError} /> : null}
              {outcome ? (
                <Card size="small" title="合并预检结果（尚未写入）" data-testid="merge-preview">
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    <div>点位 {counter(outcome.points)}</div>
                    <div>核验记录 {counter(outcome.inspections)}</div>
                    <div>整改条目 {counter(outcome.rectifies)}</div>
                    <div>路线段 {counter(outcome.routes)}</div>
                    {outcome.conflicts.length ? (
                      <Alert
                        type="warning"
                        showIcon
                        message={`${outcome.conflicts.length} 个字段两边都改过，需要并排裁决`}
                      />
                    ) : (
                      <Alert type="success" showIcon message="无字段冲突，可直接合入" />
                    )}
                    <Space>
                      <Button
                        type="primary"
                        loading={busy}
                        disabled={unresolved.length > 0}
                        onClick={handleApply}
                        data-testid="apply-package"
                      >
                        {pendingId ? '裁决后合入' : '确认合入'}
                      </Button>
                      <Button
                        onClick={async () => {
                          if (preview) {
                            await enqueueInbound(
                              preview.pkg,
                              unresolved.length ? '待裁决' : '待重试',
                              unresolved.length ? '等待字段裁决' : '用户暂缓',
                            );
                            await refresh();
                          }
                          setPreview(null);
                          setPendingId(null);
                        }}
                      >
                        先留待处理
                      </Button>
                      <Button onClick={() => setPreview(null)}>取消</Button>
                    </Space>
                  </Space>
                </Card>
              ) : null}
            </Space>
          </Card>

          <Card
            title={
              <Space>
                <FileSearchOutlined />
                <span>③ 收件箱</span>
                <Badge count={inbox.filter((i) => i.status === '待重试' || i.status === '待裁决').length} />
              </Space>
            }
            size="small"
            style={{ marginTop: 16 }}
          >
            {loading ? (
              <Empty description="读取中…" />
            ) : inbox.length ? (
              <Table<InboundPackage>
                rowKey="id"
                size="small"
                pagination={{ pageSize: 5 }}
                dataSource={inbox}
                columns={inboxColumns}
              />
            ) : (
              <EmptyState title="收件箱为空" description="导入中断、点位不足或待裁决的核验包会留在这里" compact />
            )}
          </Card>

          <Card title="已应用核验包" size="small" style={{ marginTop: 16 }}>
            {ledger.length ? (
              <Space direction="vertical" size={4}>
                {ledger.slice(0, 5).map((l) => (
                  <Space key={l.id} size={8}>
                    <code>{l.id.slice(0, 16)}…</code>
                    <Tag>{l.exportedBy}</Tag>
                    <Typography.Text type="secondary">{l.appliedAt.replace('T', ' ').slice(0, 19)}</Typography.Text>
                  </Space>
                ))}
              </Space>
            ) : (
              <EmptyState title="尚无已应用核验包" compact />
            )}
          </Card>
        </Col>
      </Row>

      <Card size="small" style={{ marginTop: 16 }}>
        <Row gutter={16}>
          <Col span={6}>
            <Statistic title="待重试包" value={inbox.filter((i) => i.status === '待重试').length} />
          </Col>
          <Col span={6}>
            <Statistic title="待裁决包" value={inbox.filter((i) => i.status === '待裁决').length} />
          </Col>
          <Col span={6}>
            <Statistic title="已应用包" value={ledger.length} />
          </Col>
          <Col span={6}>
            <Statistic title="选中点位" value={selectedSet.size} />
          </Col>
        </Row>
      </Card>

      <Modal
        title="字段冲突并排裁决"
        open={Boolean(preview && preview.outcome.conflicts.length)}
        width={960}
        onCancel={() => {
          setPreview(null);
          setPendingId(null);
        }}
        footer={[
          <Button
            key="cancel"
            onClick={() => {
              setPreview(null);
              setPendingId(null);
            }}
          >
            取消
          </Button>,
          <Button
            key="ok"
            type="primary"
            disabled={unresolved.length > 0}
            loading={busy}
            onClick={handleApply}
            data-testid="resolve-apply"
          >
            完成裁决并合入（剩 {unresolved.length} 项）
          </Button>,
        ]}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="两边都改过的字段不会让晚到的现场值直接覆盖；请逐项选择保留本机值或采用现场值。"
        />
        {preview ? (
          <Table<FieldConflict>
            rowKey="key"
            size="small"
            pagination={false}
            dataSource={preview.outcome.conflicts}
            columns={conflictColumns}
          />
        ) : null}
      </Modal>
    </div>
  );
}
