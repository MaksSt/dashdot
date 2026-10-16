import {
  type Config,
  HISTORY_RETENTION_MS,
  type HistoryMetric,
  type HistoryPoint,
  type OsInfo,
} from '@dashdot/common';
import { theme as antdTheme, ConfigProvider, DatePicker } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import {
  type FC,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Area,
  Brush,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Socket } from 'socket.io-client';
import styled, { createGlobalStyle, useTheme } from 'styled-components';
import { useHistory } from '../services/history';

const HOUR = 3_600_000;
const MIN_WINDOW = 60_000;
const periods = [
  ['15m', HOUR / 4],
  ['1h', HOUR],
  ['6h', 6 * HOUR],
  ['12h', 12 * HOUR],
  ['24h', HISTORY_RETENTION_MS],
] as const;
type Window = { from: number; to: number };
type Series = {
  key: HistoryMetric | 'ramPercent';
  name: string;
  color: string;
};
type PlotPoint = HistoryPoint & { ramPercent: number | null };

const Dashboard = styled.main`
  width: 100%; min-width: 0; color: ${({ theme }) => theme.colors.text};
  display: flex; flex-direction: column; gap: 24px; line-height: 1.5;
  h1 { font-size: clamp(26px, 3vw, 36px); font-weight: 650; letter-spacing: -0.04em; }
  h2 { font-size: 18px; font-weight: 600; }
  p { font-size: 13px; }
  .recharts-surface:focus:not(:focus-visible),
  .recharts-wrapper:focus:not(:focus-visible) { outline: none; }
  .recharts-surface:focus-visible,
  .recharts-wrapper:focus-visible {
    outline: 2px solid ${({ theme }) => theme.colors.text}; outline-offset: -2px;
  }
`;
const Eyebrow = styled.p`
  text-transform: uppercase; letter-spacing: 0.15em; font-size: 11px !important; font-weight: 650;
`;
const Muted = styled.p`opacity: 0.8;`;
const SystemHeader = styled.header`
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px 32px;
  h1 { font-size: clamp(23px, 3vw, 32px); margin-top: 4px; overflow-wrap: anywhere; }
`;
const SystemDetails = styled.dl`
  display: flex; flex-wrap: wrap; gap: 12px 32px;
  dt { font-size: 11px; opacity: 0.8; margin-bottom: 4px; }
  dd { margin: 0; font-size: 14px; font-weight: 550; font-variant-numeric: tabular-nums; }
`;
const Toolbar = styled.div`
  display: flex; flex-wrap: wrap; gap: 16px; align-items: center; justify-content: space-between;
`;
const Controls = styled.div`
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
`;
const Control = styled.button<{ $active?: boolean }>`
  min-width: 42px; min-height: 40px; padding: 7px 13px;
  border-radius: 10px; border: 1px solid ${({ theme }) => theme.colors.text}55;
  color: ${({ theme }) => theme.colors.text};
  background: ${({ theme, $active }) => ($active ? `${theme.colors.text}22` : `${theme.colors.surface}dd`)};
  font: inherit; font-size: 13px; font-weight: 550; cursor: pointer;
  &:hover:not(:disabled) { background: ${({ theme }) => theme.colors.text}22; }
  &:disabled { opacity: 0.45; cursor: default; }
  &:focus-visible { outline: 2px solid ${({ theme }) => theme.colors.text}; outline-offset: 3px; }
  @media (max-width: 749px) { min-height: 44px; }
`;
const Grid = styled.div`
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px;
  @media (max-width: 1050px) { grid-template-columns: minmax(0, 1fr); }
`;
const Card = styled.section`
  min-width: 0; border: 1px solid ${({ theme }) => theme.colors.text}33;
  background: ${({ theme }) => theme.colors.surface}dd; backdrop-filter: blur(20px);
  border-radius: 22px; padding: 22px 22px 12px;
  @media (max-width: 749px) { padding: 18px 12px 10px; border-radius: 18px; }
`;
const CardHeader = styled.header`
  display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; justify-content: space-between;
  margin-bottom: 14px;
`;
const Values = styled.div`
  display: flex; flex-wrap: wrap; gap: 14px; font-size: 13px;
  span { display: inline-flex; gap: 7px; align-items: center; }
  i { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  b { font-weight: 600; font-variant-numeric: tabular-nums; }
`;
const PlotFrame = styled.div`
  height: 235px; width: 100%; position: relative; user-select: none;
  @media (max-width: 749px) { height: 215px; }
`;
const Empty = styled.div`
  position: absolute; inset: 20px 40px 40px 55px; display: grid; place-items: center;
  text-align: center; font-size: 13px; pointer-events: none;
`;
const TooltipBox = styled.div`
  background: ${({ theme }) => theme.colors.surface}; color: ${({ theme }) => theme.colors.text};
  border: 1px solid ${({ theme }) => theme.colors.text}66; border-radius: 10px; padding: 10px 13px;
  font-size: 12px; line-height: 1.8; box-shadow: 0 6px 22px #0003;
`;
const Notice = styled.p`
  padding: 12px 16px; border: 1px solid ${({ theme }) => theme.colors.text}44;
  border-radius: 12px; background: ${({ theme }) => theme.colors.surface}cc;
`;
const RangeFields = styled.div`
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)) auto;
  align-items: end; gap: 12px; max-width: 780px; margin: 18px 0 8px;
  > button { min-height: 46px; padding-inline: 20px; }
  @media (max-width: 649px) { grid-template-columns: minmax(0, 1fr); }
`;
const DateField = styled.label`
  display: flex; flex-direction: column; gap: 7px; min-width: 0;
  > span { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; opacity: 0.8; }
`;
const RangeInput = styled(DatePicker<Dayjs>)`
  width: 100%; min-height: 46px; padding: 10px 13px;
  background: ${({ theme }) => theme.colors.text}06;
  border-color: ${({ theme }) => `${theme.colors.text}${theme.dark ? '66' : '99'}`};
  input { font-variant-numeric: tabular-nums; }
  &:focus-within { outline: 2px solid ${({ theme }) => theme.colors.text}; outline-offset: 2px; }
  @media (max-width: 749px) { input { font-size: 16px; } }
`;
const CalendarStyle = createGlobalStyle`
  .history-date-popup .ant-picker-header button { min-width: 32px; }
  @media (max-width: 649px) {
    .history-date-popup .ant-picker-datetime-panel { flex-direction: column; }
    .history-date-popup .ant-picker-time-panel {
      width: 100%; border-inline-start: 0;
      border-top: 1px solid ${({ theme }) => theme.colors.text}33;
    }
    .history-date-popup .ant-picker-time-panel .ant-picker-content { height: 132px; }
    .history-date-popup .ant-picker-time-panel-column { flex: 1; }
  }
`;
const timeLabel = (time: number, long = false) =>
  new Date(time).toLocaleString(
    undefined,
    long
      ? {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }
      : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  );
const localInput = (time: number) => {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
};
const parseRangeDate = (value: FormDataEntryValue | null) => {
  const match = String(value).match(
    /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/,
  );
  return match
    ? new Date(
        `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}`,
      ).getTime()
    : Number.NaN;
};
const toPlot = (points: HistoryPoint[]): PlotPoint[] =>
  points.map((point) => ({
    ...point,
    ramPercent:
      point.ramUsed !== null && point.ramTotal
        ? Math.min(100, (point.ramUsed / point.ramTotal) * 100)
        : null,
  }));

const HistoryPlot: FC<{
  title: string;
  description: string;
  points: PlotPoint[];
  series: Series[];
  window: Window;
  unit: string;
  format: (value: number) => string;
  domain?: [number, number | 'auto'];
  onWindow: (window: Window) => void;
  onZoom: (factor: number, anchor?: number) => void;
  onReset: () => void;
}> = ({
  title,
  description,
  points,
  series,
  window,
  unit,
  format,
  domain,
  onWindow,
  onZoom,
  onReset,
}) => {
  const theme = useTheme();
  const frame = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ start: number; end: number }>();
  const last = points.at(-1);
  const hasData = points.some((point) =>
    series.some(({ key }) => point[key] !== null),
  );
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const fraction = Math.max(
        0,
        Math.min(
          1,
          (event.clientX - box.left - 48) / Math.max(1, box.width - 65),
        ),
      );
      onZoom(
        event.deltaY > 0 ? 1.5 : 1 / 1.5,
        window.from + fraction * (window.to - window.from),
      );
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [onZoom, window]);
  return (
    <Card aria-label={`${title} history`}>
      <CardHeader>
        <h2>{title}</h2>
        <Values>
          {series.map(({ key, name, color }) => (
            <span key={key}>
              <i style={{ background: color }} aria-hidden="true" />
              {name}
              <b>{last?.[key] == null ? '—' : format(last[key])}</b>
            </span>
          ))}
        </Values>
      </CardHeader>
      <PlotFrame ref={frame}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={points}
            syncId="history"
            syncMethod="value"
            margin={{ top: 10, right: 10, bottom: 0, left: 0 }}
            accessibilityLayer
            onMouseDown={(event) => {
              if (typeof event.activeLabel === 'number')
                setDrag({ start: event.activeLabel, end: event.activeLabel });
            }}
            onMouseMove={(event) => {
              if (drag && typeof event.activeLabel === 'number')
                setDrag({ ...drag, end: event.activeLabel });
            }}
            onMouseUp={() => {
              if (drag && Math.abs(drag.end - drag.start) >= MIN_WINDOW)
                onWindow({
                  from: Math.min(drag.start, drag.end),
                  to: Math.max(drag.start, drag.end),
                });
              setDrag(undefined);
            }}
            onMouseLeave={() => setDrag(undefined)}
            onDoubleClick={onReset}
          >
            <CartesianGrid stroke={`${theme.colors.text}18`} vertical={false} />
            <XAxis
              dataKey="time"
              type="number"
              scale="time"
              domain={[window.from, window.to]}
              allowDataOverflow
              tickFormatter={(value: number) =>
                timeLabel(value, window.to - window.from > 24 * HOUR)
              }
              tick={{ fill: theme.colors.text, fontSize: 11 }}
              stroke={`${theme.colors.text}44`}
              minTickGap={45}
              tickLine={false}
            />
            <YAxis
              width={48}
              domain={domain ?? [0, 'auto']}
              tickFormatter={(value: number) => `${Number(value.toFixed(1))}`}
              tick={{ fill: theme.colors.text, fontSize: 11 }}
              stroke="transparent"
              tickLine={false}
              unit={unit}
            />
            <Tooltip
              isAnimationActive={false}
              content={({ active, payload, label }) =>
                active && payload?.length ? (
                  <TooltipBox>
                    <div>{timeLabel(Number(label), true)}</div>
                    {payload.map((entry) => (
                      <div key={String(entry.dataKey)}>
                        {entry.name}:{' '}
                        <b>
                          {entry.value == null
                            ? '—'
                            : format(Number(entry.value))}
                        </b>
                      </div>
                    ))}
                  </TooltipBox>
                ) : null
              }
            />
            {series.map(({ key, name, color }) => (
              <Line
                key={key}
                dataKey={key}
                name={name}
                type="linear"
                stroke={color}
                strokeWidth={2}
                dot={points.length < 3}
                activeDot={{ r: 4 }}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}
            {drag && (
              <ReferenceArea
                x1={Math.min(drag.start, drag.end)}
                x2={Math.max(drag.start, drag.end)}
                fill={theme.colors.text}
                fillOpacity={0.12}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
        {!hasData && (
          <Empty>
            No readings in this time range.
            <br />
            {description}
          </Empty>
        )}
      </PlotFrame>
    </Card>
  );
};

export const AdvancedDashboard: FC<{
  config: Config;
  socket: Socket | undefined;
  os: OsInfo | undefined;
}> = ({ config, socket, os }) => {
  const theme = useTheme();
  const [window, setWindow] = useState<Window>(() => ({
    from: Date.now() - HOUR,
    to: Date.now(),
  }));
  const [live, setLive] = useState(true);
  const [preset, setPreset] = useState<number>(HOUR);
  const [overviewEnd, setOverviewEnd] = useState(Date.now);
  const [rangeError, setRangeError] = useState<string>();
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [uptime, setUptime] = useState(os?.uptime ?? 0);
  useEffect(() => {
    const started = Date.now();
    setUptime(os?.uptime ?? 0);
    const timer = setInterval(() => {
      setUptime((os?.uptime ?? 0) + (Date.now() - started) / 1000);
    }, 60_000);
    return () => clearInterval(timer);
  }, [os?.uptime]);
  const history = useHistory(socket, { ...window, points: 1200 });
  const overview = useHistory(socket, {
    from: overviewEnd - HISTORY_RETENTION_MS,
    to: overviewEnd,
    points: 500,
  });
  const points = useMemo(
    () => toPlot(history.data?.points ?? []),
    [history.data],
  );
  const overviewPoints = useMemo(
    () => toPlot(overview.data?.points ?? []),
    [overview.data],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setOverviewEnd(Date.now());
    }, 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(
      () =>
        setWindow((previous) => {
          const end = Date.now();
          return { from: end - (previous.to - previous.from), to: end };
        }),
      10_000,
    );
    return () => clearInterval(timer);
  }, [live]);

  const selectWindow = useCallback((selection: Window) => {
    const now = Date.now(),
      duration = Math.min(
        HISTORY_RETENTION_MS,
        Math.max(MIN_WINDOW, selection.to - selection.from),
      );
    const to = Math.min(
      now,
      Math.max(now - HISTORY_RETENTION_MS + duration, selection.to),
    );
    setWindow((previous) =>
      previous.from === to - duration && previous.to === to
        ? previous
        : { from: to - duration, to },
    );
    setLive(false);
    setRangeError(undefined);
  }, []);
  const selectPreset = useCallback((duration: number) => {
    const now = Date.now();
    setWindow({ from: now - duration, to: now });
    setPreset(duration);
    setLive(true);
    setRangeError(undefined);
  }, []);
  const reset = useCallback(() => selectPreset(preset), [preset, selectPreset]);
  const zoom = useCallback(
    (factor: number, anchor?: number) => {
      const duration = window.to - window.from;
      const center = anchor ?? (window.from + window.to) / 2;
      const next = Math.min(
        HISTORY_RETENTION_MS,
        Math.max(MIN_WINDOW, duration * factor),
      );
      const left = (center - window.from) / duration;
      selectWindow({
        from: center - next * left,
        to: center + next * (1 - left),
      });
    },
    [selectWindow, window],
  );
  const move = (direction: number) => {
    const offset = (direction * (window.to - window.from)) / 2;
    selectWindow({ from: window.from + offset, to: window.to + offset });
  };

  const colors = theme.dark
    ? {
        cpu: '#75aaff',
        nvme: '#63db8d',
        down: '#f3d66f',
        up: '#ff9b70',
        ram: '#ff8298',
      }
    : {
        cpu: '#1c56a5',
        nvme: '#087b35',
        down: '#916200',
        up: '#a24706',
        ram: '#b4213c',
      };
  const percent = (value: number) => `${value.toFixed(1)} %`;
  const network = (value: number) =>
    `${value.toFixed(2)} ${config.network_speed_as_bytes ? 'MB/s' : 'Mb/s'}`;
  const renderedPoints = useMemo(
    () =>
      points.map((point) => ({
        ...point,
        cpuTemp:
          point.cpuTemp == null
            ? null
            : config.use_imperial
              ? (point.cpuTemp * 9) / 5 + 32
              : point.cpuTemp,
        nvmeTemp:
          point.nvmeTemp == null
            ? null
            : config.use_imperial
              ? (point.nvmeTemp * 9) / 5 + 32
              : point.nvmeTemp,
        networkUp:
          point.networkUp == null
            ? null
            : (point.networkUp * (config.network_speed_as_bytes ? 1 : 8)) /
              1_000_000,
        networkDown:
          point.networkDown == null
            ? null
            : (point.networkDown * (config.network_speed_as_bytes ? 1 : 8)) /
              1_000_000,
      })),
    [points, config.use_imperial, config.network_speed_as_bytes],
  );
  const temperature = (value: number) =>
    `${value.toFixed(1)} ${config.use_imperial ? '°F' : '°C'}`;
  const plotProps = {
    points: renderedPoints,
    window,
    onWindow: selectWindow,
    onZoom: zoom,
    onReset: reset,
  };
  const indexAt = (time: number) => {
    const index = overviewPoints.findIndex((point) => point.time >= time);
    return index < 0 ? Math.max(0, overviewPoints.length - 1) : index;
  };
  const latestRam = history.data?.points.at(-1);
  const ramLabel =
    latestRam?.ramUsed != null && latestRam.ramTotal
      ? `${(latestRam.ramUsed / 1024 ** 3).toFixed(1)} / ${(latestRam.ramTotal / 1024 ** 3).toFixed(1)} GiB`
      : 'Memory usage';

  return (
    <Dashboard aria-label="Advanced system history">
      <CalendarStyle />
      <SystemHeader>
        <div>
          <Eyebrow>OS</Eyebrow>
          <h1>
            {config.override.os ?? (os ? `${os.distro} ${os.release}` : '—')}
          </h1>
        </div>
        <SystemDetails>
          <div>
            <dt>Architecture</dt>
            <dd>{config.override.arch ?? os?.arch ?? '—'}</dd>
          </div>
          <div>
            <dt>Uptime</dt>
            <dd>
              {os?.uptime
                ? `${Math.floor(uptime / 86_400)}d ${Math.floor((uptime % 86_400) / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
                : '—'}
            </dd>
          </div>
        </SystemDetails>
      </SystemHeader>
      <Toolbar>
        <Controls aria-label="History period">
          {periods.map(([name, duration]) => (
            <Control
              key={name}
              type="button"
              $active={live && preset === duration}
              aria-pressed={live && preset === duration}
              onClick={() => selectPreset(duration)}
            >
              {name}
            </Control>
          ))}
          <Control
            type="button"
            $active={live}
            aria-pressed={live}
            onClick={() => {
              if (live) setLive(false);
              else {
                const now = Date.now();
                setWindow({ from: now - (window.to - window.from), to: now });
                setLive(true);
              }
            }}
          >
            {live ? '● Live' : 'Resume live'}
          </Control>
        </Controls>
        <Controls aria-label="Timeline navigation">
          <Control
            type="button"
            aria-label="Pan earlier"
            onClick={() => move(-1)}
            disabled={window.from <= Date.now() - HISTORY_RETENTION_MS + 1000}
          >
            ←
          </Control>
          <Control
            type="button"
            aria-label="Zoom in"
            onClick={() => zoom(0.5)}
            disabled={window.to - window.from <= MIN_WINDOW}
          >
            +
          </Control>
          <Control
            type="button"
            aria-label="Zoom out"
            onClick={() => zoom(2)}
            disabled={window.to - window.from >= HISTORY_RETENTION_MS}
          >
            −
          </Control>
          <Control
            type="button"
            aria-label="Pan later"
            onClick={() => move(1)}
            disabled={window.to >= Date.now() - 10_000}
          >
            →
          </Control>
          <Control type="button" onClick={reset}>
            Reset zoom
          </Control>
        </Controls>
      </Toolbar>
      <Toolbar>
        <Muted>
          <time dateTime={new Date(window.from).toISOString()}>
            {timeLabel(window.from, true)}
          </time>{' '}
          —{' '}
          <time dateTime={new Date(window.to).toISOString()}>
            {timeLabel(window.to, true)}
          </time>
          {history.loading ? ' · Updating…' : ''}
        </Muted>
      </Toolbar>
      {history.error && (
        <Notice role="alert">
          {history.error}{' '}
          <Control type="button" onClick={history.retry}>
            Retry
          </Control>
        </Notice>
      )}
      {history.data?.warning && (
        <Notice role="status">{history.data.warning}</Notice>
      )}
      {!history.loading && !history.error && !points.length && (
        <Notice role="status">Waiting for readings…</Notice>
      )}
      <Grid>
        <HistoryPlot
          {...plotProps}
          title="Temperatures"
          description="Sensors must be available and temperature monitoring enabled."
          series={[
            { key: 'cpuTemp', name: 'CPU', color: colors.cpu },
            { key: 'nvmeTemp', name: 'NVMe', color: colors.nvme },
          ]}
          unit={config.use_imperial ? '°F' : '°C'}
          format={temperature}
        />
        <HistoryPlot
          {...plotProps}
          title="CPU load"
          description="CPU measurements will appear here."
          series={[{ key: 'cpuLoad', name: 'Average', color: colors.cpu }]}
          unit="%"
          format={percent}
          domain={[0, 100]}
        />
        <HistoryPlot
          {...plotProps}
          title="Network traffic"
          description="Network measurements will appear here."
          series={[
            { key: 'networkDown', name: '↓ Download', color: colors.down },
            { key: 'networkUp', name: '↑ Upload', color: colors.up },
          ]}
          unit=""
          format={network}
        />
        <HistoryPlot
          {...plotProps}
          title="Memory"
          description="Memory measurements will appear here."
          series={[{ key: 'ramPercent', name: ramLabel, color: colors.ram }]}
          unit="%"
          format={percent}
          domain={[0, 100]}
        />
      </Grid>
      <Card aria-label="Recorded history timeline">
        <CardHeader>
          <h2>Timeline</h2>
          <Muted>
            {overview.data?.earliest
              ? `Since ${timeLabel(overview.data.earliest, true)} · 10 s interval`
              : 'Waiting for readings…'}
          </Muted>
        </CardHeader>
        {overviewPoints.length > 1 ? (
          <ResponsiveContainer width="100%" height={100}>
            <ComposedChart
              data={overviewPoints}
              margin={{ top: 0, right: 8, bottom: 0, left: 8 }}
            >
              <Brush
                dataKey="time"
                ariaLabel="History time range"
                height={50}
                travellerWidth={12}
                stroke={colors.cpu}
                fill={theme.colors.surface}
                tickFormatter={(value: number) => timeLabel(value, true)}
                startIndex={indexAt(window.from)}
                endIndex={Math.max(indexAt(window.from), indexAt(window.to))}
                onDragEnd={({ startIndex, endIndex }) => {
                  const start = overviewPoints[startIndex ?? 0],
                    end = overviewPoints[endIndex ?? overviewPoints.length - 1];
                  if (start && end && end.time - start.time >= MIN_WINDOW)
                    selectWindow({ from: start.time, to: end.time });
                }}
              >
                <ComposedChart>
                  <Area
                    dataKey="cpuLoad"
                    stroke={colors.cpu}
                    fill={colors.cpu}
                    fillOpacity={0.16}
                    isAnimationActive={false}
                  />
                </ComposedChart>
              </Brush>
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <Muted>No history yet.</Muted>
        )}
        <ConfigProvider
          theme={{
            algorithm: theme.dark
              ? antdTheme.darkAlgorithm
              : antdTheme.defaultAlgorithm,
            token: {
              colorPrimary: colors.cpu,
              colorBgContainer: theme.colors.surface,
              colorBgElevated: theme.colors.surface,
              colorText: theme.colors.text,
              borderRadius: 12,
              controlHeight: 46,
            },
            components: {
              DatePicker: {
                cellWidth: 36,
                cellHeight: 32,
                timeCellHeight: 32,
                timeColumnWidth: 56,
              },
            },
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const fields = new FormData(event.currentTarget);
              const from = parseRangeDate(fields.get('from')),
                to = parseRangeDate(fields.get('to')),
                now = Date.now();
              if (
                !Number.isFinite(from) ||
                !Number.isFinite(to) ||
                to - from < MIN_WINDOW ||
                from < now - HISTORY_RETENTION_MS - 60_000 ||
                to > now
              ) {
                setRangeError(
                  'Choose at least 1 minute within the last 24 hours.',
                );
                return;
              }
              selectWindow({ from, to });
            }}
          >
            <RangeFields>
              <DateField htmlFor="history-from">
                <span>From</span>
                <RangeInput
                  id="history-from"
                  name="from"
                  aria-label="Range start"
                  format="DD.MM.YYYY HH:mm"
                  showTime={{ format: 'HH:mm', use12Hours: false }}
                  classNames={{ popup: { root: 'history-date-popup' } }}
                  allowClear={false}
                  minDate={dayjs(Date.now() - HISTORY_RETENTION_MS)}
                  maxDate={dayjs()}
                  value={dayjs(customFrom || localInput(window.from))}
                  onChange={(value) =>
                    setCustomFrom(value ? localInput(value.valueOf()) : '')
                  }
                />
              </DateField>
              <DateField htmlFor="history-to">
                <span>To</span>
                <RangeInput
                  id="history-to"
                  name="to"
                  aria-label="Range end"
                  format="DD.MM.YYYY HH:mm"
                  showTime={{ format: 'HH:mm', use12Hours: false }}
                  classNames={{ popup: { root: 'history-date-popup' } }}
                  allowClear={false}
                  minDate={dayjs(Date.now() - HISTORY_RETENTION_MS)}
                  maxDate={dayjs()}
                  value={dayjs(customTo || localInput(window.to))}
                  onChange={(value) =>
                    setCustomTo(value ? localInput(value.valueOf()) : '')
                  }
                />
              </DateField>
              <Control type="submit">Apply range</Control>
            </RangeFields>
            {rangeError && <p role="alert">{rangeError}</p>}
          </form>
        </ConfigProvider>
      </Card>
    </Dashboard>
  );
};
