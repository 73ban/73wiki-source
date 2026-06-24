export function isNoisyText(value) {
  const text = String(value ?? "").trim()
  if (!text) return true
  const compact = text.replace(/\s+/g, "")
  if (/^\?{3,}$/.test(compact)) return true
  const questionCount = (compact.match(/\?/g) ?? []).length
  if (questionCount >= 4 && questionCount / Math.max(1, compact.length) > 0.35) return true
  if (/�/.test(compact)) return true
  return false
}

export function sanitizeText(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  return isNoisyText(text) ? "" : text
}

export function sanitizeList(values, limit = 20) {
  return [...new Set((values ?? []).map(sanitizeText).filter(Boolean))].slice(0, Number(limit))
}

export function sampleQuality(sample) {
  const raw = JSON.stringify(sample ?? {})
  const noisy = isNoisyText(raw)
  const hasInstruction = Boolean(sanitizeText(sample?.instruction))
  const hasInput = sample?.input && Object.keys(sample.input).length > 0
  const hasOutput = sample?.output && Object.keys(sample.output).length > 0
  const result = sanitizeText(sample?.label?.result ?? sample?.label?.playbook ?? sample?.label)
  const ok = !noisy && hasInstruction && hasInput && hasOutput && Boolean(result) && result !== "pending"
  return {
    ok,
    noisy,
    hasInstruction,
    hasInput,
    hasOutput,
    result: result || null,
  }
}
