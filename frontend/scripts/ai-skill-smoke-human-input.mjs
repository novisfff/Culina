function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('zh-CN');
}

export function chooseHumanInputOption(options, hints) {
  const normalizedOptions = options.map((option, index) => ({
    index,
    text: String(option ?? '').replace(/\s+/g, ' ').trim(),
    normalized: normalizeText(option),
  }));
  const normalizedHints = hints.map(normalizeText).filter(Boolean);

  for (const hint of normalizedHints) {
    const matches = normalizedOptions.filter((option) => option.normalized.includes(hint));
    if (matches.length === 1) return matches[0];
  }

  const available = normalizedOptions.map((option) => `${option.index + 1}. ${option.text}`).join(' | ');
  throw new Error(
    `无法唯一匹配人工确认选项；hints=${normalizedHints.join(', ') || '-'}；options=${available || '-'}`
  );
}

