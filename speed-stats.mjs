// 纯函数：速度样本的区间并集与稳健统计。
// 不读取文件、不依赖运行时状态，便于用 node:test 覆盖边界。

export const SPEED_SAMPLE_WINDOW = 5;
export const SPEED_ANALYSIS_WINDOW = 8;
export const SPEED_MIN_OUTPUT = 16;
export const SPEED_MIN_GENERATION_MS = 500;
export const SPEED_MIN_SAMPLES = 3;

export function unionDurationMs(intervals) {
  const valid = (intervals || [])
    .map((item) => (Array.isArray(item) ? item : [item && item.start, item && item.end]))
    .map(([start, end]) => [Number(start), Number(end)])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (!valid.length) return 0;
  let total = 0;
  let currentStart = valid[0][0];
  let currentEnd = valid[0][1];
  for (let index = 1; index < valid.length; index += 1) {
    const [start, end] = valid[index];
    if (start <= currentEnd) {
      if (end > currentEnd) currentEnd = end;
      continue;
    }
    total += currentEnd - currentStart;
    currentStart = start;
    currentEnd = end;
  }
  total += currentEnd - currentStart;
  return total;
}

export function median(values) {
  const sorted = (values || [])
    .map(Number)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function medianAbsoluteDeviation(values, center = median(values)) {
  if (!Number.isFinite(center)) return null;
  return median((values || []).map((value) => Math.abs(Number(value) - center)));
}

function normalizeSample(sample, options) {
  if (!sample || typeof sample !== "object") return null;
  const output = Number(sample.output);
  const genMs = Number(sample.genMs);
  const speed = output > 0 && genMs > 0 ? output / (genMs / 1000) : Number(sample.speed);
  if (!Number.isFinite(speed) || speed <= 0) return null;
  if (output < options.minOutput || genMs < options.minGenerationMs) return null;
  return {
    speed,
    output,
    genMs,
    model: sample.model == null ? null : String(sample.model),
    timingSource: sample.timingSource == null ? "record" : String(sample.timingSource),
  };
}

// 单个异常样本不主导显示；最近连续同向的高速/低速样本允许建立新置信区间。
export function robustSpeedSummary(
  samples,
  {
    window = SPEED_SAMPLE_WINDOW,
    analysisWindow = SPEED_ANALYSIS_WINDOW,
    minOutput = SPEED_MIN_OUTPUT,
    minGenerationMs = SPEED_MIN_GENERATION_MS,
    minSamples = SPEED_MIN_SAMPLES,
  } = {},
) {
  const options = { minOutput, minGenerationMs };
  const valid = (samples || []).map((sample) => normalizeSample(sample, options)).filter(Boolean);
  if (!valid.length) {
    return {
      tps: null,
      sampleCount: 0,
      rawSampleCount: 0,
      window,
      confidence: "low",
      medianTps: null,
      madTps: null,
      outlierCount: 0,
    };
  }

  const recent = valid.slice(-Math.max(window, analysisWindow));
  const speeds = recent.map((sample) => sample.speed);
  const center = median(speeds);
  const mad = medianAbsoluteDeviation(speeds, center);
  const threshold = Math.max(1, Number.isFinite(center) ? center * 0.75 : 1, Number.isFinite(mad) ? mad * 6 : 0);

  let accepted = recent;
  if (speeds.length >= 5) {
    const filtered = recent.filter((sample) => Math.abs(sample.speed - center) <= threshold);
    if (filtered.length >= minSamples) accepted = filtered;
  }

  // 连续 3 个窄分布、同方向的高速样本：允许接受为新速度区间，
  // 防止模型切换或服务端提速后被历史中位数永久压制。
  const lastThree = recent.slice(-3);
  if (lastThree.length === 3) {
    const threeSpeeds = lastThree.map((sample) => sample.speed);
    const threeMedian = median(threeSpeeds);
    const spread = Math.max(...threeSpeeds) - Math.min(...threeSpeeds);
    const compactSpread = Number.isFinite(threeMedian) && spread <= Math.max(1, threeMedian * 0.35);
    const previousSpeeds = recent.slice(0, -3).map((sample) => sample.speed);
    const previousMedian = median(previousSpeeds);
    const shifted =
      Number.isFinite(previousMedian) &&
      previousSpeeds.length >= 3 &&
      (threeMedian >= previousMedian * 2 || threeMedian <= previousMedian / 2);
    if (compactSpread && shifted) accepted = lastThree;
  }

  const display = accepted.slice(-window);
  const displaySpeeds = display.map((sample) => sample.speed);
  const sampleCount = display.length;
  const tps = sampleCount >= minSamples ? median(displaySpeeds) : null;
  const timingSource = display.some((sample) => sample.timingSource === "item") ? "item" : "record";
  const confidence =
    sampleCount >= 5 && timingSource === "item" ? "high" : sampleCount >= minSamples ? "medium" : "low";

  return {
    tps,
    sampleCount,
    rawSampleCount: valid.length,
    window,
    confidence,
    medianTps: center,
    madTps: mad,
    outlierCount: Math.max(0, recent.length - accepted.length),
  };
}
