import { InputNumber, Space, Tooltip, Typography } from 'antd';
import { WarningOutlined, CheckCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons';

export type ThresholdDirection = 'max' | 'min';

interface MeasureInputProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  unit: string;
  /** 推荐值：max 方向为上限，min 方向为下限 */
  pass: number;
  /** 不合格界：max 方向为硬上限，min 方向为硬下限 */
  fail: number;
  direction?: ThresholdDirection;
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
}

/**
 * 带单位、阈值提示与越界警告的实测值录入框。
 * 越界只做提示，不阻断录入（核验员需要如实记录超限值）。
 */
export default function MeasureInput({
  label,
  value,
  onChange,
  unit,
  pass,
  fail,
  direction = 'max',
  min = 0,
  max = 9999,
  step = 0.1,
  hint,
}: MeasureInputProps) {
  const num = Number(value);
  const overFail = direction === 'max' ? num > fail : num < fail;
  const overPass = direction === 'max' ? num > pass : num < pass;

  const state = overFail
    ? { color: '#cf1322', icon: <WarningOutlined />, text: `越界：${direction === 'max' ? `不得大于 ${fail}` : `不得小于 ${fail}`}${unit}` }
    : overPass
      ? { color: '#d46b08', icon: <ExclamationCircleOutlined />, text: `超出推荐值（${direction === 'max' ? `≤ ${pass}` : `≥ ${pass}`}${unit}）` }
      : { color: '#389e0d', icon: <CheckCircleOutlined />, text: '符合推荐值' };

  return (
    <div data-testid={`measure-${label}`} style={{ width: '100%' }}>
      <Space direction="vertical" size={2} style={{ width: '100%' }}>
        <Space size={6} align="center">
          <Typography.Text>{label}</Typography.Text>
          <Tooltip title={hint || `推荐值 ${direction === 'max' ? '≤' : '≥'} ${pass}${unit}，不合格界 ${direction === 'max' ? '>' : '<'} ${fail}${unit}`}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              (推荐 {direction === 'max' ? '≤' : '≥'} {pass}
              {unit})
            </Typography.Text>
          </Tooltip>
        </Space>
        <Space size={8} align="center" style={{ width: '100%' }}>
          <InputNumber
            aria-label={label}
            value={Number.isFinite(num) ? num : 0}
            min={min}
            max={max}
            step={step}
            onChange={(v) => onChange(Number(v ?? 0))}
            style={{ width: 140 }}
            addonAfter={unit}
          />
          <Typography.Text style={{ color: state.color, fontSize: 12 }} data-testid={`measure-state-${label}`}>
            {state.icon} {state.text}
          </Typography.Text>
        </Space>
      </Space>
    </div>
  );
}
