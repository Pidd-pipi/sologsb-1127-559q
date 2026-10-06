import { useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Divider,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Switch,
  Typography,
} from 'antd';
import { AimOutlined, SaveOutlined, UndoOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import MapPanel from '../components/common/MapPanel';
import MeasureInput from '../components/common/MeasureInput';
import StatusBadge from '../components/common/StatusBadge';
import FacilityIcon from '../components/common/FacilityIcon';
import { useLocalDraft } from '../hooks/useLocalDraft';
import { usePointStore } from '../stores/pointStore';
import {
  DISTRICTS,
  FACILITY_TYPES,
  MAINTAIN_UNITS,
  type AccessPoint,
  type FacilityType,
} from '../types/point';
import { OCCUPIED_LEVELS, type OccupiedLevel } from '../types/inspection';
import { judgeInspection } from '../utils/routeCheck';
import { todayStr } from '../utils/format';

interface PointForm {
  code: string;
  name: string;
  facilityType: FacilityType;
  district: string;
  location: string;
  builtYear: number;
  maintainUnit: string;
  lng: number;
  lat: number;
  withFirstInspection: boolean;
  inspector: string;
  inspectDate: string;
  slope: number;
  clearWidth: number;
  hasHandrail: boolean;
  tactileContinuous: boolean;
  occupied: OccupiedLevel;
  problem: string;
}

function defaultForm(): PointForm {
  const seq = `${Math.floor(Math.random() * 900) + 100}`;
  return {
    code: `WZ-${new Date().getFullYear()}-${seq}`,
    name: '',
    facilityType: '缘石坡道',
    district: '东城区',
    location: '',
    builtYear: new Date().getFullYear() - 5,
    maintainUnit: MAINTAIN_UNITS[0],
    lng: 116.4183,
    lat: 39.9142,
    withFirstInspection: true,
    inspector: '督导员 李维',
    inspectDate: todayStr(),
    slope: 2.5,
    clearWidth: 150,
    hasHandrail: true,
    tactileContinuous: true,
    occupied: '无',
    problem: '',
  };
}

export default function PointNew() {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const { draft, patch, reset, savedAt } = useLocalDraft<PointForm>('point-new', defaultForm());
  const addPoint = usePointStore((s) => s.addPoint);
  const addInspection = usePointStore((s) => s.addInspection);
  const points = usePointStore((s) => s.points);
  const [submitting, setSubmitting] = useState(false);

  const judgement = useMemo(
    () =>
      judgeInspection({
        slope: draft.slope,
        clearWidth: draft.clearWidth,
        hasHandrail: draft.hasHandrail,
        tactileContinuous: draft.tactileContinuous,
        occupied: draft.occupied,
      }),
    [draft.slope, draft.clearWidth, draft.hasHandrail, draft.tactileContinuous, draft.occupied],
  );

  const previewPoints = useMemo<AccessPoint[]>(() => {
    const self: AccessPoint = {
      id: 'draft-point',
      code: draft.code,
      name: draft.name || '待登记点位',
      facilityType: draft.facilityType,
      lng: draft.lng,
      lat: draft.lat,
      district: draft.district,
      location: draft.location,
      builtYear: draft.builtYear,
      maintainUnit: draft.maintainUnit,
      createdAt: '',
      updatedAt: '',
    };
    return [self, ...points];
  }, [draft, points]);

  const handleSubmit = async () => {
    if (!draft.name.trim()) {
      message.warning('请填写点位名称');
      return;
    }
    if (!draft.code.trim()) {
      message.warning('请填写点位编号');
      return;
    }
    if (draft.lng === null || draft.lat === null) {
      message.warning('请在地图上选点或手填经纬度');
      return;
    }
    setSubmitting(true);
    try {
      const point = await addPoint({
        code: draft.code.trim(),
        name: draft.name.trim(),
        facilityType: draft.facilityType,
        district: draft.district,
        location: draft.location.trim(),
        builtYear: draft.builtYear,
        maintainUnit: draft.maintainUnit,
        lng: Number(draft.lng),
        lat: Number(draft.lat),
      });
      if (draft.withFirstInspection) {
        await addInspection({
          pointId: point.id,
          date: draft.inspectDate || todayStr(),
          inspector: draft.inspector.trim() || '未署名督导员',
          slope: draft.slope,
          clearWidth: draft.clearWidth,
          hasHandrail: draft.hasHandrail,
          tactileContinuous: draft.tactileContinuous,
          occupied: draft.occupied,
          conclusion: judgement.conclusion,
          problem: draft.problem.trim(),
        });
      }
      message.success(`点位 ${point.code} 已登记`);
      reset();
      navigate(`/points/${point.id}`);
    } catch (e) {
      message.error(`登记失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h1 className="gb-page-title">点位登记</h1>
          <Typography.Text type="secondary">
            在网格视图上点击取坐标，或直接手填经纬度；可同时录入首次核验实测值。
          </Typography.Text>
        </div>
        <Space>
          <Typography.Text type="secondary" className="gb-muted" data-testid="draft-saved-at">
            {savedAt ? `草稿已存本地 ${savedAt}` : '草稿尚未保存'}
          </Typography.Text>
          <Button icon={<UndoOutlined />} onClick={reset} data-testid="reset-draft">
            清空草稿
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={submitting}
            onClick={handleSubmit}
            data-testid="submit-point"
          >
            保存点位
          </Button>
        </Space>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={13}>
          <Card title="点位属性" size="small">
            <Form layout="vertical">
              <Row gutter={12}>
                <Col span={12}>
                  <Form.Item label="点位编号" required>
                    <Input
                      id="code"
                      value={draft.code}
                      onChange={(e) => patch({ code: e.target.value })}
                      placeholder="如 WZ-2025-101"
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="点位名称" required>
                    <Input
                      id="name"
                      value={draft.name}
                      onChange={(e) => patch({ name: e.target.value })}
                      placeholder="如 东单北大街缘石坡道"
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="设施类型" required>
                    <Select
                      id="facilityType"
                      value={draft.facilityType}
                      onChange={(v) => patch({ facilityType: v })}
                      options={FACILITY_TYPES.map((t) => ({
                        value: t,
                        label: (
                          <Space size={6}>
                            <FacilityIcon type={t} size={16} />
                            {t}
                          </Space>
                        ),
                      }))}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="行政区" required>
                    <Select
                      id="district"
                      value={draft.district}
                      onChange={(v) => patch({ district: v })}
                      options={DISTRICTS.map((d) => ({ value: d, label: d }))}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="所在道路或建筑">
                    <Input
                      id="location"
                      value={draft.location}
                      onChange={(e) => patch({ location: e.target.value })}
                      placeholder="如 东单北大街与灯市口大街交叉口"
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="养护单位" required>
                    <Select
                      id="maintainUnit"
                      value={draft.maintainUnit}
                      onChange={(v) => patch({ maintainUnit: v })}
                      options={MAINTAIN_UNITS.map((u) => ({ value: u, label: u }))}
                    />
                  </Form.Item>
                </Col>
                <Col span={12}>
                  <Form.Item label="建成年代">
                    <InputNumber
                      id="builtYear"
                      min={1950}
                      max={2100}
                      value={draft.builtYear}
                      onChange={(v) => patch({ builtYear: Number(v ?? 2020) })}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item label="经度" required>
                    <InputNumber
                      id="lng"
                      min={-180}
                      max={180}
                      step={0.0001}
                      precision={6}
                      value={draft.lng}
                      onChange={(v) => patch({ lng: Number(v ?? 0) })}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
                <Col span={6}>
                  <Form.Item label="纬度" required>
                    <InputNumber
                      id="lat"
                      min={-90}
                      max={90}
                      step={0.0001}
                      precision={6}
                      value={draft.lat}
                      onChange={(v) => patch({ lat: Number(v ?? 0) })}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
              </Row>
            </Form>
            <Typography.Text type="secondary" className="gb-muted">
              <AimOutlined /> 右侧地图点击即可自动填入经纬度
            </Typography.Text>
          </Card>

          <Card
            title="首次核验（选填）"
            size="small"
            style={{ marginTop: 16 }}
            extra={
              <Switch
                checked={draft.withFirstInspection}
                onChange={(v) => patch({ withFirstInspection: v })}
                checkedChildren="录入"
                unCheckedChildren="跳过"
                data-testid="toggle-first-inspection"
              />
            }
          >
            {draft.withFirstInspection ? (
              <Row gutter={[12, 4]}>
                <Col xs={24} md={12}>
                  <MeasureInput
                    label="坡度"
                    value={draft.slope}
                    onChange={(v) => patch({ slope: v })}
                    unit="%"
                    pass={5}
                    fail={8}
                    direction="max"
                    min={0}
                    max={100}
                    step={0.1}
                    hint="轮椅坡道纵坡不应大于 5%，超过 8% 判定不合格"
                  />
                </Col>
                <Col xs={24} md={12}>
                  <MeasureInput
                    label="净宽"
                    value={draft.clearWidth}
                    onChange={(v) => patch({ clearWidth: v })}
                    unit="cm"
                    pass={120}
                    fail={90}
                    direction="min"
                    min={0}
                    max={500}
                    step={1}
                    hint="通行净宽不应小于 120cm，小于 90cm 判定不合格"
                  />
                </Col>
                <Col xs={24}>
                  <Divider style={{ margin: '10px 0' }} />
                </Col>
                <Col xs={12} md={6}>
                  <Form.Item label="扶手">
                    <Switch
                      checked={draft.hasHandrail}
                      onChange={(v) => patch({ hasHandrail: v })}
                      checkedChildren="有"
                      unCheckedChildren="无"
                      data-testid="switch-handrail"
                    />
                  </Form.Item>
                </Col>
                <Col xs={12} md={6}>
                  <Form.Item label="盲道连续">
                    <Switch
                      checked={draft.tactileContinuous}
                      onChange={(v) => patch({ tactileContinuous: v })}
                      checkedChildren="连续"
                      unCheckedChildren="断续"
                      data-testid="switch-tactile"
                    />
                  </Form.Item>
                </Col>
                <Col xs={12} md={6}>
                  <Form.Item label="被占用情况">
                    <Select
                      id="occupied"
                      value={draft.occupied}
                      onChange={(v) => patch({ occupied: v })}
                      options={OCCUPIED_LEVELS.map((o) => ({ value: o, label: o }))}
                    />
                  </Form.Item>
                </Col>
                <Col xs={12} md={6}>
                  <Form.Item label="核验日期">
                    <DatePicker
                      value={draft.inspectDate ? dayjs(draft.inspectDate) : null}
                      onChange={(d) => patch({ inspectDate: d ? d.format('YYYY-MM-DD') : todayStr() })}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label="核验人">
                    <Input
                      id="inspector"
                      value={draft.inspector}
                      onChange={(e) => patch({ inspector: e.target.value })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label="结论建议（按实测值自动判定）">
                    <Space data-testid="suggested-conclusion">
                      <StatusBadge value={judgement.conclusion} kind="conclusion" bordered />
                      <Typography.Text type="secondary" className="gb-muted">
                        {judgement.reasons[0]}
                      </Typography.Text>
                    </Space>
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item label="问题描述">
                    <Input.TextArea
                      id="problem"
                      rows={2}
                      value={draft.problem}
                      onChange={(e) => patch({ problem: e.target.value })}
                      placeholder="记录盲道断点、占用情况、需整改事项等"
                    />
                  </Form.Item>
                </Col>
              </Row>
            ) : (
              <Typography.Text type="secondary">已跳过首次核验，可在点位详情页随时补录。</Typography.Text>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={11}>
          <MapPanel
            points={previewPoints}
            selectedId="draft-point"
            onSelect={() => undefined}
            onPick={(lngLat) => patch({ lng: lngLat.lng, lat: lngLat.lat })}
            height={420}
            title="选点定位（点击网格取坐标）"
          />
          <Card size="small" style={{ marginTop: 16 }} title="登记预览">
            <Space direction="vertical" size={6}>
              <Space size={8}>
                <FacilityIcon type={draft.facilityType} withLabel />
                <Typography.Text strong>{draft.name || '（未填写名称）'}</Typography.Text>
              </Space>
              <Typography.Text type="secondary" className="gb-muted">
                {draft.code} · {draft.district} · {draft.location || '未填写所在道路或建筑'}
              </Typography.Text>
              <Typography.Text type="secondary" className="gb-muted" data-testid="coord-preview">
                经度 {Number(draft.lng).toFixed(6)} / 纬度 {Number(draft.lat).toFixed(6)}
              </Typography.Text>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
